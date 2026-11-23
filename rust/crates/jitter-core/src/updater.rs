//! 自动升级：GitHub Releases 检查 / 下载 / 解压 / 自替换。
//!
//! 与 TypeScript 版 `src/updater.ts` 行为对齐。Windows 上运行中的 exe 无法
//! 直接覆盖，由一个「等本进程退出后再搬文件并重启」的辅助 cmd 脚本完成。

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;

use crate::system;

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
async fn get_with_proxy_fallback(url: &str, timeout: Duration, accept: &str) -> Result<reqwest::Response, String> {
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
    let mut asset: Option<UpdateAsset> = None;
    if let Some(assets) = release.get("assets").and_then(|value| value.as_array()) {
        for entry in assets {
            if entry.get("name").and_then(|value| value.as_str()) == Some(wanted.as_str()) {
                asset = Some(UpdateAsset {
                    name: wanted.clone(),
                    url: entry
                        .get("browser_download_url")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    size: entry.get("size").and_then(|value| value.as_u64()).unwrap_or(0),
                });
                break;
            }
        }
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

/// 下载资产并解压出新二进制文件，返回其路径。
async fn download_and_extract(asset: &UpdateAsset) -> Result<PathBuf, String> {
    let work_dir = temp_work_dir();
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;

    set_progress("downloading", 0, "正在下载新版本…");
    let response = get_with_proxy_fallback(&asset.url, Duration::from_secs(10 * 60), "").await?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status().as_u16()));
    }
    let total = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        bytes.extend_from_slice(&chunk);
        if total > 0 {
            let percent = ((bytes.len() as f64 / total as f64) * 100.0).floor().min(99.0) as u32;
            set_progress("downloading", percent, &format!("正在下载新版本… {percent}%"));
        }
    }
    let zip_path = work_dir.join(&asset.name);
    fs::write(&zip_path, &bytes).map_err(|error| error.to_string())?;

    set_progress("extracting", 99, "正在解压…");
    let wanted = if std::env::consts::OS == "windows" { "jitter.exe" } else { "jitter" };
    let mut archive =
        zip::ZipArchive::new(fs::File::open(&zip_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().to_string();
        if !name.ends_with(wanted) {
            continue;
        }
        let target = work_dir.join(wanted);
        let mut content: Vec<u8> = Vec::new();
        entry.read_to_end(&mut content).map_err(|error| error.to_string())?;
        fs::write(&target, &content).map_err(|error| error.to_string())?;
        return Ok(target);
    }
    Err(format!("压缩包里没有找到 {wanted}"))
}

/// 替换正在运行的二进制并启动新版本。
fn install(new_binary: &std::path::Path) -> Result<(), String> {
    let current = system::get_binary_path().ok_or_else(|| "当前不是安装版本，无法自动升级".to_string())?;

    set_progress("installing", 100, "正在替换程序文件…");

    // Windows 允许给运行中的 exe 改名（但不允许覆盖/删除）：
    // 旧程序改名 .old → 新文件就位 → 直接拉起新进程。
    // 全程不需要 cmd 辅助脚本（不会弹控制台窗口），失败可回滚。
    let backup = PathBuf::from(format!("{}.old", current.to_string_lossy()));
    let _ = fs::remove_file(&backup); // 上次升级的残留；被锁住就忽略
    fs::rename(&current, &backup).map_err(|error| format!("无法重命名当前程序（可能被占用）：{error}"))?;
    if let Err(error) = fs::copy(new_binary, &current) {
        // 回滚：把旧程序改回去，让当前进程继续可用。
        let _ = fs::rename(&backup, &current);
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
