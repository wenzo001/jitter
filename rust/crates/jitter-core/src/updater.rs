//! 自动升级：GitHub Releases 检查 / 下载 / 校验 / 解压 / 自替换。
//!
//! 与 TypeScript 版 `src/updater.ts` 行为对齐。Windows 上运行中的 exe 无法
//! 直接覆盖，由一个「等本进程退出后再搬文件并重启」的辅助 cmd 脚本完成。
//!
//! 下载安全约束（本模块的责任边界）：
//! - 下载是流式写盘且有大小上限（`DEFAULT_MAX_DOWNLOAD_BYTES`），不再整包
//!   buffer 成无界 `Vec`。
//! - 必须消费并校验发布产物的 `<asset>.sha256`；校验失败不解压、不安装。
//! - zip 成员必须**精确匹配**目标架构所需文件名（`jitter.exe` / `jitter`），
//!   不做 suffix 匹配；嵌套同名、多匹配一律拒绝。

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::system;

/// 更新包（zip）允许的最大字节数。可被注入更小值用于测试。
pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

pub fn update_repo() -> String {
    std::env::var("JITTER_UPDATE_REPO")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "wenzo001/jitter".to_string())
}

fn api_base() -> String {
    format!("https://api.github.com/repos/{}", update_repo())
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// 发布产物里 `<name>.sha256` 的下载地址；缺失则拒绝自动升级。
    pub sha256_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: Option<String>,
    pub available: bool,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub published_at: Option<String>,
    pub asset: Option<UpdateAsset>,
    pub error: Option<String>,
}

/// 与当前平台匹配的资产名，如 jitter-windows-x64.zip。
pub fn asset_name() -> String {
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    };
    format!("jitter-{platform}-{arch}.zip")
}

/// 比较两个版本号（"1.2.3" / "v1.2.3"）；遵循 semver 的预发布语义。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    struct Parsed {
        parts: Vec<i64>,
        prerelease: String,
    }
    fn parse(value: &str) -> Parsed {
        let cleaned = value.trim().trim_start_matches(['v', 'V']);
        let (core, prerelease) = match cleaned.find('-') {
            Some(index) => (&cleaned[..index], cleaned[index + 1..].to_string()),
            None => (cleaned, String::new()),
        };
        let parts = core
            .split('.')
            .map(|part| part.parse::<i64>().unwrap_or(0))
            .collect();
        Parsed { parts, prerelease }
    }

    let left = parse(a);
    let right = parse(b);
    let length = left.parts.len().max(right.parts.len());
    for index in 0..length {
        let l = left.parts.get(index).copied().unwrap_or(0);
        let r = right.parts.get(index).copied().unwrap_or(0);
        if l != r {
            return if l > r { 1 } else { -1 };
        }
    }
    if left.prerelease == right.prerelease {
        return 0;
    }
    // 正式版比同版本的任何预发布版都新。
    if left.prerelease.is_empty() {
        return 1;
    }
    if right.prerelease.is_empty() {
        return -1;
    }
    if left.prerelease > right.prerelease {
        1
    } else {
        -1
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())
}

fn direct_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

/// Windows 系统代理（注册表里的 Internet Settings，Clash 一类工具会写这里）。
#[cfg(windows)]
fn windows_system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let server: String = settings.get_value("ProxyServer").ok()?;
    if server.trim().is_empty() {
        return None;
    }
    // 形如 "127.0.0.1:7897" 或 "http=...;https=..."。
    if server.contains('=') {
        for part in server.split(';') {
            if let Some(value) = part.strip_prefix("https=") {
                if !value.trim().is_empty() {
                    return Some(format!("http://{value}"));
                }
            }
        }
        return None;
    }
    Some(format!("http://{server}"))
}

/// 环境代理失败时依次回退：Windows 系统代理 → 直连（对齐 TS 版 withProxyFallback）。
/// 升级检查与节假日数据拉取共用这条链路。
pub async fn get_with_proxy_fallback(url: &str, timeout: Duration, accept: &str) -> Result<reqwest::Response, String> {
    let send = |client: Result<reqwest::Client, String>| async move {
        let client = client?;
        let mut request = client.get(url).header("User-Agent", "Jitter");
        if !accept.is_empty() {
            request = request.header("Accept", accept);
        }
        request.send().await.map_err(|error| error.to_string())
    };
    let mut errors: Vec<String> = Vec::new();

    match send(client(timeout)).await {
        Ok(response) => return Ok(response),
        Err(error) => errors.push(format!("环境代理: {error}")),
    }

    #[cfg(windows)]
    if let Some(proxy_url) = windows_system_proxy() {
        let registry_client = reqwest::Proxy::all(&proxy_url).map_err(|error| error.to_string()).and_then(|proxy| {
            reqwest::Client::builder()
                .timeout(timeout)
                .proxy(proxy)
                .build()
                .map_err(|error| error.to_string())
        });
        match send(registry_client).await {
            Ok(response) => return Ok(response),
            Err(error) => errors.push(format!("系统代理 {proxy_url}: {error}")),
        }
    }

    match send(direct_client(timeout)).await {
        Ok(response) => Ok(response),
        Err(error) => {
            errors.push(format!("直连: {error}"));
            Err(errors.join("；"))
        }
    }
}

