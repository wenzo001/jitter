//! HTTP API：与 TypeScript 版同一路径、同一状态码、同一 JSON 字段。
//!
//! 前端不需要任何改动。

use crate::scheduler;

use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json as AxumJson, Router};
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use serde_json::{json, Value as Json};

/// 前端构建产物（web/dist），编译时嵌入单文件二进制。
static WEB_DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../../web/dist");

use jitter_core::types::JsonMap;

use jitter_core::backup;
use jitter_core::config::get_active_config;
use jitter_core::curl_parser::parse_curl_command;
use jitter_core::db::{self, NewTaskInput, RequestParts};
use jitter_core::executor;
use jitter_core::metrics::get_metrics_report;
use jitter_core::schedule::{build_schedule, schedule_of, StoredSchedule};
use jitter_core::system;
use jitter_core::updater;

use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::ACTUAL_PORT;

/// 进程启动时刻（健康检查里回报运行时长）。
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

fn started_at() -> Instant {
    *STARTED_AT.get_or_init(Instant::now)
}

/// 最近一次服务端错误（时间 + 原因），健康检查里回报，方便界面提示用户。
static LAST_ERROR: OnceLock<Mutex<Option<(i64, String)>>> = OnceLock::new();

fn last_error_slot() -> &'static Mutex<Option<(i64, String)>> {
    LAST_ERROR.get_or_init(|| Mutex::new(None))
}

/// 记录最近一次**服务端**错误（只保留最近一条）。
///
/// 只有 5xx 才会让界面进入「后台降级」状态；4xx 多半是请求本身的问题
/// （比如查一张刚被删掉的表），把它算成后台故障会让横幅一直挂着，误导用户。
fn record_error(message: &str) {
    let mut guard = last_error_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some((executor::now_ms(), message.to_string()));
    tracing::error!("接口错误: {message}");
}

/// 记录一次 4xx（客户端请求有误）：只写日志，不改变「后台降级」状态。
fn record_client_error(message: &str) {
    tracing::warn!("请求有误: {message}");
}

/// 启动期错误（例如配置文件损坏）：让界面在健康检查里看到，用户知道该去修什么。
pub fn set_startup_error(message: &str) {
    record_error(message);
}

/// 按状态码决定要不要算作「后台故障」。
fn record_by_status(status: StatusCode, message: &str) {
    if status.is_server_error() {
        record_error(message);
    } else {
        record_client_error(message);
    }
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    let message = message.into();
    record_by_status(status, &message);
    (status, AxumJson(json!({ "error": message }))).into_response()
}

/// 带处理建议的错误响应：界面可以直接把 hint 展示给用户，告诉他下一步怎么做。
fn error_response_with_hint(
    status: StatusCode,
    message: impl Into<String>,
    hint: impl Into<String>,
) -> Response {
    let message = message.into();
    let hint = hint.into();
    record_by_status(status, &message);
    (status, AxumJson(json!({ "error": message, "hint": hint }))).into_response()
}

fn bad_request(message: impl Into<String>) -> Response {
    error_response(StatusCode::BAD_REQUEST, message)
}

fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "任务不存在")
}

fn conflict(message: impl Into<String>) -> Response {
    error_response(StatusCode::CONFLICT, message)
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

fn to_boolean(value: Option<&Json>) -> bool {
    match value {
        Some(Json::Bool(true)) => true,
        Some(value)
            if value == &Json::from(1)
                || value == &Json::from("1")
                || value == &Json::from("true") =>
        {
            true
        }
        _ => false,
    }
}

fn parse_expect_status(value: Option<&Json>, label: &str) -> Result<Option<i64>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() || value == &Json::from("") {
        return Ok(None);
    }
    let parsed = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()));
    match parsed {
        Some(status) if (100..=599).contains(&status) => Ok(Some(status)),
        _ => Err(format!("{label}必须是 100–599 的整数")),
    }
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
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Some(error) = jitter_core::condition::validate_condition(trimmed) {
        return Err(format!("{label}无效：{error}"));
    }
    Ok(Some(trimmed.to_string()))
}

fn request_parts(spec: &jitter_core::types::RequestSpec) -> RequestParts {
    RequestParts {
        url: spec.url.clone(),
        method: spec.method.clone(),
        headers: Some(Json::Object(spec.headers.clone()).to_string()),
        body: spec.body.clone(),
        options: spec
            .options
            .as_ref()
            .map(|options| serde_json::to_string(options).unwrap_or_else(|_| "{}".to_string())),
    }
}

