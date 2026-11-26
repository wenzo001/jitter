//! Jitter 可执行程序：HTTP 服务 + 调度器 + 托盘。
//!
//! 前端静态文件直接嵌入二进制，产物是单文件应用。
//! 发布版隐藏控制台窗口：托盘是唯一入口（开发版保留控制台看日志）。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod api;
mod probe_cli;
mod scheduler;
mod tray;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

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

/// 初始化日志：控制台 + 按天轮转的文件。
///
/// 发布版没有控制台窗口，日志文件是唯一能查问题的线索，必须写。
fn init_tracing(log_dir: &std::path::Path) {
    let file_writer = jitter_core::logging::DailyLogWriter::new(
        log_dir.to_path_buf(),
        jitter_core::logging::retention_days_from_env(),
    );
    // RUST_LOG 由标准 EnvFilter 解析（支持级别、目标前缀、span 过滤）。
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    // 控制台与文件各一份；文件写入失败不能影响服务启动。
    let console = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stdout)
        .with_target(false)
        .with_ansi(false);
    let file = tracing_subscriber::fmt::layer()
        .with_writer(file_writer)
        .with_target(false)
        .with_ansi(false);
    // 过滤器放在最外层，两层共用；注册失败时忽略（已经初始化过的情况）。
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(console)
        .with(file)
        .try_init();
}

/// panic 兜底：记录到日志文件 + 控制台，绝不让 panic 静默消失。
///
/// 配合 release 的 `panic = "unwind"`，panic 只结束当前连接/任务，
/// 进程继续服务其它功能。
fn install_panic_hook(log_dir: &std::path::Path) {
    let dir = log_dir.to_path_buf();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|value| format!("{}:{}", value.file(), value.line()))
            .unwrap_or_else(|| "未知位置".to_string());
        let message = match info.payload().downcast_ref::<&str>() {
            Some(text) => (*text).to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(text) => text.clone(),
                None => "未知 panic".to_string(),
            },
        };
        let line = format!(
            "[{}] PANIC {message}（{location}）",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        eprintln!("{line}");
        jitter_core::logging::append_line(&dir, &line);
    }));
}

/// 启动失败：写日志 + 弹窗告诉用户怎么办（发布版没有控制台，弹窗是唯一出口）。
fn fatal_exit(log_dir: &std::path::Path, message: &str) -> ! {
    let line = format!(
        "[{}] 启动失败：{message}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    eprintln!("{line}");
    jitter_core::logging::append_line(log_dir, &line);
    show_fatal_dialog(log_dir, message);
    std::process::exit(1);
}

/// 致命错误的用户提示：Windows 用系统弹窗，其它平台写 stderr。
fn show_fatal_dialog(log_dir: &std::path::Path, message: &str) {
    let hint = format!(
        "Jitter 启动失败：\n\n{message}\n\n请检查：\n\
         1) 数据库文件是否被占用或无写入权限（路径：{}）\n\
         2) 配置文件是否合法（jitter.config.json）\n\
         3) 端口是否被其它程序占用\n\n\
         完整日志见：{}",
        jitter_core::config::get_active_config().db_path,
        log_dir.join(jitter_core::logging::file_name_for(
            &jitter_core::logging::today_stamp(now_ms()),
        ))
        .display()
    );
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_TOPMOST,
        };
        let wide: Vec<u16> = hint.encode_utf16().chain(std::iter::once(0)).collect();
        let title: Vec<u16> = "Jitter 启动失败".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR | MB_TOPMOST,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("{hint}");
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}