/// 问 GitHub 要最新 Release 并与运行中的版本比较。
pub async fn check_for_update() -> UpdateInfo {
    let current = system::app_version().to_string();
    let base = UpdateInfo {
        current: current.clone(),
        latest: None,
        available: false,
        notes: None,
        url: None,
        published_at: None,
        asset: None,
        error: None,
    };

    let response = match get_with_proxy_fallback(
        &format!("{}/releases/latest", api_base()),
        Duration::from_secs(15),
        "application/vnd.github+json",
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return UpdateInfo { error: Some(error), ..base },
    };
    if response.status().as_u16() == 404 {
        // 仓库还没有任何 Release —— 这不是错误。
        return base;
    }
    if !response.status().is_success() {
        return UpdateInfo {
            error: Some(format!("GitHub 返回 {}", response.status().as_u16())),
            ..base
        };
    }
    let Ok(release) = response.json::<serde_json::Value>().await else {
        return UpdateInfo { error: Some("GitHub 返回的不是合法 JSON".into()), ..base };
    };

    let tag = release.get("tag_name").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    if tag.is_empty() {
        return base;
    }
    let wanted = asset_name();
    let sha_wanted = format!("{wanted}.sha256");
    let mut asset: Option<UpdateAsset> = None;
    let mut sha256_url: Option<String> = None;
    if let Some(assets) = release.get("assets").and_then(|value| value.as_array()) {
        for entry in assets {
            let entry_name = entry.get("name").and_then(|value| value.as_str()).unwrap_or_default();
            let download_url = entry
                .get("browser_download_url")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if entry_name == wanted {
                asset = Some(UpdateAsset {
                    name: wanted.clone(),
                    url: download_url,
                    size: entry.get("size").and_then(|value| value.as_u64()).unwrap_or(0),
                    sha256_url: None,
                });
            } else if entry_name == sha_wanted && !download_url.is_empty() {
                sha256_url = Some(download_url);
            }
        }
    }
    if let (Some(asset), Some(sha)) = (asset.as_mut(), sha256_url) {
        asset.sha256_url = Some(sha);
    }
    let available = compare_versions(&tag, &current) > 0 && asset.is_some();
    UpdateInfo {
        error: if asset.is_none() {
            Some(format!("该版本没有提供 {wanted}（当前平台 {}/{})", system::platform(), system::arch()))
        } else {
            None
        },
        current,
        latest: Some(tag),
        available,
        notes: release.get("body").and_then(|value| value.as_str()).map(str::to_string),
        url: release.get("html_url").and_then(|value| value.as_str()).map(str::to_string),
        published_at: release.get("published_at").and_then(|value| value.as_str()).map(str::to_string),
        asset,
    }
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub phase: String,
    pub percent: u32,
    pub message: String,
    pub error: Option<String>,
}

impl Default for UpdateProgress {
    fn default() -> Self {
        UpdateProgress { phase: "idle".into(), percent: 0, message: String::new(), error: None }
    }
}

fn progress_slot() -> &'static Mutex<UpdateProgress> {
    static PROGRESS: OnceLock<Mutex<UpdateProgress>> = OnceLock::new();
    PROGRESS.get_or_init(|| Mutex::new(UpdateProgress::default()))
}

pub fn get_update_progress() -> UpdateProgress {
    progress_slot().lock().map(|guard| guard.clone()).unwrap_or_default()
}

fn set_progress(phase: &str, percent: u32, message: &str) {
    if let Ok(mut guard) = progress_slot().lock() {
        *guard = UpdateProgress {
            phase: phase.to_string(),
            percent,
            message: message.to_string(),
            error: None,
        };
    }
}

