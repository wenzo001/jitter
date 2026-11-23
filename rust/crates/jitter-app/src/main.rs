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
    std::process::exit(0);
}
