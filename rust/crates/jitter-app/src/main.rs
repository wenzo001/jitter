//! Jitter 可执行程序：HTTP 服务 + 调度器 + 托盘。
//!
//! 前端静态文件直接嵌入二进制，产物是单文件应用。
//! 发布版隐藏控制台窗口：托盘是唯一入口（开发版保留控制台看日志）。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod api;
mod scheduler;
mod tray;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

/// 前端 HTML/JS（与 TypeScript 版共用同一份文件，构建时嵌入）。
pub const INDEX_HTML: &str = include_str!("../../../../src/frontend/index.html");
pub const APP_JS: &str = include_str!("../../../../src/frontend/app.js");

pub static ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);

/// 退出信号：网页「退出应用」按钮与托盘菜单共用一条关停路径。
static QUIT: OnceLock<CancellationToken> = OnceLock::new();

pub fn quit_token() -> &'static CancellationToken {
    QUIT.get_or_init(CancellationToken::new)
}

/// 环境变量覆盖配置（PORT / HOST / JITTER_DB_PATH），优先级高于配置文件。
fn apply_env_overrides(config: &mut jitter_core::config::AppConfig) {
    if let Ok(value) = std::env::var("PORT") {
        if let Ok(port) = value.trim().parse::<u16>() {
            config.port = port;
        }
    }
    if let Ok(value) = std::env::var("HOST") {
        let host = value.trim().to_string();
        if !host.is_empty() {
            config.host = host;
        }
    }
    if let Ok(value) = std::env::var("JITTER_DB_PATH") {
        let db_path = value.trim().to_string();
        if !db_path.is_empty() {
            config.db_path = db_path;
        }
    }
}

// ---------------------------------------------------------------------------
// 单实例：重复启动只会打开已有实例的页面，绝不再起第二个调度器。
// ---------------------------------------------------------------------------

/// 实际监听端口写在配置目录，供重复启动/工具发现。
fn runtime_file_path() -> std::path::PathBuf {
    jitter_core::system::get_config_dir().join("jitter.runtime.json")
}

fn write_runtime_file(port: u16) {
    let path = runtime_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
    })
    .to_string();
    if let Err(error) = std::fs::write(&path, payload) {
        tracing::warn!("写运行时端口文件失败: {error}");
    }
}

fn remove_runtime_file() {
    let _ = std::fs::remove_file(runtime_file_path());
}

fn read_runtime_port() -> u16 {
    std::fs::read_to_string(runtime_file_path())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("port").and_then(|port| port.as_u64()))
        .map(|port| port as u16)
        .unwrap_or(3000)
}

/// 打开已运行实例的页面（用它的实际端口）。
fn open_existing_instance() {
    let port = read_runtime_port();
    let url = format!("http://127.0.0.1:{port}");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        let _ = std::process::Command::new(opener).arg(&url).spawn();
    }
}

/// 抢一个命名互斥体；返回 false 表示已有实例在运行。
#[cfg(windows)]
fn acquire_single_instance() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const std::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let mut name: Vec<u16> = "Local\\JitterSingleInstance".encode_utf16().collect();
    name.push(0);
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let last_error = unsafe { GetLastError() };
    if handle == 0 {
        // 创建失败就不拦，宁可多开也不让程序起不来。
        return true;
    }
    // 句柄故意泄漏：要让互斥体活到进程结束。
    std::mem::forget(handle);
    last_error != ERROR_ALREADY_EXISTS
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool {
    true
}

fn main() {
    tracing_subscriber::fmt()        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(error) = runtime.block_on(run()) {
        tracing::error!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    // 配置：内置默认值 < 配置文件 < 环境变量（与 TS 版一致）。
    let mut config = jitter_core::config::AppConfig::default();
    if let Some(path) = jitter_core::config::find_config_path(None) {
        if let Some(loaded) = jitter_core::config::load_config_from(&path)? {
            config = loaded;
        }
        tracing::info!("配置: {}", path.display());
    }
    apply_env_overrides(&mut config);
    jitter_core::config::set_active_config(config.clone());

    // 升级/重启后新进程的启动延迟：等旧进程退出，释放端口与单实例锁。
    let delay = std::env::var("JITTER_STARTUP_DELAY_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay.min(10_000))).await;
    }

    // 清理上次升级遗留的 .old（旧进程已退出，文件锁已释放）。
    if let Some(exe) = jitter_core::system::get_binary_path() {
        let _ = std::fs::remove_file(format!("{}.old", exe.to_string_lossy()));
    }

    // 单实例：已有一个在跑时，只打开它的页面然后退出（避免两个调度器
    // 同时跑同一套任务）。
    if !acquire_single_instance() {
        tracing::info!("检测到已有 Jitter 实例，打开它的界面后退出");
        open_existing_instance();
        std::process::exit(0);
    }

    // 数据库。
    let db_path = config.db_path.clone();
    jitter_core::db::init_db(Some(&db_path))?;
    tracing::info!("数据库: {db_path}");

    // 调度器。
    let recovered = scheduler::start().await?;
    tracing::info!("已恢复 {recovered} 个 active 任务");

    // HTTP 服务。
    let app = api::build_router();
    let host = config.host.clone();
    let mut port = config.port;
    let listener = loop {
        match tokio::net::TcpListener::bind((host.as_str(), port)).await {
            Ok(listener) => break listener,
            Err(error)
                if config.auto_increment_port
                    && port < config.port + config.port_max_attempts as u16 =>
            {
                tracing::warn!("端口 {port} 被占用（{error}），尝试 {}", port + 1);
                port += 1;
            }
            Err(error) => return Err(anyhow::anyhow!("无法监听 {host}:{port}: {error}")),
        }
    };
    ACTUAL_PORT.store(port, Ordering::SeqCst);
    write_runtime_file(port);
    tracing::info!("Jitter 已启动: http://{host}:{port}");

    // 托盘（Windows；其它平台为空操作）。
    tray::spawn(port, quit_token().clone());

    // Ctrl+C、托盘退出与网页「退出应用」共用一条关停路径。
    let shutdown = async {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = quit_token().cancelled() => tracing::info!("正在停止 Jitter..."),
        }
        scheduler::stop().await;
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;

    // 给在途的中断执行留一点写日志的时间。
    tokio::time::sleep(Duration::from_millis(config.shutdown_grace_ms.max(0) as u64)).await;
    remove_runtime_file();
    std::process::exit(0);
}
