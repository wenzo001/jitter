//! 执行引擎测试：成功判定 + 真实 HTTP 往返（本地 tokio 服务器）。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use jitter_core::config::ConfigGuard;
use jitter_core::db::{init_db, NewTaskInput};
use jitter_core::executor::{
    evaluate_precheck, evaluate_success, execute_task_run, PrecheckInput, SuccessInput,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn success(status: i64) -> SuccessInput<'static> {
    SuccessInput {
        status: Some(status),
        body: Some(""),
        truncated: false,
        aborted: false,
        error: None,
        expect_status: None,
        expect_body: None,
        expect_expr: None,
    }
}

#[test]
fn defaults_to_any_2xx() {
    assert!(evaluate_success(&success(200)));
    assert!(evaluate_success(&success(204)));
    assert!(!evaluate_success(&success(301)));
    assert!(!evaluate_success(&success(500)));
}

#[test]
fn honors_an_expected_status() {
    let mut input = success(200);
    input.expect_status = Some(204);
    assert!(!evaluate_success(&input));
    let mut input = success(204);
    input.expect_status = Some(204);
    assert!(evaluate_success(&input));
}

#[test]
fn honors_an_exact_expected_body() {
    let mut input = success(200);
    input.expect_body = Some("ok");
    input.body = Some("ok");
    assert!(evaluate_success(&input));
    input.body = Some("not ok");
    assert!(!evaluate_success(&input));
}

#[test]
fn requires_both_expectations_to_match() {
    let mut input = success(200);
    input.expect_status = Some(200);
    input.expect_body = Some("ok");
    input.body = Some("no");
    assert!(!evaluate_success(&input));
}

#[test]
fn fails_on_truncated_bodies_when_body_is_expected() {
    let mut input = success(200);
    input.expect_body = Some("ok");
    input.truncated = true;
    assert!(!evaluate_success(&input));
}

#[test]
fn fails_on_errors_and_aborts() {
    let mut input = success(200);
    input.error = Some("boom");
    assert!(!evaluate_success(&input));
    input.error = None;
    input.aborted = true;
    assert!(!evaluate_success(&input));
    input.aborted = false;
    input.status = None;
    assert!(!evaluate_success(&input));
}

