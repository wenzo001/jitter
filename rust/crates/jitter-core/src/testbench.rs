//! 测试台：按正式执行的完整链路跑一遍（解析 → 本地条件 → 前置判断 →
//! 主请求 → 成功判定 → 通知），但作为一次性诊断，不写库。
//!
//! 与 TypeScript 版 `src/testbench.ts` 行为对齐：解析失败不抛错，
//! 而是变成时间线上的失败步骤，让页面能展示。

use serde::Serialize;
use serde_json::Value as Json;

use crate::curl_parser::{
    normalize_structured, parse_curl_command, CurlParseError, StructuredRequestInput,
};
use crate::executor::{
    self, evaluate_precheck, evaluate_success, execute_test_request, TestRequestOutcome,
};
use crate::guard::{
    self, evaluate_host_guard, evaluate_local_guard, has_host_conditions, has_local_conditions,
    HostGuardConfig, LocalGuardConfig,
};
use crate::host;
use crate::types::{JsonMap, RequestSpec};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRequest {
    pub method: String,
    pub url: String,
    pub headers: JsonMap,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStep {
    pub key: String,
    pub title: String,
    /// ok / fail / skip / info。
    pub status: String,
    pub detail: String,
    pub duration_ms: Option<i64>,
    pub request: Option<StepRequest>,
    pub response: Option<TestRequestOutcome>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestBenchSummary {
    pub matched: bool,
    pub skipped: bool,
    pub status: Option<i64>,
    pub error: Option<String>,
    pub total_ms: i64,
    pub notify_sent: bool,
    /// 真的通知已尝试发送（send_notify）且失败。
    pub notify_failed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestBenchResult {
    pub steps: Vec<TestStep>,
    pub summary: TestBenchSummary,
}

fn is_truthy(value: &Json) -> bool {
    matches!(value, Json::Bool(true))
        || value == &Json::from(1)
        || value == &Json::from("1")
        || value == &Json::from("true")
}

fn pick_str<'a>(input: &'a Json, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|value| value.as_str())
}

/// headers 字段：文本（`Name: value` 每行一条）或 JSON 对象。
enum HeadersInput {
    Lines(String),
    Map(JsonMap),
}

fn headers_input(value: Option<&Json>) -> Result<Option<HeadersInput>, String> {
    let Some(value) = value else { return Ok(None) };
    match value {
        Json::Null => Ok(None),
        Json::String(text) if text.is_empty() => Ok(None),
        Json::String(text) => Ok(Some(HeadersInput::Lines(text.clone()))),
        Json::Object(map) => {
            for (name, header_value) in map {
                if !header_value.is_string() {
                    return Err(format!("Header {name} 的值必须是字符串"));
                }
            }
            Ok(Some(HeadersInput::Map(map.clone())))
        }
        _ => Err("Headers 必须是文本或 JSON 对象".to_string()),
    }
}

/// 从前缀构造请求（`""` = 主请求，`"precheck"` / `"notify"`）。
/// curl 文本优先于结构化字段，与任务表单一致。
fn build_request(prefix: &str, input: &Json) -> Result<RequestSpec, String> {
    let curl_key = if prefix.is_empty() {
        "curl"
    } else {
        &format!("{prefix}_curl")
    };
    if let Some(raw) = pick_str(input, curl_key) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return parse_curl_command(trimmed).map_err(|error| error.0);
        }
    }
    let url_key = if prefix.is_empty() {
        "url"
    } else {
        &format!("{prefix}_url")
    };
    let url = pick_str(input, url_key)
        .unwrap_or_default()
        .trim()
        .to_string();
    if url.is_empty() {
        return Err(match prefix {
            "" => "请粘贴 curl 命令".to_string(),
            "precheck" => "请填写前置判断 curl".to_string(),
            _ => "请填写通知 curl".to_string(),
        });
    }
    let method_key = if prefix.is_empty() {
        "method"
    } else {
        &format!("{prefix}_method")
    };
    let headers_key = if prefix.is_empty() {
        "headers"
    } else {
        &format!("{prefix}_headers")
    };
    let body_key = if prefix.is_empty() {
        "body"
    } else {
        &format!("{prefix}_body")
    };

    let headers = headers_input(input.get(headers_key))?;
    let (header_map, header_lines) = match headers {
        Some(HeadersInput::Map(map)) => (Some(map), None),
        Some(HeadersInput::Lines(text)) => (None, Some(text)),
        None => (None, None),
    };
    let structured = StructuredRequestInput {
        url,
        method: pick_str(input, method_key).map(str::to_string),
        headers: header_map,
        header_lines,
        body: pick_str(input, body_key).map(str::to_string),
    };
    normalize_structured(&structured).map_err(|error: CurlParseError| error.0)
}

