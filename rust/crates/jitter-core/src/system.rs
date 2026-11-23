//! 系统信息与开机自启：与 TypeScript 版 `src/system.ts` 行为对齐。
//!
//! 自启是三平台的纯文件写（Startup 目录 .cmd / LaunchAgents plist /
//! autostart .desktop），不碰注册表、不调 shell。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const APP_NAME: &str = "Jitter";

/// 自启注册项的固定 id。
const AUTOSTART_ID: &str = "jitter";

pub fn app_version() -> &'static str {
    crate::VERSION
}

/// 平台名（与 TS 版 `process.platform` 一致：win32 / darwin / 其它）。
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        _ => "linux",
    }
}

/// 架构名（x64 / arm64，与 TS 版 `process.arch` 一致）。
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

fn home_dir() -> PathBuf {
    if std::env::consts::OS == "windows" {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.trim().is_empty() {
                return PathBuf::from(profile);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(".")
}

fn env_or(env_key: &str, fallback: PathBuf) -> PathBuf {
    match std::env::var(env_key) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => fallback,
    }
}

/// 安装后的可执行文件位置（本机运行的原生二进制总是能拿到）。
pub fn get_binary_path() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// 配置文件 / 数据库所在目录。
pub fn get_config_dir() -> PathBuf {
    match std::env::consts::OS {
        "windows" => env_or("APPDATA", home_dir().join("AppData").join("Roaming")).join(APP_NAME),
        "macos" => home_dir().join("Library").join("Application Support").join(APP_NAME),
        _ => env_or("XDG_CONFIG_HOME", home_dir().join(".config")).join("jitter"),
    }
}

/// 用户数据目录（与配置目录同构，仅为对齐 TS 版 SystemInfo 的语义）。
pub fn get_user_data_dir() -> PathBuf {
    match std::env::consts::OS {
        "windows" => env_or("LOCALAPPDATA", home_dir().join("AppData").join("Local")).join(APP_NAME),
        "macos" => home_dir().join("Library").join("Application Support").join(APP_NAME),
        _ => env_or("XDG_DATA_HOME", home_dir().join(".local").join("share")).join("jitter"),
    }
}

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutostartEntry {
    pub path: PathBuf,
    pub content: String,
}

/// 自启注册项是输入的纯函数（三平台都可单测，不碰真实系统）。
pub fn build_autostart_entry(
    platform: &str,
    binary_path: &str,
    home: &str,
    app_data: Option<&str>,
    xdg_config_home: Option<&str>,
) -> AutostartEntry {
    let home_path = Path::new(home);

    // 自启条目必须固定工作目录：否则从 Startup 目录启动时，相对的
    // data/app.db 会落到别处，和手动启动的数据分叉。
    // 这里按「目标平台」的路径语义取目录（纯函数要能跨平台模拟）。
    let work_dir = if platform == "win32" {
        binary_path
            .rfind(['\\', '/'])
            .map(|idx| binary_path[..idx].to_string())
            .unwrap_or_default()
    } else {
        binary_path.rfind('/').map(|idx| binary_path[..idx].to_string()).unwrap_or_default()
    };

    if platform == "win32" {
        let app_data = app_data
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_path.join("AppData").join("Roaming"));
        let path = app_data
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join(format!("{APP_NAME}.cmd"));
        // Startup 目录会执行 .cmd；`start` 让进程脱离控制台窗口，
        // `/D` 把工作目录钉在程序所在目录。
        let content = format!(
            "@echo off\r\nstart \"\" /D \"{work_dir}\" \"{binary_path}\" --background\r\n"
        );
        return AutostartEntry { path, content };
    }

    if platform == "darwin" {
        let path = home_path.join("Library").join("LaunchAgents").join(format!("com.{AUTOSTART_ID}.app.plist"));
        let content = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
  <key>Label</key>\n\
  <string>com.{AUTOSTART_ID}.app</string>\n\
  <key>ProgramArguments</key>\n\
  <array>\n\
    <string>{binary_path}</string>\n\
    <string>--background</string>\n\
  </array>\n\
  <key>WorkingDirectory</key>\n\
  <string>{work_dir}</string>\n\
  <key>RunAtLoad</key>\n\
  <true/>\n\
  <key>KeepAlive</key>\n\
  <false/>\n\
</dict>\n\
</plist>\n"
        );
        return AutostartEntry { path, content };
    }

    let xdg = xdg_config_home
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_path.join(".config"));
    let path = xdg.join("autostart").join(format!("{AUTOSTART_ID}.desktop"));
    let content = format!(
        "[Desktop Entry]\n\
Type=Application\n\
Name={APP_NAME}\n\
Exec=\"{binary_path}\" --background\n\
Path={work_dir}\n\
Terminal=false\n\
X-GNOME-Autostart-enabled=true\n"
    );
    AutostartEntry { path, content }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn current_autostart_entry_owned() -> AutostartEntry {
    let home = home_dir();
    build_autostart_entry(
        platform(),
        &get_binary_path()
            .unwrap_or_else(|| PathBuf::from("jitter"))
            .to_string_lossy(),
        &home.to_string_lossy(),
        env_value("APPDATA").as_deref(),
        env_value("XDG_CONFIG_HOME").as_deref(),
    )
}

/// 自启注册文件的位置（当前机器）。
pub fn get_autostart_path() -> PathBuf {
    current_autostart_entry_owned().path
}

/// 当前是否已注册开机自启。
pub fn is_autostart_enabled() -> bool {
    get_autostart_path().exists()
}

/// 注册 / 取消注册开机自启（纯文件写）。
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let entry = current_autostart_entry_owned();
    if !enabled {
        let _ = fs::remove_file(&entry.path);
        return Ok(());
    }
    if let Some(parent) = entry.path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return Err(error.to_string());
        }
    }
    fs::write(&entry.path, entry.content).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// 系统信息
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub name: &'static str,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub compiled: bool,
    pub binary_path: String,
    pub install_dir: String,
    pub config_dir: String,
    pub db_path: String,
    pub autostart: bool,
    pub autostart_path: String,
    pub url: String,
    pub port: u16,
}

/// 设置页展示的全部安装信息。
pub fn get_system_info(port: u16, db_path: &str) -> SystemInfo {
    let binary = get_binary_path();
    let install_dir = binary
        .as_ref()
        .and_then(|path| path.parent())
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default();
    SystemInfo {
        name: APP_NAME,
        version: app_version().to_string(),
        platform: platform().to_string(),
        arch: arch().to_string(),
        compiled: true,
        binary_path: binary.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        install_dir,
        config_dir: get_config_dir().to_string_lossy().to_string(),
        db_path: db_path.to_string(),
        autostart: is_autostart_enabled(),
        autostart_path: get_autostart_path().to_string_lossy().to_string(),
        url: format!("http://127.0.0.1:{port}"),
        port,
    }
}
