//! 执行引擎：前置判断 → 主请求 → 判定 → 通知，以及全部传输层健壮性。
//!
//! 传输层的行为约定：
//! - 连接被重置才重试（最多 2 次，带抖动退避，重试时带 `Connection: close`）
//! - 环境代理探测超时自动回退直连（用户显式 `-x` 的代理绝不改写）
//! - 响应体按上限截断（默认 100 KiB），截断的响应不参与正文条件判定
//! - 超时覆盖 ETIMEDOUT 等 socket 错误

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as Json};
use tokio_util::sync::CancellationToken;

use crate::condition::evaluate_condition;
use crate::config::get_active_config;
use crate::db::TaskRow;
use crate::db::{insert_log, NewLogInput};
use crate::guard::{
    evaluate_host_guard, evaluate_local_guard, has_host_conditions, local_guard_of, HostGuardConfig,
};
use crate::host;
use crate::types::RequestOptions;

/// 传输层重试：只对「连接被重置」类错误，且只发生在响应头到达之前。
const FETCH_RESET_RETRIES: usize = 2;
const FETCH_RETRY_BASE_DELAY_MS: u64 = 150;

/// 环境代理的探测超时：死代理快速失败，然后回退直连。
const PROXY_PROBE_TIMEOUT_MS: u64 = 8_000;

/// 测试请求的安全超时：挂死的 URL 不能阻塞调用方。
pub const TEST_REQUEST_TIMEOUT_MS: i64 = 30_000;

/// 成功判定输入。
pub struct SuccessInput<'a> {
    pub status: Option<i64>,
    pub body: Option<&'a str>,
    pub truncated: bool,
    pub aborted: bool,
    pub error: Option<&'a str>,
    pub expect_status: Option<i64>,
    pub expect_body: Option<&'a str>,
    pub expect_expr: Option<&'a str>,
}

/// 主请求的成功判定：未配置任何条件时要求 2xx。
pub fn evaluate_success(input: &SuccessInput<'_>) -> bool {
    if input.aborted || input.error.is_some() || input.status.is_none() {
        return false;
    }
    let status = input.status.expect("checked");
    if let Some(expect) = input.expect_status {
        if status != expect {
            return false;
        }
    }
    if let Some(expect_body) = input.expect_body {
        if input.truncated {
            return false;
        }
        if input.body.unwrap_or("") != expect_body {
            return false;
        }
    }
    if let Some(expr) = input.expect_expr {
        if input.truncated {
            return false;
        }
        let json: Json = input
            .body
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or(Json::Null);
        let context = crate::condition::ConditionContext {
            json: if json.is_null() { None } else { Some(json) },
            status: Some(status),
            body: input.body.map(str::to_string),
        };
        if !evaluate_condition(expr, &context) {
            return false;
        }
    }
    if input.expect_status.is_none() && input.expect_body.is_none() && input.expect_expr.is_none() {
        return (200..300).contains(&status);
    }
    true
}

/// 前置判断的判定（失败原因必须能写进跳过日志）。
pub struct PrecheckInput<'a> {
    pub status: Option<i64>,
    pub body: Option<&'a str>,
    pub truncated: bool,
    pub aborted: bool,
    pub error: Option<&'a str>,
    pub expect_status: Option<i64>,
    pub expect_expr: Option<&'a str>,
}

pub struct PrecheckVerdict {
    pub passed: bool,
    pub reason: String,
}

pub fn evaluate_precheck(input: &PrecheckInput<'_>) -> PrecheckVerdict {
    if input.aborted {
        return PrecheckVerdict {
            passed: false,
            reason: "条件检查请求被中断".to_string(),
        };
    }
    if let Some(error) = input.error {
        return PrecheckVerdict {
            passed: false,
            reason: format!("条件检查请求失败：{error}"),
        };
    }
    let Some(status) = input.status else {
        return PrecheckVerdict {
            passed: false,
            reason: "条件检查请求没有拿到响应".to_string(),
        };
    };
    if let Some(expect) = input.expect_status {
        if status != expect {
            return PrecheckVerdict {
                passed: false,
                reason: format!("条件检查返回 HTTP {status}，期望 {expect}"),
            };
        }
    }
    if let Some(expr) = input.expect_expr {
        if input.truncated {
            return PrecheckVerdict {
                passed: false,
                reason: "条件检查的响应体超过上限被截断，条件表达式无法判断".to_string(),
            };
        }
        let json: Json = input
            .body
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or(Json::Null);
        let context = crate::condition::ConditionContext {
            json: if json.is_null() { None } else { Some(json) },
            status: Some(status),
            body: input.body.map(str::to_string),
        };
        if !evaluate_condition(expr, &context) {
            return PrecheckVerdict {
                passed: false,
                reason: format!("前置条件不满足：{expr}"),
            };
        }
        return PrecheckVerdict {
            passed: true,
            reason: format!("前置条件满足：{expr}"),
        };
    }
    if input.expect_status.is_none() && !(200..300).contains(&status) {
        return PrecheckVerdict {
            passed: false,
            reason: format!("条件检查返回 HTTP {status}（未配置条件时要求 2xx）"),
        };
    }
    PrecheckVerdict {
        passed: true,
        reason: format!("条件检查通过（HTTP {status}）"),
    }
}

