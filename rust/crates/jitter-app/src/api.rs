//! HTTP API：与 TypeScript 版同一路径、同一状态码、同一 JSON 字段。
//!
//! 前端不需要任何改动。

use crate::scheduler;

use axum::body::Bytes;
use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json as AxumJson, Router};
use serde::Deserialize;
use serde_json::{json, Map as JsonMap, Value as Json};

use jitter_core::backup;
use jitter_core::config::get_active_config;
use jitter_core::curl_parser::{parse_curl_command, CurlParseError};
use jitter_core::db::{self, NewLogInput, NewTaskInput, RequestParts};
use jitter_core::executor;
use jitter_core::metrics::get_metrics_report;
use jitter_core::schedule::{build_schedule, schedule_of, StoredSchedule};
use jitter_core::system;
use jitter_core::updater;

use std::sync::atomic::Ordering;

use crate::ACTUAL_PORT;

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, AxumJson(json!({ "error": message.into() }))).into_response()
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

/// 把 API 载荷解析成 NewTaskInput（与 TS 版 api.ts 的解析一致的最小实现）。
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

    // 结构化输入优先，否则解析 curl。
    let spec = if let Some(curl) = object.get("curl").and_then(|value| value.as_str()) {
        if curl.trim().is_empty() {
            return Err("请粘贴 curl 命令或填写结构化字段".to_string());
        }
        parse_curl_command(curl).map_err(|error| error.0)?
    } else {
        let url = object
            .get("url")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "请填写 URL".to_string())?;
        let method = object
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("GET")
            .trim()
            .to_uppercase();
        let headers = object.get("headers").and_then(|value| value.as_object()).cloned();
        let body = object
            .get("body")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        // 用 normalize_structured 做同样的校验。
        let structured = jitter_core::curl_parser::StructuredRequestInput {
            url: url.to_string(),
            method: Some(method),
            headers,
            header_lines: None,
            body,
        };
        jitter_core::curl_parser::normalize_structured(&structured).map_err(|error| error.0)?
    };

    let notify_map = object
        .get("notify")
        .and_then(|value| value.as_object())
        .cloned();
    let notify_curl = notify_map
        .as_ref()
        .and_then(|notify| notify.get("curl"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let notify_request = notify_map.as_ref().and_then(|notify| {
        let url = notify.get("url").and_then(|value| value.as_str())?;
        Some(RequestParts {
            url: url.to_string(),
            method: notify
                .get("method")
                .and_then(|value| value.as_str())
                .unwrap_or("GET")
                .to_string(),
            headers: notify
                .get("headers")
                .and_then(|value| value.as_object())
                .map(|map| Json::Object(map.clone()).to_string()),
            body: notify
                .get("body")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            options: notify
                .get("options")
                .and_then(|value| value.as_object())
                .map(|map| Json::Object(map.clone()).to_string()),
        })
    });
    let notify_enabled = notify_request.is_some();

    let precheck = object.get("precheck").and_then(|value| value.as_object());
    let precheck_enabled = precheck
        .and_then(|value| value.get("enabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let weekdays: Option<Vec<i64>> = match precheck.and_then(|value| value.get("weekdays")) {
        Some(Json::Array(items)) => Some(
            items
                .iter()
                .filter_map(|item| item.as_i64())
                .filter(|day| (0..=6).contains(day))
                .collect(),
        ),
        Some(Json::String(text)) if !text.trim().is_empty() => Some(
            text.split(',')
                .filter_map(|part| part.trim().parse::<i64>().ok())
                .filter(|day| (0..=6).contains(day))
                .collect(),
        ),
        _ => None,
    };

    Ok(NewTaskInput {
        name,
        curl_command: object
            .get("curl")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        request: RequestParts {
            url: spec.url,
            method: spec.method,
            headers: Some(Json::Object(spec.headers).to_string()),
            body: spec.body,
            options: spec
                .options
                .map(|options| serde_json::to_string(&options).unwrap_or_else(|_| "{}".to_string())),
        },
        window_start: object
            .get("window_start")
            .and_then(|value| value.as_str())
            .unwrap_or("23:00")
            .to_string(),
        window_end: object
            .get("window_end")
            .and_then(|value| value.as_str())
            .unwrap_or("23:05")
            .to_string(),
        daily_jitter_minutes: object
            .get("daily_jitter_minutes")
            .and_then(|value| value.as_i64()),
        schedule_kind: object
            .get("schedule_kind")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        interval_seconds: object.get("interval_seconds").and_then(|value| value.as_i64()),
        interval_jitter_seconds: object
            .get("interval_jitter_seconds")
            .and_then(|value| value.as_i64()),
        interval_start_at: object.get("interval_start_at").and_then(|value| value.as_i64()),
        notify_enabled,
        notify_curl_command: notify_curl,
        notify_request,
        expect_status: object.get("expect_status").and_then(|value| value.as_i64()),
        expect_body: object
            .get("expect_body")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        expect_expr: object
            .get("expect_expr")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        precheck_enabled,
        precheck_curl_command: precheck
            .and_then(|value| value.get("curl"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        precheck_request: precheck
            .and_then(|value| value.get("url"))
            .and_then(|value| value.as_str())
            .map(|url| RequestParts {
                url: url.to_string(),
                method: precheck
                    .and_then(|value| value.get("method"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("GET")
                    .to_string(),
                headers: precheck
                    .and_then(|value| value.get("headers"))
                    .and_then(|value| value.as_object())
                    .map(|map| Json::Object(map.clone()).to_string()),
                body: precheck
                    .and_then(|value| value.get("body"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                options: None,
            }),
        precheck_expect_status: precheck
            .and_then(|value| value.get("expect_status"))
            .and_then(|value| value.as_i64()),
        precheck_expr: precheck
            .and_then(|value| value.get("expr"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        precheck_weekdays: weekdays,
        precheck_time_start: precheck
            .and_then(|value| value.get("time_start"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        precheck_time_end: precheck
            .and_then(|value| value.get("time_end"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

/// 任务行 → 前端视图（调度描述、下次执行时间等派生字段）。
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
    let description = schedule_of(&stored)
        .map(|spec| jitter_core::schedule::describe_schedule(&spec))
        .unwrap_or_else(|_| "定时执行".to_string());
    let mut view = serde_json::to_value(task).unwrap_or(Json::Null);
    if let Some(object) = view.as_object_mut() {
        object.insert("schedule_description".to_string(), Json::String(description));
    }
    view
}

async fn list_tasks() -> Response {
    match db::list_tasks() {
        Ok(tasks) => AxumJson(json!({ "tasks": tasks })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn create_task(AxumJson(body): AxumJson<Json>) -> Response {
    let input = match parse_task_input(&body) {
        Ok(input) => input,
        Err(message) => return bad_request(message),
    };
    // 调度校验。
    let mut fields = JsonMap::new();
    fields.insert("schedule_kind".into(), body.get("schedule_kind").cloned().unwrap_or(Json::Null));
    fields.insert("window_start".into(), Json::String(input.window_start.clone()));
    fields.insert("window_end".into(), Json::String(input.window_end.clone()));
    fields.insert(
        "daily_jitter_minutes".into(),
        input.daily_jitter_minutes.map(Json::from).unwrap_or(Json::Null),
    );
    fields.insert(
        "interval_seconds".into(),
        input.interval_seconds.map(Json::from).unwrap_or(Json::Null),
    );
    fields.insert(
        "interval_jitter_seconds".into(),
        input.interval_jitter_seconds.map(Json::from).unwrap_or(Json::Null),
    );
    if let Err(error) = build_schedule(&fields) {
        return bad_request(error.0);
    }
    let id = uuid();
    match db::create_task(&input, &id, executor::now_ms()) {
        Ok(task) => {
            scheduler::schedule_new_task(&task.id);
            (StatusCode::CREATED, AxumJson(json!({ "task": task_view(&task) }))).into_response()
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
            let _ = db::update_task_status(&id, jitter_core::types::TaskStatus::Stopped, None, executor::now_ms());
            AxumJson(json!({ "ok": true })).into_response()
        }
        Ok(Some(_)) => AxumJson(json!({ "ok": true })).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn start_task(Path(id): Path<String>) -> Response {
    match db::get_task(&id) {
        Ok(Some(task)) if task.status == "stopped" => {
            scheduler::schedule_new_task(&task.id);
            AxumJson(json!({ "ok": true })).into_response()
        }
        Ok(Some(_)) => AxumJson(json!({ "ok": true })).into_response(),
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
    tokio::spawn(async move {
        let cancel = tokio_util::sync::CancellationToken::new();
        scheduler::register_running(&id, cancel.clone());
        let _ = executor::execute_task_run(&task, &cancel).await;
        scheduler::finish_run(&id);
    });
    AxumJson(json!({ "ok": true, "started": true })).into_response()
}

async fn pause_task(Path(id): Path<String>, AxumJson(body): AxumJson<Json>) -> Response {
    let days = body.get("days").and_then(|value| value.as_i64()).unwrap_or(1);
    let starts_today = body
        .get("starts_today")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if !(1..=jitter_core::window::MAX_PAUSE_DAYS).contains(&days) {
        return bad_request(format!("暂停天数必须是 1–{} 天", jitter_core::window::MAX_PAUSE_DAYS));
    }
    let now = executor::now_ms();
    let pause = jitter_core::window::pause_interval(now, days, starts_today);
    match db::get_task(&id) {
        Ok(Some(task)) => {
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
            AxumJson(json!({ "ok": true, "paused_from": pause.from, "paused_until": pause.until }))
                .into_response()
        }
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn resume_task(Path(id): Path<String>) -> Response {
    if db::get_task(&id).ok().flatten().is_none() {
        return not_found();
    }
    scheduler::schedule_new_task(&id);
    AxumJson(json!({ "ok": true })).into_response()
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
    if ids.len() != existing.len() || unique.len() != ids.len() || ids.iter().any(|id| !known.contains(id)) {
        return conflict("任务列表已变化，请刷新后重试");
    }
    match db::reorder_tasks(&ids) {
        Ok(()) => {
            let tasks = db::list_tasks().unwrap_or_default();
            AxumJson(json!({ "ok": true, "tasks": tasks })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn list_logs(Path(id): Path<String>, Query(params): Query<std::collections::HashMap<String, String>>) -> Response {
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    let cursor = params.get("cursor").and_then(|value| value.parse::<i64>().ok());
    let before = cursor.map(|executed_at| db::LogCursor {
        executed_at,
        id: params
            .get("cursor_id")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0),
    });
    let since = params.get("since").and_then(|value| value.parse::<i64>().ok());
    match db::list_log_summaries(&id, limit, before, since) {
        Ok(logs) => AxumJson(json!({ "logs": logs })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn get_log_detail(Path(id): Path<String>) -> Response {
    let Ok(log_id) = id.parse::<i64>() else {
        return bad_request("日志 id 必须是数字");
    };
    match db::get_log(log_id) {
        Ok(Some(log)) => AxumJson(json!({ "log": log })).into_response(),
        Ok(None) => not_found(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn metrics() -> Response {
    match get_metrics_report(executor::now_ms(), scheduler::running_count(), 20) {
        Ok(report) => AxumJson(json!({ "metrics": report })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn config() -> Response {
    AxumJson(json!({ "config": get_active_config() })).into_response()
}

async fn get_settings() -> Response {
    let config = get_active_config();
    let retention = db::get_effective_retention_days(config.log_retention_days).unwrap_or(30);
    AxumJson(json!({ "logRetentionDays": retention, "logMaxRowsPerTask": config.log_max_rows_per_task }))
        .into_response()
}

#[derive(Deserialize)]
struct SettingsBody {
    #[serde(rename = "logRetentionDays")]
    log_retention_days: Option<i64>,
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
    get_settings().await
}

async fn cleanup_logs(AxumJson(body): AxumJson<Json>) -> Response {
    let cutoff = body.get("cutoff").and_then(|value| value.as_i64());
    let all = body.get("all").and_then(|value| value.as_bool()).unwrap_or(false);
    let cutoff = if all {
        None
    } else {
        match cutoff {
            Some(value) if value > 0 && value <= executor::now_ms() => Some(value),
            _ => return bad_request("无效的清理截止时间"),
        }
    };
    match db::cleanup_logs(cutoff) {
        Ok(outcome) => AxumJson(json!({ "ok": true, "cleanup": outcome })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.0),
    }
}

async fn cleanup_preview() -> Response {
    match db::get_log_cleanup_preview(executor::now_ms()) {
        Ok(preview) => AxumJson(json!({ "preview": preview })).into_response(),
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

async fn health() -> Response {
    AxumJson(json!({ "ok": true, "now": executor::now_ms() })).into_response()
}

/// 首页（嵌入的前端）。
async fn index() -> Html<&'static str> {
    Html(crate::INDEX_HTML)
}

/// 前端脚本。
async fn app_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        crate::APP_JS,
    )
        .into_response()
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
        Ok(()) => AxumJson(json!({ "ok": true, "autostart": system::is_autostart_enabled() })).into_response(),
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

async fn backup_download(Query(params): Query<std::collections::HashMap<String, String>>) -> Response {
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
            .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\""))
            .body(axum::body::Body::from(bytes))
            .expect("download response"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn backup_upload(
    Query(params): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let name = params.get("name").cloned().unwrap_or_default().trim().to_string();
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
        .route("/app.js", get(app_js))
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
        .route("/api/logs/cleanup", post(cleanup_logs).get(cleanup_preview))
        .route("/api/test", post(test_request))
        .route("/api/system", get(system_info))
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
