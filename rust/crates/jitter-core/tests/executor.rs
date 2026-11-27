//! 执行引擎测试：成功判定 + 真实 HTTP 往返（本地 tokio 服务器）。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
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

/// 本地 HTTP fixture：无限次接受连接、计数并返回同一个响应。
/// 用于断言「主请求有没有真的被发送」这类计数性检查。
async fn spawn_fixture(status: &str, body: &str) -> (String, std::sync::Arc<AtomicU32>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
    let response = http_response(status, body);
    let counter = std::sync::Arc::new(AtomicU32::new(0));
    let served = counter.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };
            served.fetch_add(1, Ordering::SeqCst);
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            let _ = socket.shutdown().await;
        }
    });
    (format!("http://127.0.0.1:{port}"), counter)
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

// ---------------------------------------------------------------------------
// 测试台：结构化前置（只有 precheck_url、没有 precheck_curl）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn testbench_runs_structured_precheck_and_skips_main_on_403() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    // 前置返回 403；主请求服务器可计数，正式链路下它一次都不该被访问。
    let (precheck_url, _) = spawn_fixture("403 Forbidden", "no").await;
    let (main_url, main_count) = spawn_fixture("200 OK", "hi").await;

    let input = json!({
        "url": main_url,
        "precheck_enabled": true,
        "precheck_url": precheck_url,
    });
    let result = jitter_core::testbench::run_test_bench(&input).await;

    let precheck_step = result
        .steps
        .iter()
        .find(|step| step.key == "precheck")
        .expect("结构化 precheck_url 应当真正发出条件检查请求");
    assert_eq!(precheck_step.status, "fail");
    assert!(result.summary.skipped, "前置 403 → 本次应判定为跳过");
    assert_eq!(
        main_count.load(Ordering::SeqCst),
        0,
        "前置不满足时测试台不得发送主请求"
    );
}

// ---------------------------------------------------------------------------
// 通知状态真实性：只有真实 HTTP 2xx 才算 notify_sent
// ---------------------------------------------------------------------------

#[tokio::test]
async fn notify_http_2xx_marks_notify_sent() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let url = spawn_server(vec![
        http_response("200 OK", "ok"),
        http_response("200 OK", "sent"),
    ])
    .await;
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
    let outcome = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Scheduled,
    )
    .await;
    assert!(outcome.notify_sent, "通知拿到 200 → sent");
    assert_eq!(outcome.notify_status, Some(200));
    assert_eq!(outcome.notify_error, None);
    assert!(outcome.notify_log_id.is_some());
}

#[tokio::test]
async fn notify_http_500_marks_notify_failed_but_keeps_log() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let url = spawn_server(vec![
        http_response("200 OK", "ok"),
        http_response("500 Internal Server Error", "boom"),
    ])
    .await;
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
    let outcome = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Scheduled,
    )
    .await;
    assert!(!outcome.notify_sent, "500 不是 2xx → 不能算已发送");
    assert_eq!(outcome.notify_status, Some(500));
    let error = outcome.notify_error.clone().unwrap_or_default();
    assert!(error.contains("500"), "notify_error 应记录状态码: {error}");
    // 失败的通知也必须保留日志，便于排查。
    let notify_log_id = outcome.notify_log_id.expect("notify log kept");
    let notify = jitter_core::db::get_log(notify_log_id)
        .expect("read")
        .expect("exists");
    assert_eq!(notify.kind, "notify");
    assert_eq!(notify.response_status, Some(500));
}

#[tokio::test]
async fn notify_timeout_marks_notify_failed() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 1000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let url = spawn_server(vec![http_response("200 OK", "ok")]).await;
    // 通知服务器只收连接不响应 → 超时。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let stall_addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer).await;
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    });
    let mut input = task_input(&url);
    input.notify_enabled = true;
    input.notify_request = Some(jitter_core::db::RequestParts {
        url: format!("http://{stall_addr}"),
        method: "POST".to_string(),
        headers: Some("{}".to_string()),
        body: Some("ping".to_string()),
        options: Some("{}".to_string()),
    });
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    let outcome = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Scheduled,
    )
    .await;
    assert!(!outcome.notify_sent);
    assert_eq!(outcome.notify_status, None);
    let error = outcome.notify_error.clone().unwrap_or_default();
    assert!(error.contains("请求超时"), "notify_error 应记录超时: {error}");
    assert!(
        outcome.notify_log_id.is_some(),
        "超时的通知也要保留日志"
    );
}

