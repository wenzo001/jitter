//! Jitter 可执行程序：HTTP 服务 + 调度器 + 托盘。
//!
//! 前端静态文件直接嵌入二进制，产物是单文件应用。

mod api;
mod scheduler;

use std::sync::atomic::{AtomicU16, Ordering};

use tracing_subscriber::EnvFilter;

/// 前端 HTML/JS（与 TypeScript 版共用同一份文件，构建时嵌入）。
pub const INDEX_HTML: &str = include_str!("../../../../src/frontend/index.html");
pub const APP_JS: &str = include_str!("../../../../src/frontend/app.js");

pub static ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
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
    // 配置：文件 > 默认值。
    let mut config = jitter_core::config::AppConfig::default();
    if let Some(path) = jitter_core::config::find_config_path(None) {
        if let Some(loaded) = jitter_core::config::load_config_from(&path)? {
            config = loaded;
        }
        tracing::info!("配置: {}", path.display());
    }
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

    // Ctrl+C 优雅退出。
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("正在停止 Jitter...");
        scheduler::stop().await;
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    Ok(())
}