/// 删除一天前的 `jitter-update-*` 临时目录（尽力而为，失败忽略）。
fn cleanup_stale_update_dirs() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let one_day = std::time::Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("jitter-update-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age > one_day)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
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
///
/// 互斥体名**按实例区分**（`Local\JitterSingleInstance-prod` / `-dev`），
/// 所以不同实例各自互斥、实例之间互不干扰。
#[cfg(windows)]
fn acquire_single_instance() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const std::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let mut name: Vec<u16> = jitter_core::instance::single_instance_mutex_name()
        .encode_utf16()
        .collect();
    name.push(0);
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let last_error = unsafe { GetLastError() };
    if handle == 0 {
        // 创建失败就不拦，宁可多开也不让程序起不来。
        return true;
    }
    // 句柄故意不关闭：互斥体要活到进程结束。
    // （isize 是 Copy 类型，mem::forget 对它没有作用，这里只是明确表达意图。）
    let _ = handle;
    last_error != ERROR_ALREADY_EXISTS
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool {
    true
}

/// 读取指定路径的配置文件。
///
/// 返回 `(配置, 错误信息)`。配置文件读不出来时用默认值继续启动，
/// 但错误信息要交给调用方显示给用户。
fn read_config_file(path: &std::path::Path) -> (jitter_core::config::AppConfig, Option<String>) {
    match jitter_core::config::load_config_from(path) {
        Ok(Some(loaded)) => (loaded, None),
        Ok(None) => (jitter_core::config::AppConfig::default(), None),
        Err(error) => (
            jitter_core::config::AppConfig::default(),
            Some(format!("配置文件 {} 读取失败：{error}", path.display())),
        ),
    }
}

fn main() {
    // `jitter probe` 是只读诊断工具：必须在任何实例初始化之前分流出去。
    // 它不起服务、不占端口、不抢互斥体、不碰本机自己的数据库。
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("probe") {
        std::process::exit(probe_cli::run(&args[2..]));
    }

    // 配置：内置默认值 < 配置文件 < 环境变量（与旧 TS 版一致）。
    // 先读配置是为了知道日志目录（与数据库同级），读失败也要继续用默认值启动。
    let mut config = jitter_core::config::AppConfig::default();
    let mut config_error: Option<String> = None;
    let mut config_path: Option<std::path::PathBuf> = None;
    if let Some(path) = jitter_core::config::find_config_path(None) {
        let (loaded, error) = read_config_file(&path);
        config = loaded;
        config_error = error;
        // 无论配置内容读没读成功，**数据目录基准都按这个配置文件所在目录算**：
        // 否则配置一坏就退回 exe 目录，用默认 dbPath 指向另一个库，用户以为数据丢了。
        config_path = Some(path);
    }
    apply_env_overrides(&mut config);
    // 数据库路径归一化成绝对路径。
    //
    // 相对路径按「配置文件所在目录 → 可执行文件所在目录」解析，不跟当前工作目录走：
    // 否则在源码仓库根目录运行开发版时，相对的 "data/app.db" 会直接命中用户安装版
    // 的真实数据库，开发和正式环境就混在一起了。
    let base_dir = jitter_core::config::base_dir_for(config_path.as_deref());
    config.db_path = jitter_core::config::resolve_db_path_absolute(&base_dir, &config.db_path)
        .to_string_lossy()
        .to_string();
    let log_dir = jitter_core::logging::log_dir(&config.db_path);
    init_tracing(&log_dir);
    install_panic_hook(&log_dir);
    jitter_core::config::set_active_config(config.clone());
    if let Some(path) = config_path {
        tracing::info!("配置: {}", path.display());
    }
    tracing::info!("数据目录基准: {}", base_dir.display());
    if let Some(error) = config_error {
        // 配置坏了不能让程序起不来，但必须让用户看见：健康检查会把它回报给界面，
        // 顶部会弹出「后台降级」横幅告诉他去修配置文件。
        tracing::error!("{error}（已用默认配置继续启动）");
        crate::api::set_startup_error(&format!(
            "{error}（已用默认配置继续启动，请检查配置文件）"
        ));
    }

    // 本地小工具：2 个工作线程足够（HTTP 轮询 + 定时器），
    // 又能保证 DB 操作阻塞时健康检查仍可响应。默认按 CPU 核数开线程太浪费。
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => fatal_exit(&log_dir, &format!("无法创建异步运行时：{error}")),
    };
    if let Err(error) = runtime.block_on(run(config)) {
        fatal_exit(&log_dir, &error.to_string());
    }
}

async fn run(config: jitter_core::config::AppConfig) -> anyhow::Result<()> {
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

    // 清理超过一天的升级下载临时目录（每次升级约 2MB，不清理会慢慢堆积）。
    cleanup_stale_update_dirs();

    // 单实例：已有一个在跑时，只打开它的页面然后退出（避免两个调度器
    // 同时跑同一套任务）。测试等特殊场景可用 JITTER_ALLOW_MULTI_INSTANCE=1 跳过。
    let allow_multi = std::env::var("JITTER_ALLOW_MULTI_INSTANCE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false);
    if !allow_multi && !acquire_single_instance() {
        tracing::info!("检测到已有 Jitter 实例，打开它的界面后退出");
        open_existing_instance();
        std::process::exit(0);
    }

    // 数据库。
    let db_path = config.db_path.clone();
    jitter_core::db::init_db(Some(&db_path))?;
    tracing::info!("数据库: {db_path}");
    tracing::info!(
        "运行日志: {}",
        jitter_core::logging::log_dir(&db_path).display()
    );

    // 全局设置：接通电源时防止系统休眠（默认关闭）。
    jitter_core::host::set_prevent_sleep(jitter_core::db::get_prevent_sleep_on_ac());

    // 开机自启条目按当前程序路径重写一次：旧版本生成的 .cmd 可能在
    // 开机盘符未就绪时弹「找不到文件」，这里顺手升级成新版内容。
    // 调试构建不碰（避免把开发机的自启条目指到 target/debug）。
    if !cfg!(debug_assertions) && jitter_core::system::is_autostart_enabled() {
        if let Err(error) = jitter_core::system::set_autostart(true) {
            tracing::warn!("刷新开机自启条目失败: {error}");
        }
    }

    // 调度器。
    let recovered = scheduler::start().await?;
    tracing::info!("已恢复 {recovered} 个 active 任务");
    scheduler::spawn_startup_runs();

    // 启动时静默刷新节假日数据（去年 / 今年 / 明年；失败不做任何提示）。
    tokio::spawn(jitter_core::holiday::refresh_years_silent());

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broken_config_keeps_its_own_directory_as_the_data_base() {
        // 配置文件损坏时不能让数据目录基准退回 exe 目录：
        // 那样会用默认 dbPath 指向另一个库，用户以为数据丢了。
        let dir = std::env::temp_dir().join(format!("jitter-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("jitter.config.json");
        std::fs::write(&path, "{ 这不是合法 JSON").expect("write");

        let (config, error) = read_config_file(&path);
        assert!(error.is_some(), "坏掉的配置必须报错给用户看");
        assert_eq!(config.db_path, "data/app.db", "读不出来时用默认 dbPath");

        // 关键：基准目录仍然是配置文件所在目录。
        let base = jitter_core::config::base_dir_for(Some(&path));
        assert_eq!(base, dir);
        let resolved = jitter_core::config::resolve_db_path_absolute(&base, &config.db_path);
        assert_eq!(resolved, dir.join("data").join("app.db"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}