fn looks_like_timeout(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("timed out") || lower.contains("timeout") || lower.contains("etimedout")
}

fn parse_stored_headers(raw: Option<&str>) -> Result<Option<JsonMap<String, Json>>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let parsed: Json =
        serde_json::from_str(raw).map_err(|error| format!("请求头数据格式损坏: {error}"))?;
    let Some(map) = parsed.as_object() else {
        return Err("请求头数据格式损坏".to_string());
    };
    for (name, value) in map {
        if !value.is_string() {
            return Err(format!("请求头 {name} 的值不是字符串"));
        }
    }
    Ok(Some(map.clone()))
}

/// 从存储的 JSON 读取请求选项（坏数据一律回退默认值）。
pub fn parse_request_options(raw: Option<&str>) -> RequestOptions {
    let Some(raw) = raw else {
        return RequestOptions::default();
    };
    let Ok(Json::Object(record)) = serde_json::from_str::<Json>(raw) else {
        return RequestOptions::default();
    };
    let mut options = RequestOptions::default();
    if record.get("insecure") == Some(&Json::Bool(true)) {
        options.insecure = Some(true);
    }
    match record.get("redirect").and_then(|value| value.as_str()) {
        Some("follow") => options.redirect = Some(crate::types::RedirectMode::Follow),
        Some("manual") => options.redirect = Some(crate::types::RedirectMode::Manual),
        _ => {}
    }
    if let Some(timeout) = record.get("timeoutMs").and_then(|value| value.as_i64()) {
        if timeout >= 0 {
            options.timeout_ms = Some(timeout);
        }
    }
    if let Some(proxy) = record.get("proxy").and_then(|value| value.as_str()) {
        let trimmed = proxy.trim();
        if !trimmed.is_empty() {
            options.proxy = Some(trimmed.to_string());
        }
    }
    if let Some(auth) = record
        .get("proxyAuthorization")
        .and_then(|value| value.as_str())
    {
        let trimmed = auth.trim();
        if !trimmed.is_empty() {
            options.proxy_authorization = Some(trimmed.to_string());
        }
    }
    options
}

/// 唯一的请求构造入口：任务存储字段 → `RequestSpec`。
///
/// 测试台的 build_request 产出的就是同一个 `RequestSpec` 形状，两条链路
/// （正式执行 / 试跑）都经 `execute_request` 消费同一份构造与选项逻辑，
/// 避免「正式和试跑行为漂移」。坏数据与历史行为一致：头部解析失败视为无头部、
/// 选项解析失败回退默认值。
pub fn request_spec(
    url: &str,
    method: &str,
    headers: Option<&str>,
    body: Option<&str>,
    options: Option<&str>,
) -> crate::types::RequestSpec {
    crate::types::RequestSpec {
        url: url.to_string(),
        method: method.to_string(),
        headers: parse_stored_headers(headers).unwrap_or(None).unwrap_or_default(),
        body: body.map(str::to_string),
        options: Some(parse_request_options(options)),
    }
}

/// 从任务行的某一组请求列构造 `RequestSpec`（主 / 前置 / 通知共用）。
pub fn request_spec_of(
    url: Option<&str>,
    method: Option<&str>,
    headers: Option<&str>,
    body: Option<&str>,
    options: Option<&str>,
) -> crate::types::RequestSpec {
    request_spec(
        url.unwrap_or(""),
        method.unwrap_or("GET"),
        headers,
        body,
        options,
    )
}

/// 通知真实性判定（纯函数）：只有拿到真实 HTTP 2xx 才算发送成功。
/// 返回 `(sent, 未发送原因)`；500 / 超时 / 网络错误 / 中断一律不算发送。
pub fn classify_notify(
    status: Option<i64>,
    error: Option<&str>,
    aborted: bool,
) -> (bool, Option<String>) {
    let sent = matches!(status, Some(code) if (200..300).contains(&code))
        && error.is_none()
        && !aborted;
    if sent {
        return (true, None);
    }
    let reason = match error {
        Some(text) => text.to_string(),
        None if aborted => "通知请求被中断".to_string(),
        None => match status {
            Some(code) => format!("通知返回 HTTP {code}"),
            None => "通知没有拿到响应".to_string(),
        },
    };
    (false, Some(reason))
}