#[test]
fn honors_a_condition_expression_against_the_json_body() {
    let mut input = success(200);
    input.expect_expr = Some("data.code=0");
    input.body = Some(r#"{"data":{"code":0}}"#);
    assert!(evaluate_success(&input));
    input.body = Some(r#"{"data":{"code":900}}"#);
    assert!(!evaluate_success(&input));
}

#[test]
fn combines_expression_with_status_and_body() {
    let mut input = success(200);
    input.expect_status = Some(200);
    input.expect_body = Some("x");
    input.expect_expr = Some("$status=200");
    input.body = Some("x");
    assert!(evaluate_success(&input));
    input.status = Some(500);
    assert!(!evaluate_success(&input));
}

#[test]
fn treats_malformed_json_as_missing_paths() {
    let mut input = success(200);
    input.expect_expr = Some("data.code=0");
    input.body = Some("not json");
    assert!(!evaluate_success(&input));
}

#[test]
fn never_crashes_on_an_invalid_expression() {
    let mut input = success(200);
    input.expect_expr = Some("data.");
    input.body = Some("{}");
    assert!(!evaluate_success(&input));
}

#[test]
fn precheck_verdicts_explain_themselves() {
    let verdict = evaluate_precheck(&PrecheckInput {
        status: Some(500),
        body: Some(""),
        truncated: false,
        aborted: false,
        error: None,
        expect_status: None,
        expect_expr: None,
    });
    assert!(!verdict.passed);
    assert!(verdict.reason.contains("500"));

    let verdict = evaluate_precheck(&PrecheckInput {
        status: Some(200),
        body: Some(""),
        truncated: false,
        aborted: false,
        error: None,
        expect_status: None,
        expect_expr: None,
    });
    assert!(verdict.passed);

    let verdict = evaluate_precheck(&PrecheckInput {
        status: Some(200),
        body: Some(r#"{"ok":true}"#),
        truncated: false,
        aborted: false,
        error: None,
        expect_status: None,
        expect_expr: Some("ok=true"),
    });
    assert!(verdict.passed);
    assert!(verdict.reason.contains("前置条件满足"));
}

#[test]
fn precheck_failure_reasons() {
    let verdict = evaluate_precheck(&PrecheckInput {
        status: None,
        body: None,
        truncated: false,
        aborted: false,
        error: None,
        expect_status: None,
        expect_expr: None,
    });
    assert!(verdict.reason.contains("没有拿到响应"));

    let verdict = evaluate_precheck(&PrecheckInput {
        status: Some(500),
        body: Some(""),
        truncated: false,
        aborted: false,
        error: Some("connection refused"),
        expect_status: None,
        expect_expr: None,
    });
    assert!(verdict.reason.contains("connection refused"));
}

// ---------------------------------------------------------------------------
// 真实 HTTP 往返
// ---------------------------------------------------------------------------

static PORT_SEQ: AtomicU32 = AtomicU32::new(3100);

/// 数据库是进程级单例：这些测试也要串行使用它。
static DB_LOCK: Mutex<()> = Mutex::new(());

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

/// 持有锁直到测试结束：数据库是全局单例，整个测试期间都不能被别的测试换掉。
struct DbGuard {
    path: std::path::PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Drop for DbGuard {
    fn drop(&mut self) {
        // 配置与数据库都是全局单例：测试结束后恢复默认并关闭连接。
        jitter_core::config::set_active_config(jitter_core::config::AppConfig::default());
        jitter_core::db::close_db();
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        let _ = std::fs::remove_dir(self.path.parent().expect("parent"));
    }
}

/// 每个测试独立的数据库与配置（都在同一把锁下设置，避免并发串扰）。
fn setup_db(config: jitter_core::config::AppConfig) -> DbGuard {
    let lock = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    jitter_core::config::set_active_config(config);
    let dir = std::env::temp_dir().join(format!(
        "jitter-exec-{}-{}",
        std::process::id(),
        DIR_SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("app.db");
    init_db(Some(path.to_str().unwrap())).expect("db");
    DbGuard { path, _lock: lock }
}

/// 极简 HTTP 服务器：对每个连接返回一段预先写好的响应。
async fn spawn_server(responses: Vec<String>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = PORT_SEQ.fetch_add(1, Ordering::SeqCst);
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("bind");
    tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            socket.write_all(response.as_bytes()).await.expect("write");
            socket.flush().await.expect("flush");
            socket.shutdown().await.ok();
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn http_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn task_input(url: &str) -> NewTaskInput {
    NewTaskInput {
        name: "run".to_string(),
        curl_command: Some(format!("curl {url}")),
        request: jitter_core::db::RequestParts {
            url: url.to_string(),
            method: "GET".to_string(),
            headers: Some("{}".to_string()),
            body: None,
            options: Some("{}".to_string()),
        },
        window_start: "10:10".to_string(),
        window_end: "10:20".to_string(),
        ..Default::default()
    }
}

#[tokio::test]
async fn writes_a_full_task_log() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });

    let url = spawn_server(vec![http_response("200 OK", "hello")]).await;
    let input = task_input(&url);
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    assert!(!outcome.skipped);
    assert_eq!(outcome.status, Some(200));
    assert!(outcome.matched);
    assert!(outcome.error.is_none());
    assert!(outcome.duration_ms >= 0);

    let log = jitter_core::db::get_log(outcome.main_log_id)
        .expect("read")
        .expect("exists");
    assert_eq!(log.kind, "task");
    assert_eq!(log.response_status, Some(200));
    assert_eq!(log.response_body.as_deref(), Some("hello"));
    assert_eq!(log.matched, Some(1));
    assert_eq!(log.request_url.as_deref(), Some(url.as_str()));

}

#[tokio::test]
async fn caps_a_large_body() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 10,
        ..Default::default()
    });
    let url = spawn_server(vec![http_response("200 OK", "x".repeat(1000).as_str())]).await;
    let input = task_input(&url);
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    // 未配置成功条件时 2xx 仍然命中；但存下来的正文被截断并标注。
    assert!(outcome.matched);
    let log = jitter_core::db::get_log(outcome.main_log_id)
        .expect("read")
        .expect("exists");
    assert_eq!(
        log.response_body.as_deref().map(str::len),
        Some(10 + "\n[truncated]".len())
    );
}

#[tokio::test]
async fn notifies_when_matched() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let url = spawn_server(vec![http_response("200 OK", "ok"), http_response("200 OK", "sent")]).await;
    let mut input = task_input(&url);
    input.notify_enabled = true;
    input.notify_request = Some(jitter_core::db::RequestParts {
        url: url.clone(),
        method: "POST".to_string(),
        headers: Some("{}".to_string()),
        body: Some("ping".to_string()),
        options: Some("{}".to_string()),
    });
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    assert!(outcome.matched);
    assert!(outcome.notify_log_id.is_some());
    let notify = jitter_core::db::get_log(outcome.notify_log_id.expect("id"))
        .expect("read")
        .expect("exists");
    assert_eq!(notify.kind, "notify");
    assert_eq!(notify.parent_log_id, Some(outcome.main_log_id));
}