fn set_progress_error(message: &str) {
    if let Ok(mut guard) = progress_slot().lock() {
        *guard = UpdateProgress {
            phase: "error".into(),
            percent: 0,
            message: String::new(),
            error: Some(message.to_string()),
        };
    }
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

fn temp_work_dir() -> PathBuf {
    std::env::temp_dir().join(format!("jitter-update-{}", crate::executor::now_ms()))
}

// ---------------------------------------------------------------------------
// SHA-256（纯 Rust 实现，避免为此新增第三方依赖）
// ---------------------------------------------------------------------------

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

#[derive(Clone, Copy)]
struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    total_bytes: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0u8; 64],
            buffered: 0,
            total_bytes: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_bytes = self.total_bytes.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            self.compress(block.try_into().expect("block of 64 bytes"));
            data = rest;
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffered = data.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let total_bits = self.total_bytes.wrapping_mul(8).to_be_bytes();
        self.buffer[self.buffered] = 0x80;
        self.buffered += 1;
        self.buffer[self.buffered..].fill(0);
        if self.buffered > 56 {
            let block = self.buffer;
            self.compress(&block);
            self.buffer = [0u8; 64];
        }
        self.buffer[56..64].copy_from_slice(&total_bits);
        let block = self.buffer;
        self.compress(&block);
        let mut out = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            w[index] = u32::from_be_bytes(chunk.try_into().expect("4 bytes"));
        }
        for index in 16..64 {
            let s0 = {
                let x = w[index - 15];
                x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)
            };
            let s1 = {
                let x = w[index - 2];
                x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10)
            };
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 计算字节的 SHA-256 十六进制摘要（小写）。
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    to_hex(&hasher.finalize())
}

/// 流式计算文件的 SHA-256（分块读，不把整包读进内存）。
pub fn sha256_hex_file(path: &Path) -> Result<String, String> {
    use std::io::BufRead;
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    loop {
        let filled = match reader.fill_buf() {
            Ok(filled) => filled,
            Err(error) => return Err(error.to_string()),
        };
        if filled.is_empty() {
            break;
        }
        let taken = filled.len();
        hasher.update(&filled[..taken]);
        reader.consume(taken);
    }
    Ok(to_hex(&hasher.finalize()))
}

/// 解析发布产物 `<asset>.sha256` 的内容：`"<hex>  <file>\n"`。
/// 只接受第一个空白分隔 token 恰好是 64 位十六进制的情况。
pub fn parse_sha256_asset(content: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(content).ok()?;
    let token = text.split_whitespace().next()?;
    if token.len() != 64 || !token.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(token.to_ascii_lowercase())
}

// ---------------------------------------------------------------------------
// 下载 / 校验 / 解压
// ---------------------------------------------------------------------------

/// 有上限的流式落盘：Content-Length 超限直接拒绝；无长度头则边写边计数，
/// 超限立即中止并删除半截文件。绝不整包 buffer 进内存。
pub async fn stream_response_to_file(
    mut response: reqwest::Response,
    dest: &Path,
    max_bytes: u64,
) -> Result<(), String> {
    let total = response.content_length();
    if let Some(total) = total {
        if total > max_bytes {
            return Err(format!("更新包过大：{total} 字节，超过上限 {max_bytes} 字节"));
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    fn abort(dest: &Path, message: String) -> String {
        let _ = fs::remove_file(dest);
        message
    }

    let mut file = match fs::File::create(dest) {
        Ok(file) => file,
        Err(error) => return Err(error.to_string()),
    };
    let mut written: u64 = 0;
    let mut last_percent = u32::MAX;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                drop(file);
                return Err(abort(dest, error.to_string()));
            }
        };
        written += chunk.len() as u64;
        if written > max_bytes {
            drop(file);
            return Err(abort(
                dest,
                format!("更新包过大：下载流超过上限 {max_bytes} 字节"),
            ));
        }
        if let Err(error) = file.write_all(&chunk) {
            drop(file);
            return Err(abort(dest, error.to_string()));
        }
        if let Some(total) = total {
            if total > 0 {
                let percent = ((written as f64 / total as f64) * 100.0).floor().min(99.0) as u32;
                if percent != last_percent {
                    last_percent = percent;
                    set_progress("downloading", percent, &format!("正在下载新版本… {percent}%"));
                }
            }
        }
    }
    if let Err(error) = file.flush() {
        drop(file);
        return Err(abort(dest, error.to_string()));
    }
    drop(file);
    Ok(())
}

/// 目标平台上更新包里应有的二进制文件名。
pub fn wanted_binary_name() -> &'static str {
    if std::env::consts::OS == "windows" {
        "jitter.exe"
    } else {
        "jitter"
    }
}