/// 把 API 载荷解析成 NewTaskInput（与 TS 版 parseTaskInput 逐步对齐：
/// 扁平的 notify_*/precheck_* 字段、文本或对象型 headers、全部校验规则）。
fn parse_task_input(body: &Json) -> Result<NewTaskInput, String> {
    let object = body
        .as_object()
        .ok_or_else(|| "请求体必须是 JSON 对象".to_string())?;

    let name = object
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请填写任务名称".to_string())?
        .to_string();
    if name.chars().count() > 200 {
        return Err("任务名称不能超过 200 个字符".to_string());
    }

    // 调度：一套载荷覆盖三种模式（build_schedule 负责全部校验）。
    let schedule_fields = JsonMap::from_iter([
        (
            "schedule_kind".to_string(),
            object.get("schedule_kind").cloned().unwrap_or(Json::Null),
        ),
        (
            "window_start".to_string(),
            Json::String(
                object
                    .get("window_start")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string(),
            ),
        ),
        (
            "window_end".to_string(),
            Json::String(
                object
                    .get("window_end")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string(),
            ),
        ),
        (
            "daily_jitter_minutes".to_string(),
            object
                .get("daily_jitter_minutes")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_seconds".to_string(),
            object
                .get("interval_seconds")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_jitter_seconds".to_string(),
            object
                .get("interval_jitter_seconds")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_start_at".to_string(),
            object
                .get("interval_start_at")
                .cloned()
                .unwrap_or(Json::Null),
        ),
    ]);
    let schedule = build_schedule(&schedule_fields).map_err(|error| error.0)?;
    let is_daily = schedule.kind == jitter_core::schedule::ScheduleKind::Daily;
    let window_start = if is_daily {
        object
            .get("window_start")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };
    let window_end = if is_daily {
        object
            .get("window_end")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };

    // 请求：curl 文本优先，否则结构化字段。
    let has_curl = object
        .get("curl")
        .and_then(|value| value.as_str())
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false);
    let mode = match object.get("mode").and_then(|value| value.as_str()) {
        Some("structured") => "structured",
        Some("curl") => "curl",
        _ => {
            if has_curl {
                "curl"
            } else {
                "structured"
            }
        }
    };

    let (spec, curl_command): (jitter_core::types::RequestSpec, Option<String>) = if mode == "curl"
    {
        let curl = object
            .get("curl")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "请粘贴 curl 命令".to_string())?;
        (
            parse_curl_command(curl).map_err(|error| error.0)?,
            Some(curl.to_string()),
        )
    } else {
        let url = object
            .get("url")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "请填写 URL".to_string())?
            .to_string();
        if let Some(body_value) = object.get("body") {
            if !body_value.is_null() && body_value.as_str().is_none() {
                return Err("Body 必须是字符串".to_string());
            }
        }
        let headers = headers_input(object.get("headers"))?;
        let (header_map, header_lines) = match headers {
            Some(HeadersInput::Map(map)) => (Some(map), None),
            Some(HeadersInput::Lines(text)) => (None, Some(text)),
            None => (None, None),
        };
        let structured = jitter_core::curl_parser::StructuredRequestInput {
            url,
            method: object
                .get("method")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            headers: header_map,
            header_lines,
            body: object
                .get("body")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        };
        (
            jitter_core::curl_parser::normalize_structured(&structured).map_err(|error| error.0)?,
            None,
        )
    };

    // 通知：notify_enabled → 必须填 notify_curl。
    let notify_enabled = to_boolean(object.get("notify_enabled"));
    let mut notify_curl: Option<String> = None;
    let mut notify_request: Option<RequestParts> = None;
    if notify_enabled {
        let curl = object
            .get("notify_curl")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "启用通知时必须填写通知 curl".to_string())?;
        notify_curl = Some(curl.to_string());
        notify_request = Some(request_parts(
            &parse_curl_command(curl).map_err(|error| error.0)?,
        ));
    }

    // 命中条件与通知无关：决定每次执行记录的「命中」标记。
    let expect_status = parse_expect_status(object.get("expect_status"), "期望状态码")?;
    let expect_body = match object.get("expect_body") {
        Some(value) if !value.is_null() => {
            let text = value
                .as_str()
                .ok_or_else(|| "期望响应体必须是字符串".to_string())?;
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        _ => None,
    };
    let expect_expr = parse_expect_expr(object.get("expect_expr"), "条件表达式")?;

    // 执行前判断：本地条件（星期 / 时段）与/或前置 curl。
    let precheck_enabled = to_boolean(object.get("precheck_enabled"));
    let precheck_weekdays = if precheck_enabled {
        jitter_core::guard::parse_weekdays(object.get("precheck_weekdays"))
            .map_err(|error| error.0)?
    } else {
        None
    };
    let precheck_time = if precheck_enabled {
        jitter_core::guard::parse_time_range(
            object.get("precheck_time_start"),
            object.get("precheck_time_end"),
        )
        .map_err(|error| error.0)?
    } else {
        None
    };
    let mut precheck_curl: Option<String> = None;
    let mut precheck_request: Option<RequestParts> = None;
    if precheck_enabled {
        if let Some(curl) = object
            .get("precheck_curl")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            precheck_curl = Some(curl.to_string());
            precheck_request = Some(request_parts(
                &parse_curl_command(curl).map_err(|error| error.0)?,
            ));
        } else if let Some(url) = object
            .get("precheck_url")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let headers = headers_input(object.get("precheck_headers"))?;
            let (header_map, header_lines) = match headers {
                Some(HeadersInput::Map(map)) => (Some(map), None),
                Some(HeadersInput::Lines(text)) => (None, Some(text)),
                None => (None, None),
            };
            let structured = jitter_core::curl_parser::StructuredRequestInput {
                url: url.to_string(),
                method: object
                    .get("precheck_method")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                headers: header_map,
                header_lines,
                body: object
                    .get("precheck_body")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            };
            precheck_request = Some(request_parts(
                &jitter_core::curl_parser::normalize_structured(&structured)
                    .map_err(|error| error.0)?,
            ));
        }
    }
    let precheck_expect_status = if precheck_enabled {
        parse_expect_status(object.get("precheck_expect_status"), "条件检查的期望状态码")?
    } else {
        None
    };
    let precheck_expr = if precheck_enabled {
        parse_expect_expr(object.get("precheck_expr"), "前置条件表达式")?
    } else {
        None
    };
    let precheck_require_ac = precheck_enabled && to_boolean(object.get("precheck_require_ac"));
    let precheck_require_network =
        precheck_enabled && to_boolean(object.get("precheck_require_network"));
    let precheck_ip_pattern = if precheck_enabled {
        jitter_core::guard::parse_ip_pattern(object.get("precheck_ip_pattern"))
            .map_err(|error| error.0)?
    } else {
        None
    };
    let precheck_day_type = if precheck_enabled {
        jitter_core::guard::parse_day_type(object.get("precheck_day_type"))
            .map_err(|error| error.0)?
            .map(|value| value.as_str().to_string())
    } else {
        None
    };
    let run_on_startup = to_boolean(object.get("run_on_startup"));

    // 这个任务自己的日志保留天数：null / 缺省 = 跟随全局设置，0 = 永久保留。
    let log_retention_days = match object.get("log_retention_days") {
        None | Some(Json::Null) => None,
        Some(value) => {
            let Some(days) = value.as_i64() else {
                return Err("日志保留天数必须是数字（null 表示跟随全局设置）".to_string());
            };
            if !(0..=3650).contains(&days) {
                return Err("日志保留天数必须在 0（永久）到 3650 天之间".to_string());
            }
            Some(days)
        }
    };

    if precheck_enabled {
        let has_local = precheck_weekdays.is_some()
            || precheck_time.is_some()
            || precheck_day_type.is_some();
        let has_host = precheck_require_ac
            || precheck_require_network
            || precheck_ip_pattern.is_some();
        if !has_local && !has_host && precheck_request.is_none() {
            return Err(
                "启用执行条件时，至少配置本地条件（星期 / 时段 / 工作日 / 电源 / 网络 / 本机 IP）或条件检查 curl 之一"
                    .to_string(),
            );
        }
        if precheck_request.is_none()
            && (precheck_expect_status.is_some() || precheck_expr.is_some())
        {
            return Err("配置了条件状态码或表达式时，必须填写条件检查 curl".to_string());
        }
    }

    Ok(NewTaskInput {
        name,
        curl_command,
        request: request_parts(&spec),
        window_start,
        window_end,
        daily_jitter_minutes: Some(schedule.jitter_minutes).filter(|_| is_daily),
        schedule_kind: Some(schedule.kind.as_str().to_string()),
        interval_seconds: schedule.interval_seconds,
        interval_jitter_seconds: Some(schedule.interval_jitter_seconds),
        interval_start_at: schedule.start_at,
        notify_enabled,
        notify_curl_command: notify_curl,
        notify_request,
        expect_status,
        expect_body,
        expect_expr,
        precheck_enabled,
        precheck_curl_command: precheck_curl,
        precheck_request,
        precheck_expect_status,
        precheck_expr,
        precheck_weekdays,
        precheck_time_start: precheck_time.as_ref().map(|(start, _)| start.clone()),
        precheck_time_end: precheck_time.as_ref().map(|(_, end)| end.clone()),
        precheck_require_ac,
        precheck_require_network,
        precheck_ip_pattern,
        precheck_day_type,
        log_retention_days,
        run_on_startup,
    })
}

