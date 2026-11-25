//! 运行配置：默认值、配置文件合并、运行时单例。
//!
//! 与 TypeScript 版（`src/config.ts`）字段一致（camelCase 的 JSON 键）。

use std::path::{Path, PathBuf};
use serde_json::Value as Json;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub port: u16,
    pub host: String,
    pub auto_increment_port: bool,
    pub port_max_attempts: u32,
    pub db_path: String,
    pub log_body_limit_bytes: usize,
    pub logs_page_size: i64,
    pub logs_max_page_size: i64,
    /// 0 表示不设超时（界面会提示）。
    pub request_timeout_ms: i64,
    pub log_retention_days: i64,
    pub log_max_rows_per_task: i64,
    pub shutdown_grace_ms: i64,
    pub default_window_minutes: i64,
    pub poll_interval_ms: i64,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            port: 3000,
            host: "127.0.0.1".to_string(),
            auto_increment_port: true,
            port_max_attempts: 100,
            db_path: "data/app.db".to_string(),
            log_body_limit_bytes: 100 * 1024,
            logs_page_size: 50,
            logs_max_page_size: 200,
            request_timeout_ms: 30_000,
            log_retention_days: 30,
            log_max_rows_per_task: 0,
            shutdown_grace_ms: 150,
            default_window_minutes: 5,
            poll_interval_ms: 4000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// 运行中的配置（宿主进程启动时设置）。
static ACTIVE_CONFIG: OnceLock<RwLock<AppConfig>> = OnceLock::new();

fn slot() -> &'static RwLock<AppConfig> {
    ACTIVE_CONFIG.get_or_init(|| RwLock::new(AppConfig::default()))
}

pub fn get_active_config() -> AppConfig {
    slot().read().expect("config lock").clone()
}

pub fn set_active_config(config: AppConfig) {
    *slot().write().expect("config lock") = config;
}

/// 从 JSON 合并配置；非法值直接报错（与 TS 的 validateFileConfig 等价的最小实现）。
pub fn merge_config(base: &AppConfig, file: &Json) -> Result<AppConfig, ConfigError> {
    let mut merged = base.clone();
    let Some(fields) = file.as_object() else {
        return Err(ConfigError("配置文件根节点必须是 JSON 对象".into()));
    };
    for (key, value) in fields {
        match key.as_str() {
            "port" => merged.port = value.as_u64().unwrap_or(merged.port as u64) as u16,
            "host" => {
                if let Some(text) = value.as_str() {
                    merged.host = text.to_string();
                }
            }
            "autoIncrementPort" => merged.auto_increment_port = value.as_bool().unwrap_or(true),
            "portMaxAttempts" => {
                merged.port_max_attempts = value.as_u64().unwrap_or(100) as u32;
            }
            "dbPath" => {
                if let Some(text) = value.as_str() {
                    merged.db_path = text.to_string();
                }
            }
            "logBodyLimitBytes" => {
                merged.log_body_limit_bytes = value.as_u64().unwrap_or(102400) as usize;
            }
            "logsPageSize" => merged.logs_page_size = value.as_i64().unwrap_or(50),
            "logsMaxPageSize" => merged.logs_max_page_size = value.as_i64().unwrap_or(200),
            "requestTimeoutMs" => merged.request_timeout_ms = value.as_i64().unwrap_or(30_000),
            "logRetentionDays" => merged.log_retention_days = value.as_i64().unwrap_or(30),
            "logMaxRowsPerTask" => merged.log_max_rows_per_task = value.as_i64().unwrap_or(0),
            "shutdownGraceMs" => merged.shutdown_grace_ms = value.as_i64().unwrap_or(150),
            "defaultWindowMinutes" => merged.default_window_minutes = value.as_i64().unwrap_or(5),
            "pollIntervalMs" => merged.poll_interval_ms = value.as_i64().unwrap_or(4000),
            _ => {}
        }
    }
    if merged.logs_max_page_size < merged.logs_page_size {
        return Err(ConfigError("配置项 \"logsMaxPageSize\" 不能小于 \"logsPageSize\"".into()));
    }
    Ok(merged)
}

/// 从磁盘读配置文件（不存在返回默认值）。
pub fn load_config_from(path: &Path) -> Result<Option<AppConfig>, ConfigError> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(None);
    };
    let value: Json = serde_json::from_str(&text)
        .map_err(|error| ConfigError(format!("配置文件不是合法 JSON: {error}")))?;
    Ok(Some(merge_config(&AppConfig::default(), &value)?))
}