/// 从 zip 中解压目标二进制。成员名必须**精确等于** `wanted`：
/// - suffix 匹配（`eviljitter.exe`）、嵌套同名（`pkg/jitter.exe`）、
///   错误架构文件名、多个同名成员，一律拒绝。
pub fn extract_binary_from_zip(zip_path: &Path, work_dir: &Path, wanted: &str) -> Result<PathBuf, String> {
    // 解压出的可执行文件尺寸 sanity 上限。
    const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
    if wanted.is_empty() || wanted.contains('/') || wanted.contains('\\') || wanted.contains("..") {
        return Err(format!("非法的目标文件名: {wanted}"));
    }
    let file = fs::File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;

    let mut found: Vec<usize> = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_file() && entry.name() == wanted {
            if entry.size() > MAX_BINARY_BYTES {
                return Err(format!("压缩包里的 {wanted} 尺寸异常: {} 字节", entry.size()));
            }
            found.push(index);
        }
    }
    match found.len() {
        0 => return Err(format!("压缩包里没有找到 {wanted}（当前平台所需的精确文件名）")),
        1 => {}
        count => return Err(format!("压缩包里存在 {count} 个 {wanted}，无法确定目标，拒绝解压")),
    }

    let entry = archive.by_index(found[0]).map_err(|error| error.to_string())?;
    let target = work_dir.join(wanted);
    let mut out = match fs::File::create(&target) {
        Ok(out) => out,
        Err(error) => return Err(error.to_string()),
    };
    let copied = match std::io::copy(&mut entry.take(MAX_BINARY_BYTES + 1), &mut out) {
        Ok(copied) => copied,
        Err(error) => {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(error.to_string());
        }
    };
    drop(out);
    if copied > MAX_BINARY_BYTES {
        let _ = fs::remove_file(&target);
        return Err(format!(
            "压缩包里的 {wanted} 解压后超过大小上限: {MAX_BINARY_BYTES} 字节"
        ));
    }
    Ok(target)
}

async fn fetch_response(url: &str, timeout: Duration, proxy_fallback: bool) -> Result<reqwest::Response, String> {
    if proxy_fallback {
        return get_with_proxy_fallback(url, timeout, "").await;
    }
    let client = direct_client(timeout)?;
    client
        .get(url)
        .header("User-Agent", "Jitter")
        .send()
        .await
        .map_err(|error| error.to_string())
}

/// 下载并验证一个更新包，返回解压出的新二进制路径。
///
/// 顺序：取 `.sha256` → 流式限长下载 zip → SHA-256 校验 → 精确名解压。
/// 校验失败 / 超限 / 成员名不符：报错并清理，绝不进入解压或安装。
///
/// `proxy_fallback`：生产走 true（沿用代理回退链）；本地测试走 false
/// （直连 fixture，不受环境/系统代理影响）。
#[allow(clippy::too_many_arguments)]
pub async fn fetch_update_package(
    zip_url: &str,
    sha256_url: Option<&str>,
    work_dir: &Path,
    zip_name: &str,
    wanted_binary: &str,
    max_bytes: u64,
    proxy_fallback: bool,
) -> Result<PathBuf, String> {
    let sha_url = match sha256_url {
        Some(value) if !value.is_empty() => value,
        _ => return Err("发布缺少 .sha256 校验文件，为安全起见拒绝自动升级".to_string()),
    };
    fs::create_dir_all(work_dir).map_err(|error| error.to_string())?;

    set_progress("downloading", 0, "正在下载校验文件…");
    let mut sha_response = fetch_response(sha_url, Duration::from_secs(30), proxy_fallback).await?;
    if !sha_response.status().is_success() {
        return Err(format!("下载校验文件失败：HTTP {}", sha_response.status().as_u16()));
    }
    // 校验文件本身也限长，防被塞垃圾。
    const MAX_SHA256_ASSET_BYTES: usize = 256;
    let mut sha_bytes = Vec::with_capacity(MAX_SHA256_ASSET_BYTES + 1);
    while let Some(chunk) = sha_response
        .chunk()
        .await
        .map_err(|error| error.to_string())?
    {
        if chunk.len() > MAX_SHA256_ASSET_BYTES - sha_bytes.len() {
            return Err("校验文件内容异常（超过 256 字节）".to_string());
        }
        sha_bytes.extend_from_slice(&chunk);
    }
    if sha_bytes.is_empty() {
        return Err("校验文件为空".to_string());
    }
    let expected = parse_sha256_asset(&sha_bytes)
        .ok_or_else(|| "校验文件不是合法的 SHA-256 摘要".to_string())?;

    set_progress("downloading", 0, "正在下载新版本…");
    let zip_path = work_dir.join(zip_name);
    let response = fetch_response(zip_url, Duration::from_secs(10 * 60), proxy_fallback).await?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status().as_u16()));
    }
    stream_response_to_file(response, &zip_path, max_bytes).await?;

    set_progress("verifying", 98, "正在校验 SHA-256…");
    let actual = sha256_hex_file(&zip_path)?;
    if actual != expected {
        let _ = fs::remove_file(&zip_path);
        return Err(format!(
            "SHA-256 校验失败，更新包可能已被篡改（期望 {expected}，实际 {actual}）"
        ));
    }

    set_progress("extracting", 99, "正在解压…");
    extract_binary_from_zip(&zip_path, work_dir, wanted_binary)
}