#[tokio::test]
async fn testbench_notify_sent_requires_2xx() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });

    // 通知返回 500 → notify_sent=false，且带状态与错误。
    let main = spawn_server(vec![http_response("200 OK", "ok")]).await;
    let (notify_url, _) = spawn_fixture("500 Internal Server Error", "boom").await;
    let input = json!({
        "url": main,
        "notify_enabled": true,
        "send_notify": true,
        "notify_url": notify_url,
    });
    let result = jitter_core::testbench::run_test_bench(&input).await;
    assert!(result.summary.matched);
    assert!(!result.summary.notify_sent, "500 不算已发送");
    assert_eq!(result.summary.notify_status, Some(500));
    assert!(result.summary.notify_failed);
    let error = result.summary.notify_error.clone().unwrap_or_default();
    assert!(error.contains("500"), "notify_error 应记录状态码: {error}");

    // 通知返回 2xx → notify_sent=true，无错误。
    let main = spawn_server(vec![http_response("200 OK", "ok")]).await;
    let (notify_url, _) = spawn_fixture("200 OK", "sent").await;
    let input = json!({
        "url": main,
        "notify_enabled": true,
        "send_notify": true,
        "notify_url": notify_url,
    });
    let result = jitter_core::testbench::run_test_bench(&input).await;
    assert!(result.summary.notify_sent);
    assert_eq!(result.summary.notify_status, Some(200));
    assert_eq!(result.summary.notify_error, None);
    assert!(!result.summary.notify_failed);
}

// ---------------------------------------------------------------------------
// 日志写入失败：必须返回错误，不许 panic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn main_log_write_failure_returns_error_without_panicking() {
    let _db = setup_db(jitter_core::config::AppConfig {
        request_timeout_ms: 5000,
        log_body_limit_bytes: 100 * 1024,
        ..Default::default()
    });
    let url = spawn_server(vec![http_response("200 OK", "ok")]).await;
    let task = jitter_core::db::create_task(&task_input(&url), "t1", 1000).expect("create");
    // 拔掉数据库再执行：insert_log 必然失败。
    jitter_core::db::close_db();
    let outcome = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Scheduled,
    )
    .await;
    assert_eq!(outcome.main_log_id, 0, "写库失败时 main_log_id 记 0");
    let error = outcome.error.clone().unwrap_or_default();
    assert!(error.contains("写入执行日志失败"), "应报告写库失败: {error}");
    assert_eq!(outcome.status, Some(200), "主请求结果仍然保留");
    assert!(!outcome.notify_sent);
}

#[tokio::test]
async fn skip_log_write_failure_returns_error_without_panicking() {
    use chrono::Datelike;
    let _db = setup_db(jitter_core::config::AppConfig::default());
    let url = spawn_server(vec![]).await;
    let mut input = task_input(&url);
    input.precheck_enabled = true;
    let today = chrono::Local::now().weekday().num_days_from_sunday() as i64;
    input.precheck_weekdays = Some(vec![(today + 1) % 7]);
    let task = jitter_core::db::create_task(&input, "t1", 1000).expect("create");
    jitter_core::db::close_db();
    let outcome = execute_task_run(
        &task,
        &CancellationToken::new(),
        jitter_core::types::RunSource::Scheduled,
    )
    .await;
    assert!(outcome.skipped);
    assert_eq!(outcome.main_log_id, 0);
    let error = outcome.error.clone().unwrap_or_default();
    assert!(error.contains("写入跳过日志失败"), "应报告写库失败: {error}");
}