/// 传输层执行结果（正式执行与测试台共用）。`headers_json` 保留原始 JSON 字符串，
/// 便于直接落库；需要解析后的 map 时另行反序列化。
#[derive(Debug, Clone)]
pub struct ExecutedRequest {
    pub status: Option<i64>,
    pub headers_json: Option<String>,
    pub body: String,
    pub truncated: bool,
    pub error: Option<String>,
    pub aborted: bool,
    pub duration_ms: i64,
}

fn env_proxy_snapshot() -> BTreeMap<String, String> {
    let mut snapshot = BTreeMap::new();
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                snapshot.insert(key.to_string(), value);
            }
        }
    }
    snapshot
}

fn clear_env_proxy() {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::remove_var(key);
    }
}

fn restore_env_proxy(snapshot: &BTreeMap<String, String>) {
    for (key, value) in snapshot {
        std::env::set_var(key, value);
    }
}

/// 展开错误链：reqwest 的顶层信息只有「error sending request」，
/// 底层原因（DNS / TCP / TLS / 代理）在 source 里，逐层拼上便于排查。
fn error_text(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !message.contains(&text) {
            message.push_str("：");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

fn build_client(
    options: &RequestOptions,
    default_insecure: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder();
    if matches!(options.redirect, Some(crate::types::RedirectMode::Manual)) {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    } else {
        builder = builder.redirect(reqwest::redirect::Policy::limited(10));
    }
    // 任务级 -k 优先；未指定时跟随全局「默认跳过 TLS 校验」设置（默认开）。
    if options.insecure.unwrap_or(default_insecure) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    if let Some(proxy) = &options.proxy {
        let mut proxy = reqwest::Proxy::all(proxy).map_err(|error| error.to_string())?;
        if let Some(authorization) = &options.proxy_authorization {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(authorization) {
                proxy = proxy.custom_http_auth(value);
            }
        }
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| error.to_string())
}

fn describe_error(error: &str, aborted: bool) -> String {
    if aborted {
        return "请求已中断".to_string();
    }
    error.to_string()
}

/// 判断错误是不是「连接被重置」这一类传输层失败。
///
/// 长间隔任务（每天一次的通知）经常撞上服务端把空闲 keep-alive 连接悄悄关掉：
/// 下一次请求写进半关闭的 socket，响应头还没到就被重置。
/// 只有这一类错误才值得重试——DNS / TLS / HTTP 状态码 / 正文错误都不是传输层抖动，
/// 重试它们只会把一次失败放大成多次。
fn is_connection_reset_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    // 超时是另一回事（由调用方的超时预算负责），不当作重置。
    if lower.contains("timed out") || lower.contains("timeout") || lower.contains("etimedout") {
        return false;
    }
    lower.contains("connection reset")
        || lower.contains("econnreset")
        || lower.contains("epipe")
        || lower.contains("connection closed before message completed")
        || lower.contains("socket connection was closed unexpectedly")
}

/// 0–79ms 的抖动：多个任务同时撞上重置时不要一起重试。
fn retry_jitter_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos() as u64)
        .unwrap_or(0)
        % 80
}