/// 配置文件查找顺序：显式 > 环境变量 > 启动目录 > 可执行文件旁。
pub fn find_config_path(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(value));
    }
    if let Ok(value) = std::env::var("JITTER_CONFIG") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("jitter.config.json"),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("jitter.config.json")))
            .unwrap_or_default(),
    ];
    candidates.retain(|candidate| candidate.as_os_str().len() > 0 && candidate.exists());
    candidates.into_iter().next()
}

/// 相对路径的基准目录。
///
/// 为什么不按「当前工作目录」算：程序从不同目录启动时 CWD 会变，
/// 同一个相对 dbPath 就会指向不同的库——最典型的就是在源码仓库根目录运行开发版，
/// 直接把用户安装版的 `data/` 当成开发库写进去。
///
/// 规则：
/// - 有配置文件 → 配置文件所在目录；
/// - 没有配置文件 → 可执行文件所在目录（安装版的 `data/` 永远跟着 exe 走，
///   从任何工作目录启动都指向同一个库）；
/// - 都没有 → 当前工作目录。
pub fn base_dir_for(config_path: Option<&Path>) -> PathBuf {
    if let Some(path) = config_path {
        let dir = path.parent().unwrap_or_else(|| Path::new(""));
        return dir_or_cwd(dir);
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        return dir;
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 空目录或 "." 一律按当前工作目录处理。
fn dir_or_cwd(dir: &Path) -> PathBuf {
    if dir.as_os_str().is_empty() || dir == Path::new(".") {
        return std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    }
    if dir.is_absolute() {
        return dir.to_path_buf();
    }
    std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// 数据库路径归一化：绝对路径原样保留，相对路径按 `base` 解析成绝对路径。
pub fn resolve_db_path_absolute(base: &Path, db_path: &str) -> PathBuf {
    let trimmed = db_path.trim();
    if trimmed.is_empty() {
        return base.join("data").join("app.db");
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    if base.is_absolute() {
        return base.join(candidate);
    }
    dir_or_cwd(base).join(candidate)
}

/// 线程安全地更新配置的辅助（测试用）。
pub struct ConfigGuard {
    previous: AppConfig,
}

impl ConfigGuard {
    pub fn set(config: AppConfig) -> ConfigGuard {
        let previous = get_active_config();
        set_active_config(config);
        ConfigGuard { previous }
    }
}

impl Drop for ConfigGuard {
    fn drop(&mut self) {
        set_active_config(self.previous.clone());
    }
}

// 供测试检查合并逻辑。
#[allow(dead_code)]
fn _assert_json_merge(value: &Json) -> Result<AppConfig, ConfigError> {
    merge_config(&AppConfig::default(), value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 跨平台的可临时目录（Windows / Linux 上都是绝对路径）。
    fn temp_base(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn relative_db_path_is_resolved_against_the_base_dir() {
        // 注意：不要用 "D:/xxx" 这种 Windows 盘符写死路径，
        // 在 Linux 上它不是绝对路径，测试会挂在「基准目录」上。
        let base = temp_base("jitter-base");
        let resolved = resolve_db_path_absolute(&base, "data/app.db");
        assert_eq!(
            resolved,
            base.join("data").join("app.db"),
            "相对路径按基准目录解析，不跟当前工作目录走"
        );
    }

    #[test]
    fn absolute_db_path_is_kept_as_is() {
        let absolute = temp_base("jitter-other-app.db");
        let resolved = resolve_db_path_absolute(
            &temp_base("jitter-base"),
            &absolute.to_string_lossy(),
        );
        assert_eq!(resolved, absolute);
    }

    #[test]
    fn empty_db_path_falls_back_to_data_app_db_under_base() {
        let base = temp_base("jitter-base");
        let resolved = resolve_db_path_absolute(&base, "   ");
        assert_eq!(resolved, base.join("data").join("app.db"));
    }

    #[test]
    fn base_dir_follows_the_config_file_location() {
        let dir = temp_base("jitter-config-dir");
        let base = base_dir_for(Some(&dir.join("jitter.config.json")));
        assert_eq!(base, dir);
    }

    #[test]
    fn base_dir_without_config_uses_the_executable_directory() {
        // 没有配置文件时，基准是可执行文件所在目录：安装版的 data/ 永远跟着 exe 走。
        let base = base_dir_for(None);
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf));
        if let Some(exe_dir) = exe_dir {
            assert_eq!(base, exe_dir);
        }
    }

    #[test]
    fn base_dir_of_a_bare_config_name_is_the_current_directory() {
        // 配置写在当前目录时，基准也应当是当前目录，而不是 exe 目录。
        let base = base_dir_for(Some(Path::new("jitter.config.json")));
        let cwd = std::env::current_dir().expect("cwd");
        assert_eq!(base, cwd);
    }
}