fn request_step_info(request: &RequestSpec) -> StepRequest {
    StepRequest {
        method: request.method.clone(),
        url: request.url.clone(),
        headers: request.headers.clone(),
        body: request.body.clone(),
    }
}

fn describe_transport(request: &RequestSpec) -> String {
    let mut extras: Vec<String> = Vec::new();
    if let Some(options) = &request.options {
        if let Some(timeout) = options.timeout_ms {
            if timeout > 0 {
                extras.push(format!("超时 {timeout} ms"));
            }
        }
        if options.insecure == Some(true) {
            extras.push("跳过 TLS 校验".to_string());
        }
        if let Some(proxy) = &options.proxy {
            if !proxy.trim().is_empty() {
                extras.push(format!("代理 {proxy}"));
            }
        }
        if options.redirect == Some(crate::types::RedirectMode::Manual) {
            extras.push("不跟随重定向".to_string());
        }
    }
    if extras.is_empty() {
        format!("{} {}", request.method, request.url)
    } else {
        format!(
            "{} {}（{}）",
            request.method,
            request.url,
            extras.join("，")
        )
    }
}

fn parse_expect_status(value: Option<&Json>) -> Result<Option<i64>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() || value == &Json::from("") {
        return Ok(None);
    }
    let parsed = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()));
    match parsed {
        Some(status) if (100..=599).contains(&status) => Ok(Some(status)),
        _ => Err("期望状态码必须是 100–599 的整数".to_string()),
    }
}

fn parse_expect_body(value: Option<&Json>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let Some(text) = value.as_str() else {
        return Err("期望响应体必须是字符串".to_string());
    };
    Ok(if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    })
}

fn parse_expect_expr(value: Option<&Json>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let Some(text) = value.as_str() else {
        return Err(format!("{label}必须是字符串"));
    };
    let trimmed = text.trim();
    Ok(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    })
}

fn failure_step(key: &str, title: &str, detail: String, started: i64) -> TestStep {
    TestStep {
        key: key.to_string(),
        title: title.to_string(),
        status: "fail".to_string(),
        detail,
        duration_ms: Some((executor::now_ms() - started).max(0)),
        request: None,
        response: None,
    }
}

fn response_step(
    key: &str,
    title: &str,
    request: &RequestSpec,
    response: &TestRequestOutcome,
    started: i64,
) -> TestStep {
    let failed = response.error.is_some() || response.aborted || response.status.is_none();
    let detail = if let Some(status) = response.status {
        let truncated = if response.truncated {
            " · 响应体已截断"
        } else {
            ""
        };
        format!("HTTP {status} · {} ms{truncated}", response.duration_ms)
    } else if response.aborted {
        "请求已中断".to_string()
    } else {
        response
            .error
            .clone()
            .unwrap_or_else(|| "没有拿到响应".to_string())
    };
    TestStep {
        key: key.to_string(),
        title: title.to_string(),
        status: if failed { "fail" } else { "ok" }.to_string(),
        detail,
        duration_ms: Some((executor::now_ms() - started).max(0)),
        request: Some(request_step_info(request)),
        response: Some(response.clone()),
    }
}