#[allow(clippy::too_many_arguments)]
async fn perform_request(
    url: &str,
    method: &str,
    raw_headers: Option<&str>,
    body: Option<&str>,
    cancel: &CancellationToken,
    options: &RequestOptions,
    default_timeout_ms: i64,
    body_limit: usize,
    default_insecure: bool,
) -> ExecutedRequest {
    let started = Instant::now();
    let mut status: Option<i64> = None;
    let mut headers_json: Option<String> = None;
    let mut response_body = String::new();
    let mut truncated = false;
    let mut error: Option<String> = None;
    let mut aborted = false;

    let timeout_ms = options.timeout_ms.unwrap_or(default_timeout_ms);
    let headers = parse_stored_headers(raw_headers).unwrap_or(None);

    // 环境代理探测：用户显式配置的代理绝不改写。
    let env_proxy = if options.proxy.is_none() {
        env_proxy_snapshot()
    } else {
        BTreeMap::new()
    };
    let has_env_proxy = !env_proxy.is_empty();
    let first_timeout_ms =
        if has_env_proxy && (timeout_ms <= 0 || timeout_ms > PROXY_PROBE_TIMEOUT_MS as i64) {
            PROXY_PROBE_TIMEOUT_MS as i64
        } else {
            timeout_ms
        };

    let mut caught: Option<String> = None;
    let mut did_proxy_fallback = false;
    let mut last_timeout_ms = first_timeout_ms;

    'rounds: for round in 0..2usize {
        if cancel.is_cancelled() {
            break;
        }
        let active_timeout_ms = if round == 0 {
            first_timeout_ms
        } else {
            timeout_ms
        };
        last_timeout_ms = active_timeout_ms;
        status = None;
        headers_json = None;
        response_body = String::new();
        truncated = false;
        aborted = false;

        let client = match build_client(options, default_insecure) {
            Ok(client) => client,
            Err(message) => {
                caught = Some(message);
                break;
            }
        };
        // 每次重试都要重建请求（RequestBuilder 不能克隆），
        // 所以把「组装请求」做成一个闭包，重试时带上 Connection: close。
        let build_request = |close: bool| {
            let mut request = client.request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
                url,
            );
            if let Some(map) = &headers {
                for (name, value) in map {
                    if let (Ok(name), Ok(value)) = (
                        reqwest::header::HeaderName::try_from(name.as_str()),
                        reqwest::header::HeaderValue::from_str(value.as_str().unwrap_or_default()),
                    ) {
                        request = request.header(name, value);
                    }
                }
            }
            if let Some(text) = body {
                request = request.body(text.to_string());
            }
            if close {
                // 重试带 Connection: close，避免复用半关闭的 keep-alive 连接。
                request = request.header(reqwest::header::CONNECTION, "close");
            }
            request
        };

        let timeout_duration = if active_timeout_ms > 0 {
            Some(Duration::from_millis(active_timeout_ms as u64))
        } else {
            None
        };

        let attempt = async {
            // 传输层重试：只对「连接被重置」这一类错误，
            // 且只发生在响应头到达之前（读正文失败不重试）。
            let mut send_attempt = 0usize;
            let response = loop {
                let builder = build_request(round > 0 || send_attempt > 0);
                match builder.send().await {
                    Ok(response) => break response,
                    Err(error) => {
                        let message = error_text(&error);
                        if send_attempt >= FETCH_RESET_RETRIES
                            || !is_connection_reset_error(&message)
                        {
                            return Err(message);
                        }
                        send_attempt += 1;
                        // 小幅抖动退避；等待可被中断，停止/超时仍然灵敏。
                        let delay = FETCH_RETRY_BASE_DELAY_MS * send_attempt as u64
                            + retry_jitter_ms();
                        tracing::warn!(
                            "[jitter] 连接被重置，{delay} ms 后重试（第 {send_attempt} 次）"
                        );
                        tokio::select! {
                            _ = cancel.cancelled() => return Err("cancelled".to_string()),
                            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                        }
                    }
                }
            };
            let status_value = response.status().as_u16() as i64;
            let mut header_map = JsonMap::new();
            for (name, value) in response.headers() {
                if let Ok(text) = value.to_str() {
                    header_map.insert(name.to_string(), Json::String(text.to_string()));
                }
            }
            let headers_json_value = Json::Object(header_map).to_string();

            // 按上限读正文，超出即截断并断开。
            let mut buffer: Vec<u8> = Vec::new();
            let mut stream = response.bytes_stream();
            let mut is_truncated = false;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| error_text(&error))?;
                let remaining = body_limit.saturating_sub(buffer.len());
                if chunk.len() > remaining {
                    if remaining > 0 {
                        buffer.extend_from_slice(&chunk[..remaining]);
                    }
                    is_truncated = true;
                    break;
                }
                buffer.extend_from_slice(&chunk);
            }
            Ok::<_, String>((
                status_value,
                headers_json_value,
                String::from_utf8_lossy(&buffer).to_string(),
                is_truncated,
            ))
        };

        let outcome = tokio::select! {
            _ = cancel.cancelled() => Err("cancelled".to_string()),
            result = async {
                match timeout_duration {
                    Some(duration) => match tokio::time::timeout(duration, attempt).await {
                        Ok(inner) => inner,
                        Err(_) => Err(format!("timeout after {} ms", active_timeout_ms)),
                    },
                    None => attempt.await,
                }
            } => result,
        };

        match outcome {
            Ok((status_value, headers_value, text, is_truncated)) => {
                status = Some(status_value);
                headers_json = Some(headers_value);
                response_body = text;
                truncated = is_truncated;
                caught = None;
                break 'rounds;
            }
            Err(message) => {
                if message == "cancelled" {
                    aborted = true;
                    caught = Some("请求已中断".to_string());
                    break 'rounds;
                }
                caught = Some(message.clone());
                let caller_aborted = cancel.is_cancelled();
                // 环境代理是 best-effort：只要第一轮没拿到响应就回退直连——
                // 代理被关掉时是「连接被拒」而不是超时，同样必须回退
                //（与 TS 版 withProxyFallback 对齐；用户显式 -x 的代理不走这里）。
                let can_fallback =
                    round == 0 && has_env_proxy && !caller_aborted && status.is_none();
                if can_fallback {
                    clear_env_proxy();
                    did_proxy_fallback = true;
                    tracing::warn!("[jitter] 环境代理探测超时，已清除失效代理并改用直连重试");
                    continue 'rounds;
                }
                break 'rounds;
            }
        }
    }

    // 直连重试也失败说明环境代理还是需要的：放回去。
    if did_proxy_fallback && status.is_none() && caught.is_some() {
        restore_env_proxy(&env_proxy);
    }

    if let Some(message) = &caught {
        error = if looks_like_timeout(message) {
            Some(format!("请求超时（{last_timeout_ms} ms）"))
        } else {
            Some(describe_error(message, aborted))
        };
    }

    ExecutedRequest {
        status,
        headers_json,
        body: response_body,
        truncated,
        error,
        aborted,
        duration_ms: started.elapsed().as_millis() as i64,
    }
}