/// 下载资产并解压出新二进制文件，返回其路径。
async fn download_and_extract(asset: &UpdateAsset) -> Result<PathBuf, String> {
    let work_dir = temp_work_dir();
    fetch_update_package(
        &asset.url,
        asset.sha256_url.as_deref(),
        &work_dir,
        &asset.name,
        wanted_binary_name(),
        DEFAULT_MAX_DOWNLOAD_BYTES,
        true,
    )
    .await
}

/// 替换正在运行的二进制并启动新版本。
fn install(new_binary: &std::path::Path) -> Result<(), String> {
    let current = system::get_binary_path().ok_or_else(|| "当前不是安装版本，无法自动升级".to_string())?;

    set_progress("installing", 100, "正在替换程序文件…");

    // Windows 允许给运行中的 exe 改名（但不允许覆盖/删除）：
    // 先把新文件完整拷到同目录的 .new，再用两次 rename 完成交换。
    // 不能「先改名旧文件再拷贝新文件」——中途崩溃/断电会留下
    // 程序文件缺失，下次开机自启就会弹「Windows 找不到文件」。
    let staged = PathBuf::from(format!("{}.new", current.to_string_lossy()));
    if let Err(error) = fs::copy(new_binary, &staged) {
        let _ = fs::remove_file(&staged);
        return Err(format!("准备新程序文件失败：{error}"));
    }
    let backup = PathBuf::from(format!("{}.old", current.to_string_lossy()));
    let _ = fs::remove_file(&backup); // 上次升级的残留；被锁住就忽略
    fs::rename(&current, &backup).map_err(|error| format!("无法重命名当前程序（可能被占用）：{error}"))?;
    if let Err(error) = fs::rename(&staged, &current) {
        // 回滚：把旧程序改回去，让当前进程继续可用。
        let _ = fs::rename(&backup, &current);
        let _ = fs::remove_file(&staged);
        return Err(format!("替换程序文件失败：{error}"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&current, fs::Permissions::from_mode(0o755));
    }

    if std::env::consts::OS == "macos" {
        // 下载来的二进制带隔离属性且签名失效，清掉两者否则 macOS 拒绝运行。
        let _ = Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&current).status();
        let _ = Command::new("xattr").args(["-c"]).arg(&current).status();
        let _ = Command::new("codesign").args(["--force", "--sign", "-"]).arg(&current).status();
    }

    spawn_successor(&current)
}

/// 拉起新版本：带 1.5 秒启动延迟，等旧进程退出、释放端口和单实例锁。
fn spawn_successor(exe: &std::path::Path) -> Result<(), String> {
    let mut command = Command::new(exe);
    command
        .env("JITTER_STARTUP_DELAY_MS", "1500")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    spawn_detached(command)
}

/// 启动一个比本进程活得久的进程。
fn spawn_detached(mut command: Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS：脱离控制台。
        command.creation_flags(0x0000_0008);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// 下载并安装最新 Release；调用方在返回成功后让本进程退出。
pub async fn apply_update(info: &UpdateInfo) -> (bool, String) {
    if info.asset.is_none() {
        return (false, info.error.clone().unwrap_or_else(|| "没有可用的更新包".to_string()));
    }
    if !info.available {
        return (false, "当前已经是最新版本".to_string());
    }
    let result = match download_and_extract(info.asset.as_ref().unwrap()).await {
        Ok(new_binary) => install(&new_binary),
        Err(message) => Err(message),
    };
    match result {
        Ok(()) => {
            set_progress("done", 100, "升级完成，正在重启…");
            (true, "升级完成，正在重启…".to_string())
        }
        Err(message) => {
            set_progress_error(&message);
            (false, message)
        }
    }
}

/// 测试辅助：下载的更新会落在的目录。
pub fn get_update_work_dir() -> PathBuf {
    std::env::temp_dir().join("jitter-update")
}