fn skip_main_step(request: &RequestSpec, detail: &str) -> TestStep {
    TestStep {
        key: "main".to_string(),
        title: "主请求".to_string(),
        status: "skip".to_string(),
        detail: detail.to_string(),
        duration_ms: None,
        request: Some(request_step_info(request)),
        response: None,
    }
}

/// 完整跑一遍链路。请求构造失败也以失败步骤返回，不抛错。
pub async fn run_test_bench(input: &Json) -> TestBenchResult {
    let started_at = executor::now_ms();
    let mut steps: Vec<TestStep> = Vec::new();
    let mut summary = TestBenchSummary::default();

    // 1) 解析主请求。
    let parse_started = executor::now_ms();
    let main = match build_request("", input) {
        Ok(spec) => {
            steps.push(TestStep {
                key: "parse".to_string(),
                title: "解析 curl".to_string(),
                status: "ok".to_string(),
                detail: describe_transport(&spec),
                duration_ms: Some((executor::now_ms() - parse_started).max(0)),
                request: Some(request_step_info(&spec)),
                response: None,
            });
            spec
        }
        Err(message) => {
            steps.push(failure_step(
                "parse",
                "解析 curl",
                message.clone(),
                parse_started,
            ));
            summary.error = Some(message);
            summary.total_ms = (executor::now_ms() - started_at).max(0);
            return TestBenchResult { steps, summary };
        }
    };

    // 2) 可选判断：本地条件（不发请求）在前，前置 curl 在后。
    let expect_status = match parse_expect_status(input.get("expect_status")) {
        Ok(value) => value,
        Err(message) => return assert_input_failed(steps, summary, started_at, message),
    };
    let expect_body = match parse_expect_body(input.get("expect_body")) {
        Ok(value) => value,
        Err(message) => return assert_input_failed(steps, summary, started_at, message),
    };
    let expect_expr = match parse_expect_expr(input.get("expect_expr"), "条件表达式") {
        Ok(value) => value,
        Err(message) => return assert_input_failed(steps, summary, started_at, message),
    };
    let precheck_expect_status = match parse_expect_status(input.get("precheck_expect_status")) {
        Ok(value) => value,
        Err(message) => return assert_input_failed(steps, summary, started_at, message),
    };
    let precheck_expr = match parse_expect_expr(input.get("precheck_expr"), "前置条件表达式")
    {
        Ok(value) => value,
        Err(message) => return assert_input_failed(steps, summary, started_at, message),
    };

    let weekdays = match guard::parse_weekdays(input.get("precheck_weekdays")) {
        Ok(value) => value,
        Err(error) => return assert_input_failed(steps, summary, started_at, error.0),
    };
    let time_range = match guard::parse_time_range(
        input.get("precheck_time_start"),
        input.get("precheck_time_end"),
    ) {
        Ok(value) => value,
        Err(error) => return assert_input_failed(steps, summary, started_at, error.0),
    };
    let local_config = LocalGuardConfig {
        weekdays,
        time_start: time_range.as_ref().map(|(start, _)| start.clone()),
        time_end: time_range.as_ref().map(|(_, end)| end.clone()),
    };
    let require_ac = input
        .get("precheck_require_ac")
        .map(is_truthy)
        .unwrap_or(false);
    let ip_pattern = match guard::parse_ip_pattern(input.get("precheck_ip_pattern")) {
        Ok(value) => value,
        Err(error) => return assert_input_failed(steps, summary, started_at, error.0),
    };
    let host_config = HostGuardConfig {
        require_ac_power: require_ac,
        ip_pattern,
    };

    let guard_on = input
        .get("precheck_enabled")
        .map(is_truthy)
        .unwrap_or(false);
    let precheck_curl = pick_str(input, "precheck_curl")
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let has_guard_curl = precheck_curl.is_some();

    if guard_on
        && !has_local_conditions(&local_config)
        && !has_host_conditions(&host_config)
        && !has_guard_curl
    {
        let message =
            "已启用执行前判断，但没有配置本地条件、电源 / 本机 IP 条件或前置 curl".to_string();
        steps.push(failure_step(
            "precheck",
            "执行前判断",
            message.clone(),
            executor::now_ms(),
        ));
        summary.error = Some(message);
        summary.total_ms = (executor::now_ms() - started_at).max(0);
        return TestBenchResult { steps, summary };
    }

    if guard_on && has_local_conditions(&local_config) {
        let local_started = executor::now_ms();
        let verdict = evaluate_local_guard(&local_config, executor::now_ms());
        steps.push(TestStep {
            key: "local".to_string(),
            title: "本地条件".to_string(),
            status: if verdict.passed { "ok" } else { "fail" }.to_string(),
            detail: verdict.reason.clone(),
            duration_ms: Some((executor::now_ms() - local_started).max(0)),
            request: None,
            response: None,
        });
        if !verdict.passed {
            summary.skipped = true;
            summary.error = Some(verdict.reason);
            steps.push(skip_main_step(&main, "本地条件不满足，本次不会发送主请求"));
            summary.total_ms = (executor::now_ms() - started_at).max(0);
            return TestBenchResult { steps, summary };
        }
    }

    if guard_on && has_host_conditions(&host_config) {
        let host_started = executor::now_ms();
        let environment = host::current_environment();
        let verdict = evaluate_host_guard(
            &host_config,
            environment.on_ac_power,
            &environment.local_ips,
        );
        steps.push(TestStep {
            key: "env".to_string(),
            title: "电源 / 本机 IP 条件".to_string(),
            status: if verdict.passed { "ok" } else { "fail" }.to_string(),
            detail: verdict.reason.clone(),
            duration_ms: Some((executor::now_ms() - host_started).max(0)),
            request: None,
            response: None,
        });
        if !verdict.passed {
            summary.skipped = true;
            summary.error = Some(verdict.reason);
            steps.push(skip_main_step(
                &main,
                "电源 / 本机 IP 条件不满足，本次不会发送主请求",
            ));
            summary.total_ms = (executor::now_ms() - started_at).max(0);
            return TestBenchResult { steps, summary };
        }
    }

    if guard_on && has_guard_curl {
        let guard_started = executor::now_ms();
        let guard_request = match build_request("precheck", input) {
            Ok(spec) => spec,
            Err(message) => {
                steps.push(failure_step(
                    "precheck",
                    "前置判断",
                    message.clone(),
                    guard_started,
                ));
                summary.error = Some(message);
                summary.total_ms = (executor::now_ms() - started_at).max(0);
                return TestBenchResult { steps, summary };
            }
        };
        let guard_response = execute_test_request(&guard_request).await;
        let verdict = evaluate_precheck(&crate::executor::PrecheckInput {
            status: guard_response.status,
            body: Some(guard_response.body.as_str()),
            truncated: guard_response.truncated,
            aborted: guard_response.aborted,
            error: guard_response.error.as_deref(),
            expect_status: precheck_expect_status,
            expect_expr: precheck_expr.as_deref(),
        });
        summary.status = guard_response.status;
        steps.push(TestStep {
            key: "precheck".to_string(),
            title: "前置判断".to_string(),
            status: if verdict.passed { "ok" } else { "fail" }.to_string(),
            detail: verdict.reason.clone(),
            duration_ms: Some((executor::now_ms() - guard_started).max(0)),
            request: Some(request_step_info(&guard_request)),
            response: Some(guard_response),
        });
        if !verdict.passed {
            summary.skipped = true;
            summary.error = Some(verdict.reason);
            steps.push(skip_main_step(&main, "前置条件不满足，本次不会发送主请求"));
            summary.total_ms = (executor::now_ms() - started_at).max(0);
            return TestBenchResult { steps, summary };
        }
    }

    // 3) 主请求。
    let main_started = executor::now_ms();
    let main_response = execute_test_request(&main).await;
    steps.push(response_step(
        "main",
        "主请求",
        &main,
        &main_response,
        main_started,
    ));
    summary.status = main_response.status;
    summary.error = main_response.error.clone();

    // 4) 成功判定。
    let matched = evaluate_success(&crate::executor::SuccessInput {
        status: main_response.status,
        body: Some(main_response.body.as_str()),
        truncated: main_response.truncated,
        aborted: main_response.aborted,
        error: main_response.error.as_deref(),
        expect_status,
        expect_body: expect_body.as_deref(),
        expect_expr: expect_expr.as_deref(),
    });
    summary.matched = matched;

    let mut conditions: Vec<String> = Vec::new();
    if let Some(status) = expect_status {
        conditions.push(format!("状态码 = {status}"));
    }
    if expect_body.is_some() {
        conditions.push("响应体完全相等".to_string());
    }
    if let Some(expr) = &expect_expr {
        conditions.push(format!("表达式 {expr}"));
    }
    if conditions.is_empty() && main_response.status.is_some() {
        conditions.push("任意 2xx".to_string());
    }
    steps.push(TestStep {
        key: "assert".to_string(),
        title: "成功条件判定".to_string(),
        status: if matched { "ok" } else { "fail" }.to_string(),
        detail: if conditions.is_empty() {
            "没有可判定的响应".to_string()
        } else {
            format!(
                "{} → {}",
                conditions.join(" 且 "),
                if matched { "命中" } else { "未命中" }
            )
        },
        duration_ms: None,
        request: None,
        response: None,
    });

    // 5) 通知（只在任务确实会发送时演练）。
    let notify_enabled = input.get("notify_enabled").map(is_truthy).unwrap_or(false);
    if notify_enabled {
        let notify_started = executor::now_ms();
        if !matched {
            steps.push(TestStep {
                key: "notify".to_string(),
                title: "发送通知".to_string(),
                status: "skip".to_string(),
                detail: "未命中成功条件，正式运行时不会发送通知".to_string(),
                duration_ms: None,
                request: None,
                response: None,
            });
        } else if !input.get("send_notify").map(is_truthy).unwrap_or(false) {
            let (request, detail) = match build_request("notify", input) {
                Ok(preview) => (
                    Some(request_step_info(&preview)),
                    format!(
                        "演练模式：将发送 {}，但没有真正发出",
                        describe_transport(&preview)
                    ),
                ),
                Err(message) => (None, format!("通知配置无效：{message}")),
            };
            steps.push(TestStep {
                key: "notify".to_string(),
                title: "发送通知".to_string(),
                status: "skip".to_string(),
                detail,
                duration_ms: None,
                request,
                response: None,
            });
        } else {
            match build_request("notify", input) {
                Ok(notify) => {
                    let notify_response = execute_test_request(&notify).await;
                    steps.push(response_step(
                        "notify",
                        "发送通知",
                        &notify,
                        &notify_response,
                        notify_started,
                    ));
                    summary.notify_sent =
                        notify_response.status.is_some() && notify_response.error.is_none();
                    if !summary.notify_sent {
                        summary.notify_failed = true;
                        if summary.error.is_none() {
                            summary.error = notify_response.error.clone();
                        }
                    }
                }
                Err(message) => {
                    summary.notify_failed = true;
                    steps.push(failure_step("notify", "发送通知", message, notify_started));
                }
            }
        }
    }

    summary.total_ms = (executor::now_ms() - started_at).max(0);
    TestBenchResult { steps, summary }
}

fn assert_input_failed(
    mut steps: Vec<TestStep>,
    mut summary: TestBenchSummary,
    started_at: i64,
    message: String,
) -> TestBenchResult {
    steps.push(failure_step(
        "assert-input",
        "校验条件配置",
        message.clone(),
        executor::now_ms(),
    ));
    summary.error = Some(message);
    summary.total_ms = (executor::now_ms() - started_at).max(0);
    TestBenchResult { steps, summary }
}