/// 上一次执行的结果归类：`success` 成功 / `condition_miss` 请求成功但未满足成功条件 / `failed` 失败。
fn last_run_view(row: &db::LogSummary) -> Json {
    let request_ok = row.error.is_none()
        && row
            .response_status
            .map(|status| (200..300).contains(&status))
            .unwrap_or(false);
    let outcome = if !request_ok {
        "failed"
    } else if row.matched.unwrap_or(0) != 0 {
        "success"
    } else {
        "condition_miss"
    };
    json!({
        "id": row.id,
        "executedAt": row.executed_at,
        "outcome": outcome,
        "status": row.response_status,
        "durationMs": row.duration_ms,
        "error": row.error,
        "matched": row.matched,
        "runSource": row.run_source,
        "kind": row.kind,
    })
}

/// 任务行 → 前端视图（运行中状态、调度错误与描述等派生字段）。
fn task_view(task: &db::TaskRow) -> Json {
    let stored = StoredSchedule {
        schedule_kind: Some(task.schedule_kind.clone()),
        window_start: Some(task.window_start.clone()),
        window_end: Some(task.window_end.clone()),
        daily_jitter_minutes: Some(task.daily_jitter_minutes),
        interval_seconds: task.interval_seconds,
        interval_jitter_seconds: Some(task.interval_jitter_seconds),
        interval_start_at: task.interval_start_at,
    };
    let (description, schedule_error) = match schedule_of(&stored) {
        Ok(spec) => (jitter_core::schedule::describe_schedule(&spec), None),
        Err(error) => ("定时执行".to_string(), Some(error.0)),
    };
    let running = scheduler::running_tasks();
    let started_at = running.get(&task.id).copied();
    let mut view = serde_json::to_value(task).unwrap_or(Json::Null);
    if let Some(object) = view.as_object_mut() {
        object.insert(
            "schedule_description".to_string(),
            Json::String(description),
        );
        object.insert("running".to_string(), Json::Bool(started_at.is_some()));
        object.insert(
            "running_since".to_string(),
            started_at.map(Json::from).unwrap_or(Json::Null),
        );
        object.insert(
            "schedule_error".to_string(),
            schedule_error.map(Json::String).unwrap_or(Json::Null),
        );
        // 上一次执行：时间与成功/失败，任务列表用它做醒目标记。
        let last_run = db::get_last_task_log(&task.id)
            .ok()
            .flatten()
            .map(|row| last_run_view(&row))
            .unwrap_or(Json::Null);
        object.insert("last_run".to_string(), last_run);
    }
    view
}