/// 走正式传输链路发送一个 `RequestSpec`：正式执行（`timeout_cap = None`，
/// 跟随全局超时）与测试台（`timeout_cap = Some(TEST_REQUEST_TIMEOUT_MS)`）共用。
/// TLS 行为保持现状：任务级 `-k`（`options.insecure`）优先，未指定时跟随
/// 全局「默认跳过 TLS 校验」开关（`db::get_skip_tls_verify`）。
pub async fn execute_request(
    request: &crate::types::RequestSpec,
    cancel: &CancellationToken,
    timeout_cap: Option<i64>,
) -> ExecutedRequest {
    let config = get_active_config();
    let mut options = request.options.clone().unwrap_or_default();
    if let Some(cap) = timeout_cap {
        if options.timeout_ms.is_none() {
            options.timeout_ms = Some(cap);
        }
    }
    let headers_text = Json::Object(request.headers.clone()).to_string();
    perform_request(
        &request.url,
        &request.method,
        Some(&headers_text),
        request.body.as_deref(),
        cancel,
        &options,
        config.request_timeout_ms,
        config.log_body_limit_bytes,
        crate::db::get_skip_tls_verify(),
    )
    .await
}

/// 一次性探测请求：与正式执行同一条传输链路，但不写库。
#[derive(Debug, Clone, serde::Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestRequestOutcome {
    pub status: Option<i64>,
    pub headers: Option<JsonMap<String, Json>>,
    pub body: String,
    pub truncated: bool,
    pub error: Option<String>,
    pub aborted: bool,
    pub duration_ms: i64,
}

pub async fn execute_test_request(request: &crate::types::RequestSpec) -> TestRequestOutcome {
    let result =
        execute_request(request, &CancellationToken::new(), Some(TEST_REQUEST_TIMEOUT_MS)).await;
    let headers = result
        .headers_json
        .and_then(|text| serde_json::from_str::<JsonMap<String, Json>>(&text).ok());
    TestRequestOutcome {
        status: result.status,
        headers,
        body: result.body,
        truncated: result.truncated,
        error: result.error,
        aborted: result.aborted,
        duration_ms: result.duration_ms,
    }
}

struct SkipExchange {
    request_url: Option<String>,
    request_method: Option<String>,
    request_headers: Option<String>,
    request_body: Option<String>,
    status: Option<i64>,
    headers_json: Option<String>,
    body: String,
    truncated: bool,
    aborted: bool,
    duration_ms: i64,
}

/// 一条解释「为什么跳过」的日志。写库失败不再 panic：返回 Err 由调用方
/// 把原因并进 outcome.error（此时 main_log_id 记 0）。
fn record_skip(
    task: &TaskRow,
    reason: &str,
    exchange: Option<&SkipExchange>,
    source: crate::types::RunSource,
) -> Result<i64, String> {
    let stored_body = exchange.and_then(|exchange| {
        exchange.status.map(|_| {
            if exchange.truncated {
                format!("{}\n[truncated]", exchange.body)
            } else {
                exchange.body.clone()
            }
        })
    });
    insert_log(&NewLogInput {
        task_id: task.id.clone(),
        executed_at: now_ms(),
        request_url: exchange
            .map(|exchange| exchange.request_url.clone())
            .flatten(),
        request_method: exchange
            .map(|exchange| exchange.request_method.clone())
            .flatten(),
        request_headers: exchange
            .map(|exchange| exchange.request_headers.clone())
            .flatten(),
        request_body: exchange
            .map(|exchange| exchange.request_body.clone())
            .flatten(),
        response_status: exchange.map(|exchange| exchange.status).flatten(),
        response_headers: exchange
            .map(|exchange| exchange.headers_json.clone())
            .flatten(),
        response_body: stored_body,
        duration_ms: Some(exchange.map(|exchange| exchange.duration_ms).unwrap_or(0)),
        error: Some(format!(
            "{reason}；已跳过主请求 {} {}",
            task.request_method, task.request_url
        )),
        aborted: exchange
            .map(|exchange| exchange.aborted)
            .unwrap_or(false)
            .into(),
        kind: Some(crate::types::LogKind::Skipped),
        parent_log_id: None,
        matched: Some(0),
        run_source: Some(source.as_str().to_string()),
    })
    .map_err(|error| format!("写入跳过日志失败：{error}"))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 一次完整执行的结果。
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// 主日志 id；0 = 日志写入失败（错误已并入 `error`），调用方按 0 处理即可。
    pub main_log_id: i64,
    pub status: Option<i64>,
    pub aborted: bool,
    pub matched: bool,
    /// 前置判断未通过，主请求没有发送。
    pub skipped: bool,
    pub error: Option<String>,
    pub notify_log_id: Option<i64>,
    /// 通知真实发送成功（拿到 HTTP 2xx）。500 / 超时 / 网络错误一律 false。
    pub notify_sent: bool,
    /// 通知请求拿到的 HTTP 状态码（没有响应为 None）。
    pub notify_status: Option<i64>,
    /// 通知未发送成功的原因（发送成功为 None）；含日志写入失败。
    pub notify_error: Option<String>,
    pub duration_ms: i64,
}