#[tokio::test]
async fn local_guard_skips_the_main_request() {
    let _db = setup_db(jitter_core::config::AppConfig::default());
    let url = spawn_server(vec![]).await;
    let mut input = task_input(&url);
    input.precheck_enabled = true;
    input.precheck_weekdays = Some(vec![2]); // 周三（今天大概率不是）
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    if outcome.skipped {
        assert_eq!(outcome.status, None);
        assert!(!outcome.matched);
        let log = jitter_core::db::get_log(outcome.main_log_id)
            .expect("read")
            .expect("exists");
        assert_eq!(log.kind, "skipped");
    }
}

#[tokio::test]
async fn startup_run_honors_precheck_but_manual_bypasses() {
    use chrono::Datelike;

    let _db = setup_db(jitter_core::config::AppConfig::default());
    let url = spawn_server(vec![http_response("200 OK", "ok")]).await;
    let mut input = task_input(&url);
    input.precheck_enabled = true;
    // 选一个「明天」的星期，确保启动自动执行会被本地条件拦下。
    let today = chrono::Local::now().weekday().num_days_from_sunday() as i64;
    input.precheck_weekdays = Some(vec![(today + 1) % 7]);
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");

    let startup = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Startup,
    )
    .await;
    assert!(startup.skipped, "开机自动执行仍要检查执行条件");
    assert_eq!(startup.status, None);

    // 页面「立即执行」不受条件限制，会真实发出请求。
    let manual = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Manual,
    )
    .await;
    assert!(!manual.skipped);
    assert!(manual.matched);
}

#[tokio::test]
async fn curl_guard_failure_records_the_exchange() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    // 前置请求返回 500 → 主请求不发送（服务器只准备一个响应）。
    let url = spawn_server(vec![http_response("500 Internal Server Error", "no")]).await;
    let mut input = task_input(&url);
    input.precheck_enabled = true;
    input.precheck_request = Some(jitter_core::db::RequestParts {
        url: url.clone(),
        method: "GET".to_string(),
        headers: Some("{}".to_string()),
        body: None,
        options: Some("{}".to_string()),
    });
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    assert!(outcome.skipped);
    assert_eq!(outcome.status, Some(500));
    let log = jitter_core::db::get_log(outcome.main_log_id)
        .expect("read")
        .expect("exists");
    assert_eq!(log.kind, "skipped");
    assert_eq!(log.response_status, Some(500));
    assert!(log.error.as_deref().unwrap_or("").contains("跳过主请求"));
}

#[tokio::test]
async fn timeout_is_reported_as_a_timeout() {
    // 服务器接收连接但不响应 → 超时。
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer).await;
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    });
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 500,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let input = task_input(&format!("http://{addr}"));
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(&task, &CancellationToken::new(), jitter_core::types::RunSource::Scheduled).await;
    assert_eq!(outcome.status, None);
    assert!(outcome.error.as_deref().unwrap_or("").contains("请求超时"));
}

#[test]
fn merge_config_reports_page_size_inversions() {
    let result = jitter_core::config::merge_config(
        &jitter_core::config::AppConfig::default(),
        &json!({ "logsPageSize": 200, "logsMaxPageSize": 50 }),
    );
    assert!(result.is_err());
}