async fn list_tasks() -> Response {
    match db::list_tasks() {
        Ok(tasks) => {
            let views: Vec<Json> = tasks.iter().map(task_view).collect();
            AxumJson(json!({ "tasks": views })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn create_task(AxumJson(body): AxumJson<Json>) -> Response {
    let input = match parse_task_input(&body) {
        Ok(input) => input,
        Err(message) => return bad_request(message),
    };
    let id = uuid();
    match db::create_task(&input, &id, executor::now_ms()) {
        Ok(task) => {
            scheduler::schedule_new_task(&task.id);
            (
                StatusCode::CREATED,
                AxumJson(json!({ "task": task_view(&task) })),
            )
                .into_response()
        }
        Err(error) => bad_request(error.0),
    }
}

async fn get_task(Path(id): Path<String>) -> Response {
    match db::get_task(&id) {
        Ok(Some(task)) => AxumJson(json!({ "task": task_view(&task) })).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn update_task(Path(id): Path<String>, AxumJson(body): AxumJson<Json>) -> Response {
    let input = match parse_task_input(&body) {
        Ok(input) => input,
        Err(message) => return bad_request(message),
    };
    match db::update_task_config(&id, &input, executor::now_ms()) {
        Ok(Some(task)) => {
            scheduler::schedule_new_task(&task.id);
            AxumJson(json!({ "task": task_view(&task) })).into_response()
        }
        Ok(None) => not_found(),
        Err(error) => bad_request(error.0),
    }
}

async fn delete_task(Path(id): Path<String>) -> Response {
    match db::delete_task(&id) {
        Ok(outcome) if outcome.deleted => {
            scheduler::cancel_task(&id);
            AxumJson(json!({
                "ok": true,
                "id": id,
                "deleted_logs": outcome.deleted_logs,
                "deleted_test_runs": outcome.deleted_test_runs,
            }))
            .into_response()
        }
        Ok(_) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn stop_task(Path(id): Path<String>) -> Response {
    match db::get_task(&id) {
        Ok(Some(task)) if task.status == "active" => {
            scheduler::cancel_task(&id);
            match db::update_task_status(
                &id,
                jitter_core::types::TaskStatus::Stopped,
                None,
                executor::now_ms(),
            ) {
                Ok(()) => {
                    // TS 版停止时一并清掉暂停区间。
                    if task.paused_until.is_some() {
                        let _ = db::set_task_pause(&id, None, None, executor::now_ms());
                    }
                    let task = db::get_task(&id).ok().flatten().unwrap_or(task);
                    AxumJson(json!({ "task": task_view(&task) })).into_response()
                }
                Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
            }
        }
        Ok(Some(task)) => AxumJson(json!({ "task": task_view(&task) })).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn start_task(Path(id): Path<String>) -> Response {
    match db::get_task(&id) {
        Ok(Some(task)) if task.status == "stopped" => {
            // 与 TS 版一致：恢复 = 状态回 active + 重新排计划。
            if let Err(error) = db::update_task_status(
                &id,
                jitter_core::types::TaskStatus::Active,
                None,
                executor::now_ms(),
            ) {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0);
            }
            if task.paused_until.is_some() {
                let _ = db::set_task_pause(&id, None, None, executor::now_ms());
            }
            scheduler::schedule_new_task(&task.id);
            let task = db::get_task(&id).ok().flatten().unwrap_or(task);
            AxumJson(json!({ "task": task_view(&task) })).into_response()
        }
        Ok(Some(task)) => AxumJson(json!({ "task": task_view(&task) })).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn run_task(Path(id): Path<String>) -> Response {
    let Some(task) = db::get_task(&id).ok().flatten() else {
        return not_found();
    };
    if !scheduler::try_begin_run(&id) {
        return conflict("任务正在执行中，请等它结束再试");
    }
    // 与 TS 版一致：同步执行，返回完整结果（页面显示判定与耗时）。
    let cancel = tokio_util::sync::CancellationToken::new();
    scheduler::register_running(&id, cancel.clone());
    let outcome =
        executor::execute_task_run(&task, &cancel, jitter_core::types::RunSource::Manual).await;
    scheduler::finish_run(&id);
    AxumJson(json!({
        "ok": true,
        "status": outcome.status,
        "matched": outcome.matched,
        "skipped": outcome.skipped,
        "error": outcome.error,
        "aborted": outcome.aborted,
        "durationMs": outcome.duration_ms,
        "notifySent": outcome.notify_log_id.is_some(),
    }))
    .into_response()
}

async fn pause_task(Path(id): Path<String>, AxumJson(body): AxumJson<Json>) -> Response {
    let days = body
        .get("days")
        .and_then(|value| value.as_i64())
        .unwrap_or(1);
    let starts_today = body
        .get("starts_today")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !(1..=jitter_core::window::MAX_PAUSE_DAYS).contains(&days) {
        return bad_request(format!(
            "暂停天数必须是 1–{} 天",
            jitter_core::window::MAX_PAUSE_DAYS
        ));
    }
    let now = executor::now_ms();
    let pause = jitter_core::window::pause_interval(now, days, starts_today);
    match db::get_task(&id) {
        Ok(Some(task)) if task.status == "active" => {
            scheduler::cancel_task(&id);
            let stored = StoredSchedule {
                schedule_kind: Some(task.schedule_kind.clone()),
                window_start: Some(task.window_start.clone()),
                window_end: Some(task.window_end.clone()),
                daily_jitter_minutes: Some(task.daily_jitter_minutes),
                interval_seconds: task.interval_seconds,
                interval_jitter_seconds: Some(task.interval_jitter_seconds),
                interval_start_at: task.interval_start_at,
            };
            let spec = match schedule_of(&stored) {
                Ok(spec) => spec,
                Err(error) => return bad_request(error.0),
            };
            let resume_at = jitter_core::window::pause_resume_at(now, days, starts_today);
            let next = match jitter_core::schedule::plan_schedule_new(
                resume_at,
                &spec,
                Some(pause),
                &mut rand_thread(),
            ) {
                Ok(next) => next,
                Err(error) => return bad_request(error.0),
            };
            let _ = db::set_task_pause(&id, Some((pause.from, pause.until)), Some(next), now);
            scheduler::schedule_resume(&id, next);
            let task = db::get_task(&id).ok().flatten().unwrap_or(task);
            AxumJson(json!({ "task": task_view(&task) })).into_response()
        }
        Ok(Some(_)) => bad_request("任务已停止，无法暂停；请先恢复任务"),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

/// 取消暂停（active）或恢复一个已停止的任务（与 TS 版 resumeTask 对齐）。
async fn resume_task(Path(id): Path<String>) -> Response {
    let Some(task) = db::get_task(&id).ok().flatten() else {
        return not_found();
    };
    let now = executor::now_ms();

    if task.status == "active" {
        let has_pause = task.paused_from.is_some() || task.paused_until.is_some();
        if has_pause {
            // 取消暂停立即恢复调度，即使在窗口中途。
            let stored = StoredSchedule {
                schedule_kind: Some(task.schedule_kind.clone()),
                window_start: Some(task.window_start.clone()),
                window_end: Some(task.window_end.clone()),
                daily_jitter_minutes: Some(task.daily_jitter_minutes),
                interval_seconds: task.interval_seconds,
                interval_jitter_seconds: Some(task.interval_jitter_seconds),
                interval_start_at: task.interval_start_at,
            };
            let Ok(spec) = schedule_of(&stored) else {
                return bad_request("任务调度配置无效");
            };
            match jitter_core::schedule::plan_schedule_new(now, &spec, None, &mut rand_thread()) {
                Ok(target) => {
                    scheduler::cancel_task(&id);
                    let _ = db::set_task_pause(&id, None, Some(target), now);
                    scheduler::schedule_resume(&id, target);
                }
                Err(_) => return bad_request("无法重新计算下一次执行"),
            }
        } else if task.next_run_at.is_none() {
            // 修复丢了计划的 active 任务。
            scheduler::schedule_new_task(&id);
        }
        let task = db::get_task(&id).ok().flatten().unwrap_or(task);
        return AxumJson(json!({ "task": task_view(&task) })).into_response();
    }

    // stopped → active：恢复调度。
    if let Err(error) =
        db::update_task_status(&id, jitter_core::types::TaskStatus::Active, None, now)
    {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0);
    }
    if task.paused_until.is_some() {
        let _ = db::set_task_pause(&id, None, None, now);
    }
    scheduler::schedule_new_task(&id);
    let task = db::get_task(&id).ok().flatten().unwrap_or(task);
    AxumJson(json!({ "task": task_view(&task) })).into_response()
}

async fn reorder_tasks(AxumJson(body): AxumJson<Json>) -> Response {
    let Some(ids) = body.get("ids").and_then(|value| value.as_array()) else {
        return bad_request("ids 必须是任务 id 组成的数组");
    };
    let ids: Vec<String> = ids
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let existing: Vec<String> = db::list_tasks()
        .unwrap_or_default()
        .into_iter()
        .map(|task| task.id)
        .collect();
    let known: std::collections::HashSet<&String> = existing.iter().collect();
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if ids.len() != existing.len()
        || unique.len() != ids.len()
        || ids.iter().any(|id| !known.contains(id))
    {
        return conflict("任务列表已变化，请刷新后重试");
    }
    match db::reorder_tasks(&ids) {
        Ok(()) => {
            let tasks = db::list_tasks().unwrap_or_default();
            let views: Vec<Json> = tasks.iter().map(task_view).collect();
            AxumJson(json!({ "ok": true, "tasks": views })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn list_logs(
    Path(id): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(task) = db::get_task(&id).ok().flatten() else {
        return not_found();
    };
    let config = get_active_config();
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(config.logs_page_size)
        .clamp(1, config.logs_max_page_size.max(1));

    // 游标 "<executed_at>:<id>"（与 TS 版一致，坏格式直接 400）。
    let mut before: Option<db::LogCursor> = None;
    if let Some(raw) = params.get("before").filter(|value| !value.is_empty()) {
        let parts: Vec<&str> = raw.split(':').collect();
        if parts.len() != 2 {
            return bad_request("before 必须是 <executed_at>:<id> 形式的游标");
        }
        let (at, log_id) = (parts[0].parse::<i64>(), parts[1].parse::<i64>());
        match (at, log_id) {
            (Ok(executed_at), Ok(log_id)) if executed_at >= 0 && log_id > 0 => {
                before = Some(db::LogCursor {
                    executed_at,
                    id: log_id,
                });
            }
            _ => return bad_request("before 必须是 <executed_at>:<id> 形式的游标"),
        }
    }

    // 保留窗口之外的日志不查询、不渲染。
    // 窗口按任务算：任务单独设置过天数就用它自己的，否则用全局的。
    let global_retention = db::get_effective_retention_days(config.log_retention_days)
        .unwrap_or(config.log_retention_days);
    let retention_days = task.log_retention_days.unwrap_or(global_retention);
    let since = if retention_days > 0 {
        Some(executor::now_ms() - retention_days * 24 * 60 * 60 * 1000)
    } else {
        None
    };

    match db::list_log_summaries(&id, limit + 1, before, since) {
        Ok(mut rows) => {
            let has_more = rows.len() > limit as usize;
            if has_more {
                rows.truncate(limit as usize);
            }
            // 通知是任务执行的附属数据：并入父行返回，不再单独成行。
            let parent_ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
            let notify_rows = db::list_notify_summaries(&parent_ids).unwrap_or_default();
            let logs: Vec<Json> = rows
                .iter()
                .map(|row| {
                    let mut value =
                        serde_json::to_value(row).unwrap_or(Json::Null);
                    if let Some(object) = value.as_object_mut() {
                        if let Some(notify) = notify_rows
                            .iter()
                            .find(|entry| entry.parent_log_id == Some(row.id))
                        {
                            object.insert(
                                "notify".into(),
                                serde_json::to_value(notify).unwrap_or(Json::Null),
                            );
                        }
                    }
                    value
                })
                .collect();
            AxumJson(
                json!({ "logs": logs, "has_more": has_more, "retention_days": retention_days }),
            )
            .into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn get_log_detail(Path(id): Path<String>) -> Response {
    let Ok(log_id) = id.parse::<i64>() else {
        return bad_request("日志 id 必须是数字");
    };
    match db::get_log(log_id) {
        Ok(Some(log)) => {
            // 通知随它的执行详情一起返回；通知行本身不附带。
            let mut value = serde_json::to_value(&log).unwrap_or(Json::Null);
            if log.kind != "notify" {
                if let Ok(Some(notify)) = db::get_notify_by_parent(log.id) {
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "notify".into(),
                            serde_json::to_value(&notify).unwrap_or(Json::Null),
                        );
                    }
                }
            }
            AxumJson(json!({ "log": value })).into_response()
        }
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn metrics() -> Response {
    // 与 TS 版一致：报告对象直接作为响应体（页面读 data.overview）。
    match get_metrics_report(executor::now_ms(), scheduler::running_count(), 20) {
        Ok(report) => AxumJson(report).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn config() -> Response {
    let config = get_active_config();
    // 保留窗口取「实际生效」值（界面设置覆盖默认）。
    let retention = db::get_effective_retention_days(config.log_retention_days)
        .unwrap_or(config.log_retention_days);
    AxumJson(json!({
        "logsPageSize": config.logs_page_size,
        "defaultWindowMinutes": config.default_window_minutes,
        "pollIntervalMs": config.poll_interval_ms,
        "logBodyLimitBytes": config.log_body_limit_bytes,
        "requestTimeoutMs": config.request_timeout_ms,
        "logRetentionDays": retention,
    }))
    .into_response()
}

async fn get_settings() -> Response {
    let config = get_active_config();
    let retention = db::get_effective_retention_days(config.log_retention_days).unwrap_or(30);
    AxumJson(json!({
        "logRetentionDays": retention,
        "logMaxRowsPerTask": config.log_max_rows_per_task,
        "skipTlsVerify": db::get_skip_tls_verify(),
        "preventSleepOnAc": db::get_prevent_sleep_on_ac(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SettingsBody {
    #[serde(rename = "logRetentionDays")]
    log_retention_days: Option<i64>,
    #[serde(rename = "skipTlsVerify")]
    skip_tls_verify: Option<bool>,
    #[serde(rename = "preventSleepOnAc")]
    prevent_sleep_on_ac: Option<bool>,
}

async fn update_settings(AxumJson(body): AxumJson<SettingsBody>) -> Response {
    if let Some(days) = body.log_retention_days {
        if !(0..=3650).contains(&days) {
            return bad_request("保留天数必须是 0–3650");
        }
        if let Err(error) = db::set_setting(db::LOG_RETENTION_SETTING, Some(&days.to_string())) {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0);
        }
    }
    if let Some(skip) = body.skip_tls_verify {
        let value = if skip { "1" } else { "0" };
        if let Err(error) = db::set_setting(db::SKIP_TLS_VERIFY_SETTING, Some(value)) {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0);
        }
    }
    if let Some(prevent) = body.prevent_sleep_on_ac {
        let value = if prevent { "1" } else { "0" };
        if let Err(error) = db::set_setting(db::PREVENT_SLEEP_ON_AC_SETTING, Some(value)) {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0);
        }
        jitter_core::host::set_prevent_sleep(prevent);
    }
    get_settings().await
}

/// 当前主机环境：电源状态、网络连接与本机 IPv4，任务表单用它显示辅助提示。
async fn system_environment() -> Response {
    let environment = jitter_core::host::current_environment();
    let networks: Vec<Json> = environment
        .networks
        .iter()
        .map(|network| {
            json!({
                "name": network.name,
                "kind": network.kind.as_str(),
            })
        })
        .collect();
    AxumJson(json!({
        "onAcPower": environment.on_ac_power,
        "localIps": environment.local_ips,
        "networks": networks,
        "preventSleepOnAc": db::get_prevent_sleep_on_ac(),
    }))
    .into_response()
}

/// 已缓存的节假日年份（设置页可视化 + 表单判断「工作日 / 休息日」选项是否可用）。
async fn system_holiday() -> Response {
    AxumJson(json!({
        "years": jitter_core::holiday::list_years(),
        "hasCurrentYear": jitter_core::holiday::has_current_year_data(executor::now_ms()),
        "today": jitter_core::holiday::today_info(executor::now_ms()),
    }))
    .into_response()
}

/// 某年某月的逐日归类（日历面板：工作日 / 休息日 / 法定节假日 / 调休）。
async fn system_holiday_month(Query(params): Query<std::collections::HashMap<String, String>>) -> Response {
    let now = executor::now_ms();
    let today = jitter_core::holiday::today_info(now);
    let current_year = today
        .date
        .get(..4)
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(1970);
    let current_month = today
        .date
        .get(5..7)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);
    let year = params
        .get("year")
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| (1970..=2999).contains(value))
        .unwrap_or(current_year);
    let month = params
        .get("month")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=12).contains(value))
        .unwrap_or(current_month);
    AxumJson(json!({
        "year": year,
        "month": month,
        "today": today,
        "days": jitter_core::holiday::month_info(year, month),
    }))
    .into_response()
}

/// 数据库里的全部表（只读浏览用）。
async fn database_tables() -> Response {
    match db::list_database_tables() {
        Ok(tables) => AxumJson(json!({ "tables": tables })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

/// 某张表的一页数据（只读浏览用）。
async fn database_rows(Query(params): Query<std::collections::HashMap<String, String>>) -> Response {
    let Some(table) = params.get("table").map(|value| value.trim()).filter(|value| !value.is_empty()) else {
        return bad_request("缺少 table 参数");
    };
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(100);
    let offset = params
        .get("offset")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    match db::list_database_rows(table, limit, offset) {
        Ok(rows) => AxumJson(json!(rows)).into_response(),
        Err(error) => error_response(StatusCode::BAD_REQUEST, error.0),
    }
}

/// 手动拉取节假日数据（去年 / 今年 / 明年三年，成功的覆盖本地）。
async fn system_holiday_refresh() -> Response {
    let (refreshed, errors) = jitter_core::holiday::refresh_years().await;
    AxumJson(json!({
        "years": jitter_core::holiday::list_years(),
        "hasCurrentYear": jitter_core::holiday::has_current_year_data(executor::now_ms()),
        "today": jitter_core::holiday::today_info(executor::now_ms()),
        "refreshed": refreshed,
        "errors": errors,
    }))
    .into_response()
}

async fn cleanup_logs(AxumJson(body): AxumJson<Json>) -> Response {
    let wants_all = body.get("all") == Some(&Json::Bool(true));
    let days = body.get("days").filter(|value| !value.is_null());
    let confirm = body.get("confirm").cloned().unwrap_or(Json::Null);
    // 清理范围：None = 全部任务，Some(task_id) = 只清这个任务。
    let task_id = match body.get("task_id").filter(|value| !value.is_null()) {
        Some(Json::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Some(_) => return bad_request("task_id 必须是非空字符串"),
        None => None,
    };
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    if wants_all && days.is_some() {
        return bad_request("days 与 all 不能同时指定");
    }

    if wants_all {
        if confirm != Json::from("DELETE_ALL") {
            return bad_request("全部清除需要二次确认：confirm 必须为 \"DELETE_ALL\"");
        }
        return match db::cleanup_logs(None, task_id.as_deref()) {
            Ok(outcome) => AxumJson(outcome).into_response(),
            Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
        };
    }

    let Some(days_value) = days else {
        return bad_request("缺少 days");
    };
    let Some(days) = days_value.as_i64() else {
        return bad_request(format!("days 必须是 {} 之一（数字类型）", tier_list()));
    };
    if !jitter_core::db::LOG_CLEANUP_DAYS.contains(&days) {
        return bad_request(format!("days 必须是 {} 之一（数字类型）", tier_list()));
    }
    if confirm != Json::Bool(true) && confirm != Json::from("DELETE") {
        return bad_request("清理前需要二次确认：confirm 必须为 true");
    }
    // 传入的 cutoff 必须来自对应档位的预检（不得放大删除范围或使用过期预检）。
    let cutoff = match body.get("cutoff").filter(|value| !value.is_null()) {
        Some(value) => {
            let expected = executor::now_ms() - days * DAY_MS;
            match value.as_i64() {
                Some(cutoff)
                    if cutoff > 0
                        && cutoff <= expected + 5 * 60_000
                        && cutoff >= expected - DAY_MS =>
                {
                    Some(cutoff)
                }
                _ => {
                    return bad_request(
                        "cutoff 必须来自对应档位的清理预检（不得放大删除范围或使用过期预检）",
                    );
                }
            }
        }
        None => Some(executor::now_ms() - days * DAY_MS),
    };
    match db::cleanup_logs(cutoff, task_id.as_deref()) {
        Ok(outcome) => AxumJson(outcome).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

fn tier_list() -> String {
    jitter_core::db::LOG_CLEANUP_DAYS
        .iter()
        .map(|day| day.to_string())
        .collect::<Vec<String>>()
        .join(" / ")
}

/// 清理预检：`?task_id=xxx` 只统计这个任务，不带则是全部任务。
async fn cleanup_preview(Query(query): Query<std::collections::HashMap<String, String>>) -> Response {
    let task_id = query
        .get("task_id")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match db::get_log_cleanup_preview(executor::now_ms(), task_id.as_deref()) {
        Ok(preview) => AxumJson(preview).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn test_request(AxumJson(body): AxumJson<Json>) -> Response {
    let object = match body.as_object() {
        Some(object) => object.clone(),
        None => return bad_request("请求体必须是 JSON 对象"),
    };
    let Some(curl) = object.get("curl").and_then(|value| value.as_str()) else {
        return bad_request("请提供 curl 命令");
    };
    let spec = match parse_curl_command(curl) {
        Ok(spec) => spec,
        Err(error) => return bad_request(error.0),
    };
    let outcome = executor::execute_test_request(&spec).await;
    AxumJson(json!({ "result": outcome })).into_response()
}

// ---------------------------------------------------------------------------
// 调度预览 / 测试台 / 测试留档
// ---------------------------------------------------------------------------

/// 「这实际上什么时候会跑？」表单预览。
async fn schedule_preview(AxumJson(body): AxumJson<Json>) -> Response {
    let object = match body.as_object() {
        Some(object) => object.clone(),
        None => return bad_request("请求体必须是 JSON 对象"),
    };
    let fields = JsonMap::from_iter([
        (
            "schedule_kind".to_string(),
            object.get("schedule_kind").cloned().unwrap_or(Json::Null),
        ),
        (
            "window_start".to_string(),
            Json::String(
                object
                    .get("window_start")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
            ),
        ),
        (
            "window_end".to_string(),
            Json::String(
                object
                    .get("window_end")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
            ),
        ),
        (
            "daily_jitter_minutes".to_string(),
            object
                .get("daily_jitter_minutes")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_seconds".to_string(),
            object
                .get("interval_seconds")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_jitter_seconds".to_string(),
            object
                .get("interval_jitter_seconds")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "interval_start_at".to_string(),
            object
                .get("interval_start_at")
                .cloned()
                .unwrap_or(Json::Null),
        ),
    ]);
    let schedule = match build_schedule(&fields) {
        Ok(schedule) => schedule,
        Err(error) => return bad_request(error.0),
    };
    // 表单要 7 条；封顶以免一个手滑返回上千条。
    let count = body
        .get("count")
        .and_then(|value| value.as_i64())
        .map(|count| count.clamp(1, 20))
        .unwrap_or(7) as usize;
    let preview = jitter_core::schedule::preview_schedule(&schedule, executor::now_ms(), count);
    let window = schedule.window.as_ref().map(
        |window| json!({ "start": window.start, "end": window.end, "instant": window.instant }),
    );
    AxumJson(json!({
        "ok": true,
        "kind": schedule.kind.as_str(),
        "description": preview.description,
        "next": preview.next,
        "window": window,
        "jitter_minutes": schedule.jitter_minutes,
    }))
    .into_response()
}

/// 统一测试台：解析 → 本地判断 → 前置判断 → 主请求 → 判定 → 通知，
/// 一条时间线返回；不写执行记录。带 task_id 时把这次测试留档（最近 10 次）。
async fn test_bench_run(AxumJson(body): AxumJson<Json>) -> Response {
    if !body.is_object() {
        return bad_request("请求体必须是 JSON 对象");
    }
    let result = jitter_core::testbench::run_test_bench(&body).await;

    let mut test_run_id: Option<i64> = None;
    let task_id = body
        .get("task_id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if let Some(task_id) = task_id {
        if db::get_task(task_id).ok().flatten().is_some() {
            let ok = !result.summary.skipped
                && result.summary.matched
                && result.summary.error.is_none()
                && !result.summary.notify_failed;
            let summary =
                serde_json::to_string(&result.summary).unwrap_or_else(|_| "{}".to_string());
            let steps = serde_json::to_string(&result.steps).unwrap_or_else(|_| "[]".to_string());
            match db::insert_test_run(task_id, ok, &summary, &steps, executor::now_ms()) {
                Ok(id) => test_run_id = Some(id),
                Err(error) => tracing::error!("保存测试记录失败: {error}"),
            }
        }
    }
    AxumJson(json!({ "result": result, "test_run_id": test_run_id })).into_response()
}

fn parse_json_column(raw: &str) -> Json {
    serde_json::from_str(raw).unwrap_or(Json::Null)
}

/// 某个任务的测试留档（最近 10 次的概要）。
async fn task_test_runs(Path(id): Path<String>) -> Response {
    if db::get_task(&id).ok().flatten().is_none() {
        return not_found();
    }
    let runs: Vec<Json> = db::list_test_runs(&id, 10)
        .unwrap_or_default()
        .into_iter()
        .map(|run| {
            json!({
                "id": run.id,
                "created_at": run.created_at,
                "ok": run.ok,
                "summary": parse_json_column(&run.summary),
            })
        })
        .collect();
    AxumJson(json!({ "runs": runs })).into_response()
}

/// 单条测试留档（含全部步骤）。
async fn test_run_detail(Path(id): Path<String>) -> Response {
    let Ok(log_id) = id.parse::<i64>() else {
        return bad_request("测试记录 ID 无效");
    };
    match db::get_test_run(log_id) {
        Ok(Some(run)) => AxumJson(json!({
            "run": {
                "id": run.id,
                "task_id": run.task_id,
                "created_at": run.created_at,
                "ok": run.ok,
                "summary": parse_json_column(&run.summary),
                "steps": parse_json_column(&run.steps),
            }
        }))
        .into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "测试记录不存在"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

/// 健康检查：顺带回报运行时长、路径与最近一次错误，界面据此提示用户。
async fn health() -> Response {
    let config = get_active_config();
    let last_error = last_error_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let db_ok = db::list_tasks().is_ok();
    AxumJson(json!({
        "ok": true,
        "now": executor::now_ms(),
        "version": jitter_core::VERSION,
        "uptimeMs": started_at().elapsed().as_millis() as u64,
        "dbOk": db_ok,
        "dbPath": config.db_path,
        "logDir": jitter_core::logging::log_dir(&config.db_path).to_string_lossy().to_string(),
        "lastError": match last_error {
            Some((at, message)) => json!({ "at": at, "message": message }),
            None => Json::Null,
        },
    }))
    .into_response()
}

/// 运行日志文件列表（界面「运行日志」面板用）。
async fn system_logs() -> Response {
    let dir = jitter_core::logging::log_dir(&get_active_config().db_path);
    AxumJson(json!({
        "dir": dir.to_string_lossy(),
        "retentionDays": jitter_core::logging::retention_days_from_env(),
        "files": jitter_core::logging::list_files(&dir),
    }))
    .into_response()
}

/// 读取某个运行日志的一段内容。
async fn system_log_file(
    Path(name): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let dir = jitter_core::logging::log_dir(&get_active_config().db_path);
    let offset = params
        .get("offset")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(64 * 1024);
    match jitter_core::logging::read_file(&dir, &name, offset, limit) {
        Ok(chunk) => AxumJson(json!(chunk)).into_response(),
        Err(message) => error_response_with_hint(
            StatusCode::BAD_REQUEST,
            message,
            "请在「运行日志」面板里重新选择日志文件。",
        ),
    }
}

/// 首页与静态资源：从嵌入的 web/dist 读取。
fn static_file(path: &str, immutable: bool) -> Response {
    let Some(file) = WEB_DIST.get_file(path) else {
        return missing_asset_page(path);
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        file.contents(),
    )
        .into_response()
}

/// 前端资源缺失时的可读兜底页：告诉用户发生了什么、怎么修。
///
/// 正常不会走到；构建产物没打进去时，至少别给用户一个空白页。
fn missing_asset_page(path: &str) -> Response {
    tracing::error!("前端资源缺失: {path}");
    let html = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jitter · 界面文件缺失</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f5f6f8;color:#18212f;margin:0;padding:40px 20px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:28px 32px;max-width:560px}
h1{font-size:19px;margin:0 0 10px}
p{font-size:14px;line-height:1.8;color:#3b475c}
li{font-size:13.5px;line-height:1.9;color:#3b475c}
code{background:#f1f4f9;border-radius:4px;padding:1px 5px;font-size:12.5px}
</style></head><body><div class="card">
<h1>界面文件缺失，Jitter 后台仍在运行</h1>
<p>程序本体启动正常，但打包时没有带上网页资源（缺少 <code>web/dist</code>），所以界面打不开。
调度器仍在按计划执行任务，数据库也没有损坏。</p>
<p>可以这样处理：</p>
<ol>
<li>重新下载或重新安装一次 Jitter（覆盖安装即可）。</li>
<li>如果你是自己构建的：先在 <code>web/</code> 目录执行 <code>bun install &amp;&amp; bun run build</code>，
再回到 <code>rust/</code> 执行 <code>cargo build --release -p jitter-app</code>。</li>
<li>仍然不行的话，把下面的日志目录内容发出来，便于定位：</li>
</ol>
<p id="logdir">日志目录：正在获取…</p>
<p><a href="/api/system/logs">查看运行日志接口</a> · <a href="/api/health">查看服务状态</a></p>
</div>
<script>fetch('/api/system/logs').then(r=>r.json()).then(d=>{const el=document.getElementById('logdir');
if(el&&d&&d.dir)el.textContent='日志目录：'+d.dir;}).catch(()=>{});</script>
</body></html>"#;
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

async fn index() -> Response {
    static_file("index.html", false)
}

/// Vite 生成的带哈希资源：可长期缓存。
async fn asset(Path(path): Path<String>) -> Response {
    static_file(&format!("assets/{path}"), true)
}

// ---------------------------------------------------------------------------
// 系统 / 自启 / 退出
// ---------------------------------------------------------------------------

fn current_db_path() -> std::path::PathBuf {
    std::path::PathBuf::from(get_active_config().db_path)
}

/// 设置页展示的安装信息（版本 / 路径 / 自启状态）。
async fn system_info() -> Response {
    let port = ACTUAL_PORT.load(Ordering::Relaxed);
    let info = system::get_system_info(port, &get_active_config().db_path);
    AxumJson(info).into_response()
}

#[derive(Deserialize)]
struct AutostartBody {
    enabled: Option<bool>,
}

async fn set_autostart_handler(AxumJson(body): AxumJson<AutostartBody>) -> Response {
    let enabled = body.enabled.unwrap_or(false);
    match system::set_autostart(enabled) {
        Ok(()) => AxumJson(json!({ "ok": true, "autostart": system::is_autostart_enabled() }))
            .into_response(),
        Err(message) => bad_request(message),
    }
}

/// 退出：托盘菜单与设置页共用。
async fn quit() -> Response {
    crate::quit_token().cancel();
    AxumJson(json!({ "ok": true })).into_response()
}

// ---------------------------------------------------------------------------
// 备份 / 导出 / 导入 / 恢复
// ---------------------------------------------------------------------------

async fn backup_list() -> Response {
    let db_path = current_db_path();
    AxumJson(json!({
        "backups": backup::list_backups(&db_path),
        "backup_dir": backup::get_backup_dir(&db_path).to_string_lossy(),
    }))
    .into_response()
}

async fn backup_create() -> Response {
    let db_path = current_db_path();
    match backup::create_backup(&db_path, backup::now_ms()) {
        Ok(entry) => AxumJson(json!({ "ok": true, "backup": entry })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn backup_download(
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let db_path = current_db_path();
    let name = params.get("name").cloned().unwrap_or_default();
    let target = match backup::resolve_backup_path(&db_path, &name) {
        Ok(target) => target,
        Err(error) => return bad_request(error.0),
    };
    if !target.exists() {
        return error_response(StatusCode::NOT_FOUND, format!("备份不存在: {name}"));
    }
    match tokio::fs::read(&target).await {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            )
            .body(axum::body::Body::from(bytes))
            .expect("download response"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn backup_upload(
    Query(params): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let name = params
        .get("name")
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return bad_request("缺少文件名（?name=）");
    }
    let db_path = current_db_path();
    match backup::save_uploaded_backup(&db_path, &name, &body) {
        Ok(entry) => AxumJson(json!({ "ok": true, "backup": entry })).into_response(),
        Err(error) => bad_request(error.0),
    }
}

#[derive(Deserialize)]
struct BackupNameBody {
    name: Option<String>,
}

async fn backup_delete(AxumJson(body): AxumJson<BackupNameBody>) -> Response {
    let Some(name) = body.name.filter(|value| !value.is_empty()) else {
        return bad_request("缺少 name");
    };
    match backup::delete_backup(&current_db_path(), &name) {
        Ok(()) => AxumJson(json!({ "ok": true })).into_response(),
        // TS 版把「不存在」与非法名都映射到 404。
        Err(error) => error_response(StatusCode::NOT_FOUND, error.0),
    }
}

/// 恢复备份：停调度 → 关库 → 换文件 → 重新初始化 → 重启调度。
/// api 层已经先做好当前状态的安全快照（prepare_restore）。
async fn backup_restore(AxumJson(body): AxumJson<BackupNameBody>) -> Response {
    let Some(name) = body.name.filter(|value| !value.is_empty()) else {
        return bad_request("缺少 name");
    };
    let db_path = current_db_path();
    let db_path_string = get_active_config().db_path.clone();
    let plan = match backup::prepare_restore(&db_path, &name, backup::now_ms()) {
        Ok(plan) => plan,
        Err(error) => return bad_request(error.0),
    };

    let restored: anyhow::Result<()> = async {
        scheduler::stop().await;
        db::close_db();
        backup::swap_database(&db_path, &plan.backup_path)?;
        db::init_db(Some(&db_path_string))?;
        scheduler::start().await?;
        anyhow::Ok(())
    }
    .await;

    match restored {
        Ok(()) => AxumJson(json!({
            "ok": true,
            "message": format!("已恢复 {name}；恢复前的数据保存在 {}", plan.safety_name),
            "safety_backup": plan.safety_name,
        }))
        .into_response(),
        Err(error) => {
            tracing::error!("恢复备份失败: {error:#}");
            // 至少让服务回到可用状态。
            if db::init_db(Some(&db_path_string)).is_ok() {
                let _ = scheduler::start().await;
            }
            error_response(StatusCode::CONFLICT, error.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// 自动升级
// ---------------------------------------------------------------------------

async fn update_check() -> Response {
    let info = updater::check_for_update().await;
    AxumJson(info).into_response()
}

async fn update_progress() -> Response {
    AxumJson(updater::get_update_progress()).into_response()
}

#[derive(Deserialize)]
struct UpdateApplyBody {
    confirm: Option<bool>,
}

async fn update_apply(AxumJson(body): AxumJson<UpdateApplyBody>) -> Response {
    if body.confirm != Some(true) {
        return AxumJson(json!({ "ok": false, "message": "需要确认后才能升级" })).into_response();
    }
    let info = updater::check_for_update().await;
    let (ok, message) = updater::apply_update(&info).await;
    if ok {
        // 新二进制已经被启动；本进程让位退出。
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            std::process::exit(0);
        });
    }
    AxumJson(json!({ "ok": ok, "message": message })).into_response()
}

fn uuid() -> String {
    // 无需外部 uuid crate：时间 + 计数器的伪 UUID 足够（与 TS 的 randomUUID 同为字符串 id）。
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = executor::now_ms();
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let random = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.subsec_nanos())
        .unwrap_or(0);
    format!("{now:016x}-{seq:06x}{random:08x}")
}

thread_local! {
    static RAND_STATE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// 线程局部的 xorshift64* 随机数（不引第三方 crate），返回 0..1 的浮点。
fn rand_thread() -> impl FnMut() -> f64 {
    || {
        RAND_STATE.with(|state| {
            let mut seed = state.get();
            if seed == 0 {
                seed = (executor::now_ms() as u64)
                    ^ ((std::process::id() as u64) << 32)
                    ^ 0x9E37_79B9_7F4A_7C15;
            }
            seed ^= seed >> 12;
            seed ^= seed << 25;
            seed ^= seed >> 27;
            state.set(seed);
            let value = seed.wrapping_mul(0x2545_F491_4F6C_DD1D);
            (value >> 11) as f64 / (1u64 << 53) as f64
        })
    }
}

pub fn build_router() -> Router {
    Router::new()
        .route("/", get(index))
        .route("/assets/*path", get(asset))
        .route("/api/health", get(health))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/reorder", post(reorder_tasks))
        .route(
            "/api/tasks/:id",
            get(get_task).put(update_task).delete(delete_task),
        )
        .route("/api/tasks/:id/stop", post(stop_task))
        .route("/api/tasks/:id/start", post(start_task))
        .route("/api/tasks/:id/run", post(run_task))
        .route("/api/tasks/:id/pause", post(pause_task))
        .route("/api/tasks/:id/resume", post(resume_task))
        .route("/api/tasks/:id/logs", get(list_logs))
        .route("/api/logs/:id", get(get_log_detail))
        .route("/api/metrics", get(metrics))
        .route("/api/config", get(config))
        .route("/api/settings", get(get_settings).post(update_settings))
        .route("/api/logs/cleanup", post(cleanup_logs))
        .route("/api/logs/cleanup/preview", get(cleanup_preview))
        .route("/api/schedule/preview", post(schedule_preview))
        .route("/api/test", post(test_request))
        .route("/api/test/run", post(test_bench_run))
        .route("/api/tasks/:id/test-runs", get(task_test_runs))
        .route("/api/test-runs/:id", get(test_run_detail))
        .route("/api/system", get(system_info))
        .route("/api/system/environment", get(system_environment))
        .route("/api/system/logs", get(system_logs))
        .route("/api/system/logs/:name", get(system_log_file))
        .route("/api/system/holiday", get(system_holiday))
        .route("/api/system/holiday/month", get(system_holiday_month))
        .route("/api/system/holiday/refresh", post(system_holiday_refresh))
        .route("/api/database/tables", get(database_tables))
        .route("/api/database/rows", get(database_rows))
        .route("/api/system/autostart", post(set_autostart_handler))
        .route("/api/quit", post(quit))
        .route("/api/backup/list", get(backup_list))
        .route("/api/backup", post(backup_create))
        .route("/api/backup/download", get(backup_download))
        .route("/api/backup/upload", post(backup_upload))
        .route("/api/backup/delete", post(backup_delete))
        .route("/api/backup/restore", post(backup_restore))
        .route("/api/update/check", get(update_check))
        .route("/api/update/progress", get(update_progress))
        .route("/api/update/apply", post(update_apply))
        // 备份导入可能携带大文件（数据库快照）。
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4xx 是请求本身的问题，不该把后台标记成「降级」；
    /// 只有 5xx 才算后台故障。合在一个用例里，避免共享的 LAST_ERROR 互相干扰。
    #[test]
    fn only_server_errors_mark_the_service_as_degraded() {
        {
            let mut guard = last_error_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = None;
        }

        let _ = error_response(StatusCode::BAD_REQUEST, "表不存在：nope");
        assert!(
            last_error_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none(),
            "4xx 不应把后台标记成降级"
        );

        let _ = error_response(StatusCode::INTERNAL_SERVER_ERROR, "boom");
        assert!(
            last_error_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some(),
            "5xx 必须让界面知道后台出问题了"
        );
    }
}