/// 跳过分支的 RunOutcome：日志写入失败也不 panic，把原因并进 error。
fn skipped_outcome(
    log_result: Result<i64, String>,
    reason: &str,
    status: Option<i64>,
    aborted: bool,
    duration_ms: i64,
) -> RunOutcome {
    let (main_log_id, error) = match log_result {
        Ok(id) => (id, reason.to_string()),
        Err(db_error) => (0, format!("{reason}；{db_error}")),
    };
    RunOutcome {
        main_log_id,
        status,
        aborted,
        matched: false,
        skipped: true,
        error: Some(error),
        notify_log_id: None,
        notify_sent: false,
        notify_status: None,
        notify_error: None,
        duration_ms,
    }
}

/// 执行一个任务：前置判断 → 主请求 → 判定 → 命中则通知。
///
/// 所有日志写入都不 panic：写库失败时 `main_log_id` 记 0、原因并入 `error`，
/// 通知日志写失败则原因并入 `notify_error`。
pub async fn execute_task_run(
    task: &TaskRow,
    cancel: &CancellationToken,
    source: crate::types::RunSource,
) -> RunOutcome {
    // 前置判断约束定时与开机自动执行：页面「立即执行」是人工触发，跳过所有前置条件。
    // 本地条件零成本；电源 / IP 读本机信息；guard curl 只在配置了的情况下才发。
    if task.precheck_enabled == 1 && !matches!(source, crate::types::RunSource::Manual) {
        let guard_config = local_guard_of(
            task.precheck_weekdays.as_deref(),
            task.precheck_time_start.as_deref(),
            task.precheck_time_end.as_deref(),
            task.precheck_day_type.as_deref(),
        );
        let verdict = evaluate_local_guard(&guard_config, now_ms());
        if !verdict.passed {
            tracing::warn!(
                "[jitter] 任务「{}」跳过本次执行：{}",
                task.name,
                verdict.reason
            );
            return skipped_outcome(
                record_skip(task, &verdict.reason, None, source),
                &verdict.reason,
                None,
                false,
                0,
            );
        }

        let host_config = HostGuardConfig {
            require_ac_power: task.precheck_require_ac == 1,
            require_network: task.precheck_require_network == 1,
            ip_pattern: task.precheck_ip_pattern.clone(),
        };
        if has_host_conditions(&host_config) {
            let environment = host::current_environment();
            let verdict = evaluate_host_guard(
                &host_config,
                environment.on_ac_power,
                &environment.local_ips,
                &environment.networks,
            );
            if !verdict.passed {
                tracing::warn!(
                    "[jitter] 任务「{}」跳过本次执行：{}",
                    task.name,
                    verdict.reason
                );
                return skipped_outcome(
                    record_skip(task, &verdict.reason, None, source),
                    &verdict.reason,
                    None,
                    false,
                    0,
                );
            }
        }

        if let Some(precheck_url) = &task.precheck_url {
            let precheck = run_precheck(task, cancel).await;
            if !precheck.verdict.passed {
                let reason = precheck.verdict.reason.clone();
                tracing::warn!("[jitter] 任务「{}」跳过本次执行：{}", task.name, reason);
                return skipped_outcome(
                    record_skip(
                        task,
                        &reason,
                        Some(&SkipExchange {
                            request_url: Some(precheck_url.clone()),
                            request_method: Some(
                                task.precheck_method
                                    .clone()
                                    .unwrap_or_else(|| "GET".to_string()),
                            ),
                            request_headers: task.precheck_headers.clone(),
                            request_body: task.precheck_body.clone(),
                            status: precheck.status,
                            headers_json: precheck.headers_json,
                            body: precheck.body,
                            truncated: precheck.truncated,
                            aborted: precheck.aborted,
                            duration_ms: precheck.duration_ms,
                        }),
                        source,
                    ),
                    &reason,
                    precheck.status,
                    precheck.aborted,
                    precheck.duration_ms,
                );
            }
        }
    }

    // 与测试台共用同一条构造 + 执行链路（request_spec / execute_request）。
    let main_spec = request_spec(
        &task.request_url,
        &task.request_method,
        task.request_headers.as_deref(),
        task.request_body.as_deref(),
        task.request_options.as_deref(),
    );
    let main_executed_at = now_ms();
    let main = execute_request(&main_spec, cancel, None).await;

    let matched = evaluate_success(&SuccessInput {
        status: main.status,
        body: Some(&main.body),
        truncated: main.truncated,
        aborted: main.aborted,
        error: main.error.as_deref(),
        expect_status: task.expect_status,
        expect_body: task.expect_body.as_deref(),
        expect_expr: task.expect_expr.as_deref(),
    });

    let stored_body = match main.status {
        None => None,
        Some(_) if main.truncated => Some(format!("{}\n[truncated]", main.body)),
        Some(_) => Some(main.body.clone()),
    };

    let main_log_id = match insert_log(&NewLogInput {
        task_id: task.id.clone(),
        executed_at: main_executed_at,
        request_url: Some(task.request_url.clone()),
        request_method: Some(task.request_method.clone()),
        request_headers: task.request_headers.clone(),
        request_body: task.request_body.clone(),
        response_status: main.status,
        response_headers: main.headers_json.clone(),
        response_body: stored_body,
        duration_ms: Some(main.duration_ms),
        error: main.error.clone(),
        aborted: main.aborted.into(),
        kind: Some(crate::types::LogKind::Task),
        parent_log_id: None,
        matched: Some(if matched { 1 } else { 0 }),
        run_source: Some(source.as_str().to_string()),
    }) {
        Ok(id) => id,
        Err(db_error) => {
            // 主日志写不进去就不发通知（通知日志失去 parent），把两个错误并起来返回。
            let db_error = format!("写入执行日志失败：{db_error}");
            tracing::error!("[jitter] 任务「{}」：{}", task.name, db_error);
            let error = Some(match main.error.as_ref() {
                Some(text) => format!("{text}；{db_error}"),
                None => db_error,
            });
            return RunOutcome {
                main_log_id: 0,
                status: main.status,
                aborted: main.aborted,
                matched,
                skipped: false,
                error,
                notify_log_id: None,
                notify_sent: false,
                notify_status: None,
                notify_error: None,
                duration_ms: main.duration_ms,
            };
        }
    };

    let mut notify_log_id: Option<i64> = None;
    let mut notify_sent = false;
    let mut notify_status: Option<i64> = None;
    let mut notify_error: Option<String> = None;
    if matched && task.notify_enabled == 1 && task.notify_url.is_some() && !cancel.is_cancelled() {
        let notify_executed_at = now_ms();
        let notify_spec = request_spec_of(
            task.notify_url.as_deref(),
            task.notify_method.as_deref(),
            task.notify_headers.as_deref(),
            task.notify_body.as_deref(),
            task.notify_options.as_deref(),
        );
        let notify = execute_request(&notify_spec, cancel, None).await;
        let (sent, reason) =
            classify_notify(notify.status, notify.error.as_deref(), notify.aborted);
        notify_sent = sent;
        notify_status = notify.status;
        notify_error = reason;
        let notify_body = match notify.status {
            None => None,
            Some(_) if notify.truncated => Some(format!("{}\n[truncated]", notify.body)),
            Some(_) => Some(notify.body.clone()),
        };
        match insert_log(&NewLogInput {
            task_id: task.id.clone(),
            executed_at: notify_executed_at,
            request_url: task.notify_url.clone(),
            request_method: Some(
                task.notify_method
                    .clone()
                    .unwrap_or_else(|| "GET".to_string()),
            ),
            request_headers: task.notify_headers.clone(),
            request_body: task.notify_body.clone(),
            response_status: notify.status,
            response_headers: notify.headers_json.clone(),
            response_body: notify_body,
            duration_ms: Some(notify.duration_ms),
            error: notify.error.clone(),
            aborted: notify.aborted.into(),
            kind: Some(crate::types::LogKind::Notify),
            parent_log_id: Some(main_log_id),
            matched: None,
            run_source: Some(source.as_str().to_string()),
        }) {
            Ok(id) => notify_log_id = Some(id),
            Err(db_error) => {
                let db_error = format!("写入通知日志失败：{db_error}");
                tracing::error!("[jitter] 任务「{}」：{}", task.name, db_error);
                notify_error = Some(match notify_error.take() {
                    Some(text) => format!("{text}；{db_error}"),
                    None => db_error,
                });
            }
        }
    }

    RunOutcome {
        main_log_id,
        status: main.status,
        aborted: main.aborted,
        matched,
        skipped: false,
        error: main.error,
        notify_log_id,
        notify_sent,
        notify_status,
        notify_error,
        duration_ms: main.duration_ms,
    }
}

struct PrecheckRun {
    verdict: PrecheckVerdict,
    status: Option<i64>,
    headers_json: Option<String>,
    body: String,
    truncated: bool,
    aborted: bool,
    duration_ms: i64,
}

/// 前置 curl：与正常执行完全相同的构造 + 传输链路（request_spec / execute_request）。
async fn run_precheck(task: &TaskRow, cancel: &CancellationToken) -> PrecheckRun {
    let spec = request_spec_of(
        task.precheck_url.as_deref(),
        task.precheck_method.as_deref(),
        task.precheck_headers.as_deref(),
        task.precheck_body.as_deref(),
        task.precheck_options.as_deref(),
    );
    let result = execute_request(&spec, cancel, None).await;
    let verdict = evaluate_precheck(&PrecheckInput {
        status: result.status,
        body: Some(&result.body),
        truncated: result.truncated,
        aborted: result.aborted,
        error: result.error.as_deref(),
        expect_status: task.precheck_expect_status,
        expect_expr: task.precheck_expr.as_deref(),
    });
    PrecheckRun {
        verdict,
        status: result.status,
        headers_json: result.headers_json,
        body: result.body,
        truncated: result.truncated,
        aborted: result.aborted,
        duration_ms: result.duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_connection_reset_failures() {
        assert!(is_connection_reset_error(
            "error sending request for url (https://x/): connection reset by peer"
        ));
        assert!(is_connection_reset_error("ECONNRESET"));
        assert!(is_connection_reset_error("EPIPE"));
        assert!(is_connection_reset_error(
            "connection closed before message completed"
        ));
        assert!(is_connection_reset_error(
            "socket connection was closed unexpectedly"
        ));
    }

    #[test]
    fn does_not_retry_other_failures() {
        // 超时不是重置：交给超时预算处理，不要重复打请求。
        assert!(!is_connection_reset_error("operation timed out"));
        assert!(!is_connection_reset_error("timeout after 30000 ms"));
        assert!(!is_connection_reset_error("ETIMEDOUT"));
        // DNS / TLS / 普通错误都不重试。
        assert!(!is_connection_reset_error(
            "dns error: failed to lookup address"
        ));
        assert!(!is_connection_reset_error("certificate verify failed"));
        assert!(!is_connection_reset_error(""));
    }

    #[test]
    fn retry_jitter_stays_in_range() {
        for _ in 0..50 {
            assert!(retry_jitter_ms() < 80);
        }
    }

    #[test]
    fn classify_notify_only_accepts_2xx() {
        // 2xx → 已发送。
        assert_eq!(classify_notify(Some(200), None, false), (true, None));
        assert_eq!(classify_notify(Some(204), None, false), (true, None));
        // 500 → 未发送，原因带状态码。
        let (sent, reason) = classify_notify(Some(500), None, false);
        assert!(!sent);
        assert!(reason.unwrap().contains("500"));
        // 网络/超时错误 → 未发送，原因是错误本身。
        let (sent, reason) = classify_notify(None, Some("请求超时（30000 ms）"), false);
        assert!(!sent);
        assert!(reason.unwrap().contains("请求超时"));
        // 中断 / 无响应。
        let (sent, _) = classify_notify(None, None, true);
        assert!(!sent);
        let (sent, reason) = classify_notify(None, None, false);
        assert!(!sent);
        assert!(reason.unwrap().contains("没有拿到响应"));
    }

    #[test]
    fn request_spec_falls_back_on_broken_data() {
        // 坏头部 JSON / 坏选项 JSON：与历史行为一致（忽略头部、回退默认选项）。
        let spec = request_spec("http://x", "GET", Some("{bad"), Some("b"), Some("{"));
        assert!(spec.headers.is_empty());
        assert_eq!(spec.body.as_deref(), Some("b"));
        assert_eq!(spec.options, Some(RequestOptions::default()));
        // 正常数据原样保留。
        let spec = request_spec(
            "http://x",
            "POST",
            Some(r#"{"A":"1"}"#),
            None,
            Some(r#"{"timeoutMs":1234,"insecure":true}"#),
        );
        assert_eq!(spec.headers["A"], Json::from("1"));
        let options = spec.options.unwrap();
        assert_eq!(options.timeout_ms, Some(1234));
        assert_eq!(options.insecure, Some(true));
    }
}
