//! SQLite 数据层：schema、增量迁移、任务/日志/测试留档/设置的读写、保留清理。
//!
//! 与 TypeScript 版（`src/db.ts`）使用**同一个** schema 与迁移规则，
//! 所以现有数据库文件可以直接被 Rust 版接管，无需任何转换。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Local};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as Json};

use crate::types::{LogKind, TaskStatus};

pub const LOG_RETENTION_SETTING: &str = "logRetentionDays";
/// 全局「默认跳过 TLS 证书校验」开关；缺省视为开启（打卡系统多为自签证书）。
pub const SKIP_TLS_VERIFY_SETTING: &str = "skipTlsVerify";
/// 接通电源时防止系统休眠（默认关闭）。
pub const PREVENT_SLEEP_ON_AC_SETTING: &str = "preventSleepOnAc";

/// 一轮保留清理最多删多少行：无上限的 DELETE 会把服务冻住，积压分批消化。
pub const PRUNE_BATCH_ROWS: i64 = 5000;

/// 每个任务保留多少条测试台留档。
pub const TEST_RUN_KEEP: i64 = 10;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 暴露给 UI 的保留天数选项。
pub const LOG_CLEANUP_DAYS: [i64; 4] = [10, 30, 180, 365];

fn cleanup_label(days: i64) -> String {
    match days {
        10 => "10 天".to_string(),
        30 => "30 天".to_string(),
        180 => "半年".to_string(),
        365 => "一年".to_string(),
        other => format!("{other} 天"),
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  curl_command     TEXT,
  request_url      TEXT NOT NULL,
  request_method   TEXT NOT NULL DEFAULT 'GET',
  request_headers  TEXT,
  request_body     TEXT,
  request_options  TEXT NOT NULL DEFAULT '{}',
  window_start     TEXT NOT NULL,
  window_end       TEXT NOT NULL,
  daily_jitter_minutes INTEGER NOT NULL DEFAULT 0,
  schedule_kind    TEXT NOT NULL DEFAULT 'daily',
  interval_seconds INTEGER,
  interval_jitter_seconds INTEGER NOT NULL DEFAULT 0,
  interval_start_at INTEGER,
  status           TEXT NOT NULL DEFAULT 'active',
  next_run_at      INTEGER,
  paused_from      INTEGER,
  paused_until     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  notify_enabled   INTEGER NOT NULL DEFAULT 0,
  notify_curl_command TEXT,
  notify_url       TEXT,
  notify_method    TEXT,
  notify_headers   TEXT,
  notify_body      TEXT,
  notify_options   TEXT NOT NULL DEFAULT '{}',
  precheck_enabled INTEGER NOT NULL DEFAULT 0,
  precheck_curl_command TEXT,
  precheck_url     TEXT,
  precheck_method  TEXT,
  precheck_headers TEXT,
  precheck_body    TEXT,
  precheck_options TEXT NOT NULL DEFAULT '{}',
  precheck_expect_status INTEGER,
  precheck_expr    TEXT,
  precheck_weekdays TEXT,
  precheck_time_start TEXT,
  precheck_time_end TEXT,
  precheck_require_ac INTEGER NOT NULL DEFAULT 0,
  precheck_ip_pattern TEXT,
  run_on_startup   INTEGER NOT NULL DEFAULT 0,
  expect_status    INTEGER,
  expect_body      TEXT,
  expect_expr      TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  executed_at      INTEGER NOT NULL,
  request_url      TEXT,
  request_method   TEXT,
  request_headers  TEXT,
  request_body     TEXT,
  response_status  INTEGER,
  response_headers TEXT,
  response_body    TEXT,
  duration_ms      INTEGER,
  error            TEXT,
  aborted          INTEGER DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'task',
  parent_log_id    INTEGER,
  matched          INTEGER,
  run_source       TEXT
);

CREATE TABLE IF NOT EXISTS test_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  created_at       INTEGER NOT NULL,
  ok               INTEGER NOT NULL,
  summary          TEXT NOT NULL,
  steps            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_task_time ON logs(task_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(executed_at);
CREATE INDEX IF NOT EXISTS idx_test_runs_task ON test_runs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_summary
  ON logs(task_id, executed_at DESC, id DESC, response_status, duration_ms, error, aborted, kind, parent_log_id, matched);
CREATE INDEX IF NOT EXISTS idx_logs_metrics
  ON logs(executed_at, kind, response_status, error, duration_ms);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holiday_years (
  year       INTEGER PRIMARY KEY,
  days       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  day_count  INTEGER NOT NULL
);
"#;

// ---------------------------------------------------------------------------
// 行类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub name: String,
    pub curl_command: Option<String>,
    pub request_url: String,
    pub request_method: String,
    pub request_headers: Option<String>,
    pub request_body: Option<String>,
    pub request_options: Option<String>,
    pub window_start: String,
    pub window_end: String,
    pub daily_jitter_minutes: i64,
    pub schedule_kind: String,
    pub interval_seconds: Option<i64>,
    pub interval_jitter_seconds: i64,
    pub interval_start_at: Option<i64>,
    pub status: String,
    pub next_run_at: Option<i64>,
    pub paused_from: Option<i64>,
    pub paused_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub sort_order: i64,
    pub notify_enabled: i64,
    pub notify_curl_command: Option<String>,
    pub notify_url: Option<String>,
    pub notify_method: Option<String>,
    pub notify_headers: Option<String>,
    pub notify_body: Option<String>,
    pub notify_options: Option<String>,
    pub precheck_enabled: i64,
    pub precheck_curl_command: Option<String>,
    pub precheck_url: Option<String>,
    pub precheck_method: Option<String>,
    pub precheck_headers: Option<String>,
    pub precheck_body: Option<String>,
    pub precheck_options: Option<String>,
    pub precheck_expect_status: Option<i64>,
    pub precheck_expr: Option<String>,
    pub precheck_weekdays: Option<String>,
    pub precheck_time_start: Option<String>,
    pub precheck_time_end: Option<String>,
    pub precheck_require_ac: i64,
    pub precheck_ip_pattern: Option<String>,
    /// 工作日 / 休息日条件：`workday` / `offday`；NULL 表示不限制。
    pub precheck_day_type: Option<String>,
    /// 必须已连接网络（WiFi / 网线）才执行；0 = 不限制。
    pub precheck_require_network: i64,
    /// 这个任务的日志保留天数；NULL = 跟随全局设置，0 = 永久保留。
    pub log_retention_days: Option<i64>,
    pub run_on_startup: i64,
    pub expect_status: Option<i64>,
    pub expect_body: Option<String>,
    pub expect_expr: Option<String>,
}

fn map_task(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get("id")?,
        name: row.get("name")?,
        curl_command: row.get("curl_command")?,
        request_url: row.get("request_url")?,
        request_method: row.get("request_method")?,
        request_headers: row.get("request_headers")?,
        request_body: row.get("request_body")?,
        request_options: row.get("request_options")?,
        window_start: row.get("window_start")?,
        window_end: row.get("window_end")?,
        daily_jitter_minutes: row.get("daily_jitter_minutes")?,
        schedule_kind: row.get("schedule_kind")?,
        interval_seconds: row.get("interval_seconds")?,
        interval_jitter_seconds: row.get("interval_jitter_seconds")?,
        interval_start_at: row.get("interval_start_at")?,
        status: row.get("status")?,
        next_run_at: row.get("next_run_at")?,
        paused_from: row.get("paused_from")?,
        paused_until: row.get("paused_until")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        sort_order: row.get("sort_order")?,
        notify_enabled: row.get("notify_enabled")?,
        notify_curl_command: row.get("notify_curl_command")?,
        notify_url: row.get("notify_url")?,
        notify_method: row.get("notify_method")?,
        notify_headers: row.get("notify_headers")?,
        notify_body: row.get("notify_body")?,
        notify_options: row.get("notify_options")?,
        precheck_enabled: row.get("precheck_enabled")?,
        precheck_curl_command: row.get("precheck_curl_command")?,
        precheck_url: row.get("precheck_url")?,
        precheck_method: row.get("precheck_method")?,
        precheck_headers: row.get("precheck_headers")?,
        precheck_body: row.get("precheck_body")?,
        precheck_options: row.get("precheck_options")?,
        precheck_expect_status: row.get("precheck_expect_status")?,
        precheck_expr: row.get("precheck_expr")?,
        precheck_weekdays: row.get("precheck_weekdays")?,
        precheck_time_start: row.get("precheck_time_start")?,
        precheck_time_end: row.get("precheck_time_end")?,
        precheck_require_ac: row.get("precheck_require_ac")?,
        precheck_ip_pattern: row.get("precheck_ip_pattern")?,
        precheck_day_type: row.get("precheck_day_type")?,
        precheck_require_network: row.get("precheck_require_network")?,
        log_retention_days: row.get("log_retention_days")?,
        run_on_startup: row.get("run_on_startup")?,
        expect_status: row.get("expect_status")?,
        expect_body: row.get("expect_body")?,
        expect_expr: row.get("expect_expr")?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogRow {
    pub id: i64,
    pub task_id: String,
    pub executed_at: i64,
    pub request_url: Option<String>,
    pub request_method: Option<String>,
    pub request_headers: Option<String>,
    pub request_body: Option<String>,
    pub response_status: Option<i64>,
    pub response_headers: Option<String>,
    pub response_body: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub aborted: i64,
    pub kind: String,
    pub parent_log_id: Option<i64>,
    pub matched: Option<i64>,
    /// 触发来源：scheduled（定时）/ manual（立即执行）；历史数据为 NULL。
    pub run_source: Option<String>,
}

const LOG_FULL_COLUMNS: &str = "id, task_id, executed_at, request_url, request_method, request_headers, request_body, response_status, response_headers, response_body, duration_ms, error, aborted, kind, parent_log_id, matched, run_source";

fn map_log(row: &Row<'_>) -> rusqlite::Result<LogRow> {
    Ok(LogRow {
        id: row.get(0)?,
        task_id: row.get(1)?,
        executed_at: row.get(2)?,
        request_url: row.get(3)?,
        request_method: row.get(4)?,
        request_headers: row.get(5)?,
        request_body: row.get(6)?,
        response_status: row.get(7)?,
        response_headers: row.get(8)?,
        response_body: row.get(9)?,
        duration_ms: row.get(10)?,
        error: row.get(11)?,
        aborted: row.get(12)?,
        kind: row.get(13)?,
        parent_log_id: row.get(14)?,
        matched: row.get(15)?,
        run_source: row.get(16)?,
    })
}

/// 日志列表用的轻量行（不带请求/响应正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSummary {
    pub id: i64,
    pub task_id: String,
    pub executed_at: i64,
    pub request_url: Option<String>,
    pub request_method: Option<String>,
    pub response_status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub aborted: i64,
    pub kind: String,
    pub parent_log_id: Option<i64>,
    pub matched: Option<i64>,
    /// 触发来源：scheduled（定时）/ manual（立即执行）；历史数据为 NULL。
    pub run_source: Option<String>,
}

const LOG_SUMMARY_COLUMNS: &str = "id, task_id, executed_at, request_url, request_method, response_status, duration_ms, error, aborted, kind, parent_log_id, matched, run_source";

fn map_log_summary(row: &Row<'_>) -> rusqlite::Result<LogSummary> {
    Ok(LogSummary {
        id: row.get(0)?,
        task_id: row.get(1)?,
        executed_at: row.get(2)?,
        request_url: row.get(3)?,
        request_method: row.get(4)?,
        response_status: row.get(5)?,
        duration_ms: row.get(6)?,
        error: row.get(7)?,
        aborted: row.get(8)?,
        kind: row.get(9)?,
        parent_log_id: row.get(10)?,
        matched: row.get(11)?,
        run_source: row.get(12)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestRunRow {
    pub id: i64,
    pub task_id: String,
    pub created_at: i64,
    pub ok: i64,
    pub summary: String,
    pub steps: String,
}

// ---------------------------------------------------------------------------
// 输入类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct RequestParts {
    pub url: String,
    pub method: String,
    pub headers: Option<String>,
    pub body: Option<String>,
    pub options: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NewTaskInput {
    pub name: String,
    pub curl_command: Option<String>,
    pub request: RequestParts,
    pub window_start: String,
    pub window_end: String,
    pub daily_jitter_minutes: Option<i64>,
    pub schedule_kind: Option<String>,
    pub interval_seconds: Option<i64>,
    pub interval_jitter_seconds: Option<i64>,
    pub interval_start_at: Option<i64>,
    pub notify_enabled: bool,
    pub notify_curl_command: Option<String>,
    pub notify_request: Option<RequestParts>,
    pub expect_status: Option<i64>,
    pub expect_body: Option<String>,
    pub expect_expr: Option<String>,
    pub precheck_enabled: bool,
    pub precheck_curl_command: Option<String>,
    pub precheck_request: Option<RequestParts>,
    pub precheck_expect_status: Option<i64>,
    pub precheck_expr: Option<String>,
    pub precheck_weekdays: Option<Vec<i64>>,
    pub precheck_time_start: Option<String>,
    pub precheck_time_end: Option<String>,
    pub precheck_require_ac: bool,
    /// 必须已连接网络（WiFi 或网线）才执行。
    pub precheck_require_network: bool,
    /// 这个任务的日志保留天数：None = 跟随全局设置，Some(0) = 永久保留。
    pub log_retention_days: Option<i64>,
    pub precheck_ip_pattern: Option<String>,
    /// `workday`（仅工作日）/ `offday`（仅休息日）；None 表示不限制。
    pub precheck_day_type: Option<String>,
    /// Jitter 启动后自动执行一次（单任务配置，默认关闭）。
    pub run_on_startup: bool,
}

/// 创建/更新任务共用的列值计算（guard 开关的判定逻辑与 TS 版一致）。
struct TaskColumns {
    notify_enabled: i64,
    notify: Option<RequestParts>,
    precheck: Option<RequestParts>,
    guard_enabled: bool,
    weekdays: Option<String>,
    require_ac: bool,
    require_network: bool,
    ip_pattern: Option<String>,
    day_type: Option<String>,
    log_retention_days: Option<i64>,
}

fn task_columns(input: &NewTaskInput) -> TaskColumns {
    let notify_enabled = if input.notify_enabled { 1 } else { 0 };
    let notify = if notify_enabled == 1 {
        input.notify_request.clone()
    } else {
        None
    };
    let precheck = if input.precheck_enabled {
        input.precheck_request.clone()
    } else {
        None
    };
    let local_guard = input
        .precheck_weekdays
        .as_ref()
        .map(|days| !days.is_empty())
        .unwrap_or(false)
        || input.precheck_time_start.is_some()
        || input.precheck_time_end.is_some()
        || input.precheck_day_type.is_some();
    let host_guard = input.precheck_require_ac
        || input.precheck_require_network
        || input
            .precheck_ip_pattern
            .as_ref()
            .map_or(false, |pattern| !pattern.is_empty());
    let guard_enabled = input.precheck_enabled && (precheck.is_some() || local_guard || host_guard);
    let weekdays = if guard_enabled {
        input
            .precheck_weekdays
            .as_ref()
            .filter(|days| !days.is_empty())
            .map(|days| {
                days.iter()
                    .map(|day| day.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            })
    } else {
        None
    };
    let ip_pattern = if guard_enabled {
        input
            .precheck_ip_pattern
            .clone()
            .filter(|pattern| !pattern.is_empty())
    } else {
        None
    };
    let day_type = if guard_enabled {
        input.precheck_day_type.clone().filter(|value| {
            value == "workday" || value == "offday"
        })
    } else {
        None
    };
    TaskColumns {
        notify_enabled,
        notify,
        precheck,
        guard_enabled,
        weekdays,
        require_ac: guard_enabled && input.precheck_require_ac,
        require_network: guard_enabled && input.precheck_require_network,
        ip_pattern,
        day_type,
        // 只接受 0（永久）或 1–3650 天，其余按“跟随全局”处理。
        log_retention_days: input
            .log_retention_days
            .filter(|days| (0..=3650).contains(days)),
    }
}

// ---------------------------------------------------------------------------
// 全局连接
// ---------------------------------------------------------------------------

pub struct Db {
    conn: Connection,
    path: PathBuf,
}

static DB: OnceLock<Mutex<Option<Db>>> = OnceLock::new();

fn db_slot() -> &'static Mutex<Option<Db>> {
    DB.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbError(pub String);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        DbError(error.to_string())
    }
}

fn with_db<T>(
    callback: impl FnOnce(&mut Connection, &Path) -> Result<T, DbError>,
) -> Result<T, DbError> {
    let mut guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = guard
        .as_mut()
        .ok_or_else(|| DbError("数据库尚未初始化，请先调用 initDb()".into()))?;
    let path = db.path.clone();
    callback(&mut db.conn, &path)
}

/// 兼容直接要连接的调用方（备份模块的 VACUUM INTO 等）。
pub fn with_connection<T>(
    callback: impl FnOnce(&Connection) -> Result<T, DbError>,
) -> Result<T, DbError> {
    let mut guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = guard
        .as_mut()
        .ok_or_else(|| DbError("数据库尚未初始化，请先调用 initDb()".into()))?;
    callback(&db.conn)
}

pub fn close_db() {
    let mut guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
}

/// 解析数据库路径：显式参数 > 环境变量 > 默认 data/app.db。
pub fn resolve_db_path(path: Option<&str>, env: Option<&str>) -> PathBuf {
    let candidate = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| env.map(str::trim).filter(|value| !value.is_empty()));
    match candidate {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from("data").join("app.db"),
    }
}

/// 追加列；返回 true 表示该列是本次新增的（需要回填的列据此只回填一次）。
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<bool, DbError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|result| result.ok())
        .collect();
    if !columns.iter().any(|name| name == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
        return Ok(true);
    }
    Ok(false)
}

/// 本地零点，可按整自然日偏移（DST 安全）。
pub fn local_day_start(timestamp: i64, offset_days: i64) -> i64 {
    let datetime = DateTime::from_timestamp_millis(timestamp)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch"))
        .with_timezone(&Local);
    let date = if offset_days >= 0 {
        datetime.date_naive() + chrono::Days::new(offset_days as u64)
    } else {
        datetime.date_naive() - chrono::Days::new((-offset_days) as u64)
    };
    date.and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or(timestamp)
}

/// 旧版只存 `paused_until`，会让「明天开始暂停」变成「立即开始」；
/// 升级时用确定规则补 `paused_from`（详见 TS 版注释）。
fn backfill_pause_from(conn: &mut Connection) -> Result<(), DbError> {
    let mut rows: Vec<(String, i64)> = {
        let mut statement = conn.prepare(
            "SELECT id, paused_until FROM tasks WHERE paused_until IS NOT NULL AND paused_from IS NULL",
        )?;
        let mapped = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .filter_map(|result| result.ok())
            .collect();
        mapped
    };
    if rows.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let today = local_day_start(now, 0);
    let mut inferred = 0usize;
    for (id, paused_until) in rows.drain(..) {
        if paused_until <= now {
            conn.execute(
                "UPDATE tasks SET paused_from = NULL, paused_until = NULL WHERE id = ?1",
                params![id],
            )?;
            continue;
        }
        conn.execute(
            "UPDATE tasks SET paused_from = ?1, next_run_at = NULL WHERE id = ?2",
            params![today, id],
        )?;
        inferred += 1;
    }
    tracing::warn!(
        "[jitter] 已迁移 {} 条旧版暂停记录（{} 条按「升级当天 00:00 起继续暂停至原恢复时刻」处理）；如有需要请重新设置一次暂停",
        rows.len(),
        inferred
    );
    Ok(())
}

fn is_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[0] <= b'2'
        && (bytes[0] < b'2' || bytes[1] <= b'3')
        && bytes[3] <= b'5'
}

/// 旧调度（含已移除的 Cron）修复为每天窗口。
fn backfill_schedule_kind(conn: &mut Connection) -> Result<(), DbError> {
    let broken: Vec<(String, String, Option<String>, String, String)> = {
        let mut statement = conn.prepare(
            "SELECT id, name, schedule_kind, window_start, window_end
               FROM tasks
              WHERE schedule_kind IS NULL OR schedule_kind NOT IN ('daily', 'interval')",
        )?;
        let mapped: Vec<(String, String, Option<String>, String, String)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .filter_map(|result| result.ok())
            .collect();
        mapped
    };
    if broken.is_empty() {
        return Ok(());
    }
    for (id, name, _, window_start, window_end) in broken {
        let has_window =
            is_hhmm(&window_start) && is_hhmm(&window_end) && window_start != window_end;
        if has_window {
            conn.execute(
                "UPDATE tasks SET schedule_kind = 'daily', daily_jitter_minutes = 0,
                        interval_seconds = NULL, interval_jitter_seconds = 0,
                        interval_start_at = NULL WHERE id = ?1",
                params![id],
            )?;
        } else {
            conn.execute(
                "UPDATE tasks SET schedule_kind = 'daily', daily_jitter_minutes = 0,
                        interval_seconds = NULL, interval_jitter_seconds = 0,
                        interval_start_at = NULL, window_start = ?1, window_end = ?2,
                        next_run_at = NULL WHERE id = ?3",
                params!["00:00", "00:05", id],
            )?;
        }
        tracing::warn!("[jitter] 已把旧调度「{name}」改为「每天窗口」；请到页面确认执行时间");
    }
    Ok(())
}

/// 给每个任务一个显式位置，保持「最新在前」的可见顺序。
fn backfill_sort_order(conn: &mut Connection) -> Result<(), DbError> {
    let ids: Vec<String> = {
        let mut statement =
            conn.prepare("SELECT id FROM tasks ORDER BY created_at DESC, rowid DESC")?;
        let mapped: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|result| result.ok())
            .collect();
        mapped
    };
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tasks SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    ensure_column(
        conn,
        "tasks",
        "request_options",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        conn,
        "tasks",
        "notify_options",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(conn, "tasks", "paused_until", "INTEGER")?;
    ensure_column(conn, "tasks", "paused_from", "INTEGER")?;
    ensure_column(conn, "tasks", "expect_expr", "TEXT")?;
    ensure_column(
        conn,
        "tasks",
        "schedule_kind",
        "TEXT NOT NULL DEFAULT 'daily'",
    )?;
    ensure_column(
        conn,
        "tasks",
        "daily_jitter_minutes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "tasks", "interval_seconds", "INTEGER")?;
    ensure_column(
        conn,
        "tasks",
        "interval_jitter_seconds",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "tasks", "interval_start_at", "INTEGER")?;
    ensure_column(
        conn,
        "tasks",
        "precheck_enabled",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "tasks", "precheck_curl_command", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_url", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_method", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_headers", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_body", "TEXT")?;
    ensure_column(
        conn,
        "tasks",
        "precheck_options",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(conn, "tasks", "precheck_expect_status", "INTEGER")?;
    ensure_column(conn, "tasks", "precheck_expr", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_weekdays", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_time_start", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_time_end", "TEXT")?;
    ensure_column(
        conn,
        "tasks",
        "precheck_require_ac",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "tasks", "precheck_ip_pattern", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_day_type", "TEXT")?;
    ensure_column(
        conn,
        "tasks",
        "precheck_require_network",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "tasks", "log_retention_days", "INTEGER")?;
    ensure_column(
        conn,
        "tasks",
        "run_on_startup",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "logs", "run_source", "TEXT")?;
    let sort_order_added =
        ensure_column(conn, "tasks", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
    // 只在列刚加时按创建时间回填一次；之后必须尊重用户拖动后的顺序。
    if sort_order_added {
        backfill_sort_order(conn)?;
    }
    backfill_schedule_kind(conn)?;
    backfill_pause_from(conn)?;
    Ok(())
}

/// 打开（或复用）数据库连接。
pub fn init_db(path: Option<&str>) -> Result<(), DbError> {
    let target = resolve_db_path(path, std::env::var("JITTER_DB_PATH").ok().as_deref());
    let mut guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = guard.as_ref() {
        if existing.path == target {
            return Ok(());
        }
    }
    *guard = None;

    if target != Path::new(":memory:") {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                DbError(format!("无法创建数据目录 {}: {error}", parent.display()))
            })?;
        }
    }

    let mut conn = Connection::open(&target)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // 必须在第一次建表之前设置：新库会以小块回收页，而不是等一次全量 VACUUM。
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.execute_batch(SCHEMA)?;
    migrate(&mut conn)?;

    *guard = Some(Db { conn, path: target });
    Ok(())
}

/// 新任务的位置：比当前最靠前的还要靠前（历史行为「最新在前」）。
pub fn next_sort_order() -> Result<i64, DbError> {
    with_db(|conn, _| {
        let value: Option<i64> = conn
            .query_row("SELECT MIN(sort_order) FROM tasks", [], |row| row.get(0))
            .unwrap_or(None);
        Ok(value.map_or(0, |min| min - 1))
    })
}

/// 保存任务列表的新顺序（ids 必须是现有任务的完整排列）。
pub fn reorder_tasks(ids: &[String]) -> Result<(), DbError> {
    with_db(|conn, _| {
        let tx = conn.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE tasks SET sort_order = ?1 WHERE id = ?2",
                params![index as i64, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn create_task(input: &NewTaskInput, id: &str, now: i64) -> Result<TaskRow, DbError> {
    let columns = task_columns(input);
    let sort_order = next_sort_order()?;
    let notify = columns.notify.as_ref();
    let precheck = columns.precheck.as_ref();
    with_db(|conn, _| {
        conn.execute(
            "INSERT INTO tasks (
              id, name, curl_command, request_url, request_method, request_headers, request_body, request_options,
              window_start, window_end, daily_jitter_minutes, schedule_kind, interval_seconds, interval_jitter_seconds,
              interval_start_at,
              status, next_run_at, paused_from, paused_until, created_at, updated_at, sort_order,
              notify_enabled, notify_curl_command, notify_url, notify_method, notify_headers, notify_body, notify_options,
              precheck_enabled, precheck_curl_command, precheck_url, precheck_method, precheck_headers,
              precheck_body, precheck_options, precheck_expect_status, precheck_expr,
              precheck_weekdays, precheck_time_start, precheck_time_end,
              precheck_require_ac, precheck_require_network, precheck_ip_pattern, precheck_day_type,
              expect_status, expect_body, expect_expr, log_retention_days, run_on_startup
            ) VALUES (
              ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
              ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?45,?46,?47,?48,?49,?50
            )",
            params![
                id,
                input.name,
                input.curl_command,
                input.request.url,
                input.request.method,
                input.request.headers.clone().unwrap_or_else(|| "{}".into()),
                input.request.body,
                input.request.options.clone().unwrap_or_else(|| "{}".into()),
                input.window_start,
                input.window_end,
                input.daily_jitter_minutes.unwrap_or(0),
                input.schedule_kind.clone().unwrap_or_else(|| "daily".into()),
                input.interval_seconds,
                input.interval_jitter_seconds.unwrap_or(0),
                input.interval_start_at,
                "active",
                None::<i64>,
                None::<i64>,
                None::<i64>,
                now,
                now,
                sort_order,
                columns.notify_enabled,
                if columns.notify_enabled == 1 { input.notify_curl_command.clone() } else { None },
                notify.map(|request| request.url.clone()),
                notify.map(|request| request.method.clone()),
                notify.map(|request| request.headers.clone().unwrap_or_else(|| "{}".into())),
                notify.and_then(|request| request.body.clone()),
                notify.map(|request| request.options.clone().unwrap_or_else(|| "{}".into()))
                    .unwrap_or_else(|| "{}".into()),
                if columns.guard_enabled { 1 } else { 0 },
                precheck.and_then(|_| input.precheck_curl_command.clone()),
                precheck.map(|request| request.url.clone()),
                precheck.map(|request| request.method.clone()),
                precheck.map(|request| request.headers.clone().unwrap_or_else(|| "{}".into())),
                precheck.and_then(|request| request.body.clone()),
                precheck.map(|request| request.options.clone().unwrap_or_else(|| "{}".into()))
                    .unwrap_or_else(|| "{}".into()),
                precheck.and(input.precheck_expect_status),
                precheck.and(input.precheck_expr.clone()),
                columns.weekdays,
                if columns.guard_enabled { input.precheck_time_start.clone() } else { None },
                if columns.guard_enabled { input.precheck_time_end.clone() } else { None },
                if columns.require_ac { 1 } else { 0 },
                if columns.require_network { 1 } else { 0 },
                columns.ip_pattern,
                columns.day_type,
                input.expect_status,
                input.expect_body,
                input.expect_expr,
                columns.log_retention_days,
                if input.run_on_startup { 1 } else { 0 },
            ],
        )?;
        Ok(())
    })?;
    get_task(id)?.ok_or_else(|| DbError("任务写入后无法读取".into()))
}

/// 覆盖任务的可编辑配置，保留 id/status/next_run_at/paused_*/created_at。
pub fn update_task_config(
    id: &str,
    input: &NewTaskInput,
    now: i64,
) -> Result<Option<TaskRow>, DbError> {
    let columns = task_columns(input);
    let notify = columns.notify.as_ref();
    let precheck = columns.precheck.as_ref();
    with_db(|conn, _| {
        conn.execute(
            "UPDATE tasks SET
              name = ?1, curl_command = ?2, request_url = ?3, request_method = ?4, request_headers = ?5,
              request_body = ?6, request_options = ?7, window_start = ?8, window_end = ?9,
              daily_jitter_minutes = ?10, schedule_kind = ?11, interval_seconds = ?12,
              interval_jitter_seconds = ?13, interval_start_at = ?14,
              notify_enabled = ?15, notify_curl_command = ?16, notify_url = ?17, notify_method = ?18,
              notify_headers = ?19, notify_body = ?20, notify_options = ?21,
              precheck_enabled = ?22, precheck_curl_command = ?23, precheck_url = ?24, precheck_method = ?25,
              precheck_headers = ?26, precheck_body = ?27, precheck_options = ?28,
              precheck_expect_status = ?29, precheck_expr = ?30,
              precheck_weekdays = ?31, precheck_time_start = ?32, precheck_time_end = ?33,
              precheck_require_ac = ?34, precheck_require_network = ?35,
              precheck_ip_pattern = ?36, precheck_day_type = ?37,
              expect_status = ?38, expect_body = ?39, expect_expr = ?40,
              log_retention_days = ?41, run_on_startup = ?42, updated_at = ?43
             WHERE id = ?44",
            params![
                input.name,
                input.curl_command,
                input.request.url,
                input.request.method,
                input.request.headers.clone().unwrap_or_else(|| "{}".into()),
                input.request.body,
                input.request.options.clone().unwrap_or_else(|| "{}".into()),
                input.window_start,
                input.window_end,
                input.daily_jitter_minutes.unwrap_or(0),
                input.schedule_kind.clone().unwrap_or_else(|| "daily".into()),
                input.interval_seconds,
                input.interval_jitter_seconds.unwrap_or(0),
                input.interval_start_at,
                columns.notify_enabled,
                if columns.notify_enabled == 1 { input.notify_curl_command.clone() } else { None },
                notify.map(|request| request.url.clone()),
                notify.map(|request| request.method.clone()),
                notify.map(|request| request.headers.clone().unwrap_or_else(|| "{}".into())),
                notify.and_then(|request| request.body.clone()),
                notify.map(|request| request.options.clone().unwrap_or_else(|| "{}".into()))
                    .unwrap_or_else(|| "{}".into()),
                if columns.guard_enabled { 1 } else { 0 },
                precheck.and_then(|_| input.precheck_curl_command.clone()),
                precheck.map(|request| request.url.clone()),
                precheck.map(|request| request.method.clone()),
                precheck.map(|request| request.headers.clone().unwrap_or_else(|| "{}".into())),
                precheck.and_then(|request| request.body.clone()),
                precheck.map(|request| request.options.clone().unwrap_or_else(|| "{}".into()))
                    .unwrap_or_else(|| "{}".into()),
                precheck.and(input.precheck_expect_status),
                precheck.and(input.precheck_expr.clone()),
                columns.weekdays,
                if columns.guard_enabled { input.precheck_time_start.clone() } else { None },
                if columns.guard_enabled { input.precheck_time_end.clone() } else { None },
                if columns.require_ac { 1 } else { 0 },
                if columns.require_network { 1 } else { 0 },
                columns.ip_pattern,
                columns.day_type,
                input.expect_status,
                input.expect_body,
                input.expect_expr,
                columns.log_retention_days,
                if input.run_on_startup { 1 } else { 0 },
                now,
                id,
            ],
        )?;
        Ok(())
    })?;
    get_task(id)
}

pub fn get_task(id: &str) -> Result<Option<TaskRow>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn.prepare("SELECT * FROM tasks WHERE id = ?1")?;
        let mut rows = statement.query_map(params![id], map_task)?;
        Ok(rows.next().transpose()?)
    })
}

pub fn list_tasks() -> Result<Vec<TaskRow>, DbError> {
    with_db(|conn, _| {
        let mut statement =
            conn.prepare("SELECT * FROM tasks ORDER BY sort_order ASC, created_at DESC")?;
        let rows = statement.query_map([], map_task)?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct DeleteTaskOutcome {
    pub deleted: bool,
    pub deleted_logs: i64,
    pub deleted_test_runs: i64,
}

/// 删除任务连带全部日志与测试留档（一个事务里完成）。
pub fn delete_task(id: &str) -> Result<DeleteTaskOutcome, DbError> {
    with_db(|conn, _| {
        let tx = conn.transaction()?;
        let tests = tx.execute("DELETE FROM test_runs WHERE task_id = ?1", params![id])? as i64;
        let logs = tx.execute("DELETE FROM logs WHERE task_id = ?1", params![id])? as i64;
        let task = tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])? as i64;
        tx.commit()?;
        Ok(DeleteTaskOutcome {
            deleted: task > 0,
            deleted_logs: logs,
            deleted_test_runs: tests,
        })
    })
}

pub fn update_task_next_run(id: &str, next_run_at: Option<i64>, now: i64) -> Result<(), DbError> {
    with_db(|conn, _| {
        conn.execute(
            "UPDATE tasks SET next_run_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![next_run_at, now, id],
        )?;
        Ok(())
    })
}

/// 持久化暂停区间（`None` 清除）与下一次执行。
pub fn set_task_pause(
    id: &str,
    pause: Option<(i64, i64)>,
    next_run_at: Option<i64>,
    now: i64,
) -> Result<(), DbError> {
    with_db(|conn, _| {
        conn.execute(
            "UPDATE tasks SET paused_from = ?1, paused_until = ?2, next_run_at = ?3, updated_at = ?4 WHERE id = ?5",
            params![pause.map(|pair| pair.0), pause.map(|pair| pair.1), next_run_at, now, id],
        )?;
        Ok(())
    })
}

pub fn update_task_status(
    id: &str,
    status: TaskStatus,
    next_run_at: Option<i64>,
    now: i64,
) -> Result<(), DbError> {
    let text = match status {
        TaskStatus::Active => "active",
        TaskStatus::Stopped => "stopped",
    };
    with_db(|conn, _| {
        conn.execute(
            "UPDATE tasks SET status = ?1, next_run_at = ?2, updated_at = ?3 WHERE id = ?4",
            params![text, next_run_at, now, id],
        )?;
        Ok(())
    })
}

#[derive(Debug, Clone, Default)]
pub struct NewLogInput {
    pub task_id: String,
    pub executed_at: i64,
    pub request_url: Option<String>,
    pub request_method: Option<String>,
    pub request_headers: Option<String>,
    pub request_body: Option<String>,
    pub response_status: Option<i64>,
    pub response_headers: Option<String>,
    pub response_body: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub aborted: i64,
    pub kind: Option<LogKind>,
    pub parent_log_id: Option<i64>,
    pub matched: Option<i64>,
    /// 触发来源：scheduled（定时）/ manual（立即执行）。
    pub run_source: Option<String>,
}

pub fn insert_log(input: &NewLogInput) -> Result<i64, DbError> {
    with_db(|conn, _| {
        conn.execute(
            "INSERT INTO logs (
              task_id, executed_at, request_url, request_method, request_headers, request_body,
              response_status, response_headers, response_body, duration_ms, error, aborted,
              kind, parent_log_id, matched, run_source
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                input.task_id,
                input.executed_at,
                input.request_url,
                input.request_method,
                input.request_headers,
                input.request_body,
                input.response_status,
                input.response_headers,
                input.response_body,
                input.duration_ms,
                input.error,
                input.aborted,
                input.kind.map(|kind| kind.as_str()).unwrap_or("task"),
                input.parent_log_id,
                input.matched,
                input.run_source,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

pub fn get_log(id: i64) -> Result<Option<LogRow>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn.prepare(&format!(
            "SELECT {LOG_FULL_COLUMNS} FROM logs WHERE id = ?1"
        ))?;
        let mut rows = statement.query_map(params![id], map_log)?;
        Ok(rows.next().transpose()?)
    })
}

/// 「加载更早」的键集分页游标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogCursor {
    pub executed_at: i64,
    pub id: i64,
}

pub fn list_logs(
    task_id: &str,
    limit: i64,
    before: Option<LogCursor>,
) -> Result<Vec<LogRow>, DbError> {
    with_db(|conn, _| {
        let mut statement;
        let mut rows;
        match before {
            None => {
                statement = conn.prepare(
                    "SELECT * FROM logs WHERE task_id = ?1 ORDER BY executed_at DESC, id DESC LIMIT ?2",
                )?;
                rows = statement.query_map(params![task_id, limit], map_log)?;
            }
            Some(cursor) => {
                statement = conn.prepare(
                    "SELECT * FROM logs
                      WHERE task_id = ?1
                        AND (executed_at < ?2 OR (executed_at = ?3 AND id < ?4))
                      ORDER BY executed_at DESC, id DESC
                      LIMIT ?5",
                )?;
                rows = statement.query_map(
                    params![
                        task_id,
                        cursor.executed_at,
                        cursor.executed_at,
                        cursor.id,
                        limit
                    ],
                    map_log,
                )?;
            }
        }
        let items: Vec<LogRow> = rows.by_ref().filter_map(|result| result.ok()).collect();
        Ok(items)
    })
}

/// 执行记录的筛选口径：只看某一类结果。
///
/// 「成功」指主请求发出去了并且命中了成功条件（`kind = 'task'` 且 `matched = 1`）；
/// 「失败」是主请求发出去了但没命中成功条件；
/// 「跳过」是没发主请求（条件不满足、时段外、前置判断没过）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogOutcome {
    All,
    Success,
    Failed,
    Skipped,
}

impl LogOutcome {
    /// 解析接口传入的筛选值。空值等价于「全部」；认不出来返回 `None`（由接口回 400）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "all" => Some(LogOutcome::All),
            "success" | "ok" => Some(LogOutcome::Success),
            "failed" | "error" => Some(LogOutcome::Failed),
            "skipped" | "missed" => Some(LogOutcome::Skipped),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            LogOutcome::All => "all",
            LogOutcome::Success => "success",
            LogOutcome::Failed => "failed",
            LogOutcome::Skipped => "skipped",
        }
    }

    /// 追加到 WHERE 后面的条件片段。
    ///
    /// 这里全是**代码里写死的常量**，不含任何用户输入，所以直接拼进 SQL 是安全的；
    /// 用户输入（任务 id、时间戳）一律走占位符。
    fn sql_filter(&self) -> &'static str {
        match self {
            LogOutcome::All => "",
            LogOutcome::Success => " AND kind = 'task' AND matched = 1",
            LogOutcome::Failed => " AND kind = 'task' AND matched = 0",
            LogOutcome::Skipped => " AND kind IN ('skipped', 'missed')",
        }
    }
}

/// 带保留窗口上界的轻量日志列表。
///
/// `outcome` 是结果口径的筛选：过滤发生在 **SQL 层**，
/// 所以「只看成功」返回的就是成功记录本身，不会被大量跳过记录挤到后面去。
pub fn list_log_summaries(
    task_id: &str,
    limit: i64,
    before: Option<LogCursor>,
    since: Option<i64>,
    outcome: LogOutcome,
) -> Result<Vec<LogSummary>, DbError> {
    with_db(|conn, _| {
        // 通知行不单独出现在列表里：作为父任务行的附属数据由 API 聚合返回。
        let mut sql =
            format!("SELECT {LOG_SUMMARY_COLUMNS} FROM logs WHERE task_id = ?1 AND kind != 'notify'");
        let mut parameters: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(task_id.to_string())];

        if let Some(cursor) = before {
            // 参数编号按绑定顺序连续排（?1 已被任务 id 占用）。
            sql.push_str(" AND (executed_at < ?2 OR (executed_at = ?3 AND id < ?4))");
            parameters.push(Box::new(cursor.executed_at));
            parameters.push(Box::new(cursor.executed_at));
            parameters.push(Box::new(cursor.id));
        }
        if let Some(since) = since {
            let index = parameters.len() + 1;
            sql.push_str(&format!(" AND executed_at >= ?{index}"));
            parameters.push(Box::new(since));
        }
        sql.push_str(outcome.sql_filter());

        let limit_index = parameters.len() + 1;
        sql.push_str(&format!(
            " ORDER BY executed_at DESC, id DESC LIMIT ?{limit_index}"
        ));
        parameters.push(Box::new(limit));

        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(parameters), map_log_summary)?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

/// 统计窗口内符合筛选口径的记录条数（**不含**翻页游标，统计的是全部匹配）。
///
/// 用来告诉用户「共 N 条匹配」，避免他以为看到的就是全部。
pub fn count_log_summaries(
    task_id: &str,
    since: Option<i64>,
    outcome: LogOutcome,
) -> Result<i64, DbError> {
    with_db(|conn, _| {
        let mut sql =
            "SELECT COUNT(*) FROM logs WHERE task_id = ?1 AND kind != 'notify'".to_string();
        let mut parameters: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(task_id.to_string())];
        if let Some(since) = since {
            sql.push_str(" AND executed_at >= ?2");
            parameters.push(Box::new(since));
        }
        sql.push_str(outcome.sql_filter());

        let mut statement = conn.prepare(&sql)?;
        let count = statement.query_row(rusqlite::params_from_iter(parameters), |row| row.get(0))?;
        Ok(count)
    })
}

/// 列表页附属通知：按 parent_log_id 批量取 notify 行摘要。
pub fn list_notify_summaries(parent_ids: &[i64]) -> Result<Vec<LogSummary>, DbError> {
    let ids: Vec<i64> = parent_ids
        .iter()
        .filter(|id| **id > 0)
        .copied()
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    with_db(|conn, _| {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT {LOG_SUMMARY_COLUMNS} FROM logs WHERE kind = 'notify' AND parent_log_id IN ({placeholders})"
        );
        let parameters: Vec<Box<dyn rusqlite::ToSql>> = ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>)
            .collect();
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(parameters), map_log_summary)?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

/// 详情页附属通知：某次执行对应的通知完整行（1:1，取最新）。
pub fn get_notify_by_parent(parent_id: i64) -> Result<Option<LogRow>, DbError> {
    with_db(|conn, _| {
        let sql = format!(
            "SELECT {LOG_FULL_COLUMNS} FROM logs WHERE kind = 'notify' AND parent_log_id = ?1 ORDER BY executed_at DESC, id DESC LIMIT 1"
        );
        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query_map(params![parent_id], map_log)?;
        match rows.next() {
            Some(result) => Ok(Some(result?)),
            None => Ok(None),
        }
    })
}

pub fn get_journal_mode() -> Result<String, DbError> {
    with_db(|conn, _| {
        let value: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        Ok(value)
    })
}

// ---------------------------------------------------------------------------
// 节假日数据（holiday-cn）：按年缓存
// ---------------------------------------------------------------------------

/// 写入 / 覆盖某一年的节假日数据。
pub fn upsert_holiday_year(
    year: i32,
    days_json: &str,
    fetched_at: i64,
    day_count: i64,
) -> Result<(), DbError> {
    with_db(|conn, _| {
        conn.execute(
            "INSERT INTO holiday_years (year, days, fetched_at, day_count)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(year) DO UPDATE SET days = ?2, fetched_at = ?3, day_count = ?4",
            params![year, days_json, fetched_at, day_count],
        )?;
        Ok(())
    })
}

/// 全部已缓存的年份（设置页展示与启动回填缓存）。
pub fn list_holiday_years() -> Result<Vec<(i32, String, i64)>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn
            .prepare("SELECT year, days, fetched_at FROM holiday_years ORDER BY year")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)? as i32, row.get(1)?, row.get(2)?))
        })?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

/// 某一年已缓存的节假日 JSON（判断时按年懒加载进内存缓存）。
pub fn get_holiday_year_days(year: i32) -> Result<Option<String>, DbError> {
    with_db(|conn, _| {
        let mut statement =
            conn.prepare("SELECT days FROM holiday_years WHERE year = ?1")?;
        let mut rows = statement.query_map(params![year], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(result) => Ok(Some(result?)),
            None => Ok(None),
        }
    })
}

/// 0 = NONE, 1 = FULL, 2 = INCREMENTAL。
pub fn get_auto_vacuum_mode() -> Result<i64, DbError> {
    with_db(|conn, _| {
        let value: i64 = conn.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
        Ok(value)
    })
}

/// 最多回收 `pages` 个空闲页（每页 4 KiB）。
pub fn incremental_vacuum(pages: i64) -> Result<i64, DbError> {
    if get_auto_vacuum_mode()? != 2 {
        return Ok(0);
    }
    with_db(|conn, _| {
        conn.execute_batch(&format!("PRAGMA incremental_vacuum({});", pages.max(1)))?;
        Ok(pages)
    })
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct LogStorageUsage {
    pub db_bytes: i64,
    pub wal_bytes: i64,
    pub shm_bytes: i64,
    pub total_bytes: i64,
}

pub fn db_path() -> Option<PathBuf> {
    let guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.as_ref().map(|db| db.path.clone())
}

fn file_size(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0)
}

/// 数据库与 WAL/SHM 侧车文件的实际大小。
pub fn get_log_storage_usage() -> LogStorageUsage {
    let Some(path) = db_path() else {
        return LogStorageUsage::default();
    };
    if path == Path::new(":memory:") {
        return LogStorageUsage::default();
    }
    let db_bytes = file_size(&path);
    let wal_bytes = file_size(&PathBuf::from(format!("{}-wal", path.display())));
    let shm_bytes = file_size(&PathBuf::from(format!("{}-shm", path.display())));
    LogStorageUsage {
        db_bytes,
        wal_bytes,
        shm_bytes,
        total_bytes: db_bytes + wal_bytes + shm_bytes,
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct LogCountRow {
    count: i64,
    bytes: i64,
    oldest: Option<i64>,
    newest: Option<i64>,
}

const LOG_BYTES_EXPR: &str = "(
  length(coalesce(request_url, '')) +
  length(coalesce(request_method, '')) +
  length(coalesce(request_headers, '')) +
  length(coalesce(request_body, '')) +
  length(coalesce(response_headers, '')) +
  length(coalesce(response_body, '')) +
  length(coalesce(error, '')) + 64
)";

/// 统计日志条数 / 体积 / 时间范围。
///
/// `task_id` 限定某个任务，`cutoff` 限定「早于某个时刻」；
/// 两者都是**参数化**的（任务 id 来自接口，不能拼进 SQL）。
fn count_logs(
    conn: &Connection,
    task_id: Option<&str>,
    cutoff: Option<i64>,
) -> Result<LogCountRow, DbError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(id) = task_id {
        clauses.push(format!("task_id = ?{}", values.len() + 1));
        values.push(Box::new(id.to_string()));
    }
    if let Some(value) = cutoff {
        clauses.push(format!("executed_at < ?{}", values.len() + 1));
        values.push(Box::new(value));
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT count(*) AS count,
                coalesce(sum({LOG_BYTES_EXPR}), 0) AS bytes,
                min(executed_at) AS oldest,
                max(executed_at) AS newest
         FROM logs {where_clause}"
    );
    let row = conn.query_row(
        &sql,
        rusqlite::params_from_iter(values.iter().map(|value| value.as_ref())),
        |row| {
            Ok(LogCountRow {
                count: row.get(0)?,
                bytes: row.get(1)?,
                oldest: row.get(2)?,
                newest: row.get(3)?,
            })
        },
    )?;
    Ok(row)
}

#[derive(Debug, Clone, Serialize)]
pub struct LogCleanupOption {
    pub days: i64,
    pub label: String,
    pub cutoff: i64,
    pub count: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogCleanupPreview {
    pub generated_at: i64,
    pub total_count: i64,
    pub total_bytes: i64,
    pub oldest_executed_at: Option<i64>,
    pub newest_executed_at: Option<i64>,
    pub storage: LogStorageUsage,
    pub options: Vec<LogCleanupOption>,
    pub all: LogCountRow,
}

/// 只读预览：cutoff 基于 logs.executed_at（epoch ms）。
///
/// `task_id` 限定只统计某一个任务的日志；None = 全部任务。
pub fn get_log_cleanup_preview(
    now: i64,
    task_id: Option<&str>,
) -> Result<LogCleanupPreview, DbError> {
    // 先在锁外取文件大小：db_path() 也要拿同一把锁，持锁调用会自死锁。
    let storage = get_log_storage_usage();
    with_db(|conn, _| {
        let totals = count_logs(conn, task_id, None)?;
        let mut options = Vec::new();
        for days in LOG_CLEANUP_DAYS {
            let cutoff = now - days * DAY_MS;
            let row = count_logs(conn, task_id, Some(cutoff))?;
            options.push(LogCleanupOption {
                days,
                label: cleanup_label(days),
                cutoff,
                count: row.count,
                bytes: row.bytes,
            });
        }
        Ok(LogCleanupPreview {
            generated_at: now,
            total_count: totals.count,
            total_bytes: totals.bytes,
            oldest_executed_at: totals.oldest,
            newest_executed_at: totals.newest,
            storage,
            options,
            all: LogCountRow {
                count: totals.count,
                bytes: totals.bytes,
                oldest: totals.oldest,
                newest: totals.newest,
            },
        })
    })
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct LogPruneOutcome {
    pub deleted: i64,
    pub by_age: i64,
    pub by_count: i64,
}

/// 保留清理：删超过保留期的日志，和每任务只留最新的 `max_rows_per_task` 条。
///
/// 保留期**按任务算**：任务单独设置过天数就用它自己的，否则用全局的 `retention_days`；
/// 0 表示永久保留。必须逐任务处理——全局规则不能把「保留更久」的任务的旧日志删掉。
pub fn prune_logs(
    now: i64,
    retention_days: i64,
    max_rows_per_task: i64,
) -> Result<LogPruneOutcome, DbError> {
    with_db(|conn, _| {
        let mut by_age = 0i64;
        let mut by_count = 0i64;
        let task_days: Vec<(String, Option<i64>)> = {
            let mut statement = conn.prepare("SELECT id, log_retention_days FROM tasks")?;
            let mapped = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })?
                .filter_map(|result| result.ok())
                .collect();
            mapped
        };
        for (id, days_override) in task_days {
            let days = days_override.unwrap_or(retention_days);
            if days <= 0 {
                // 0 = 永久保留这个任务的日志。
                continue;
            }
            let cutoff = now - days * DAY_MS;
            by_age += conn.execute(
                "DELETE FROM logs
                  WHERE id IN (SELECT id FROM logs
                                WHERE task_id = ?1 AND executed_at < ?2
                                ORDER BY executed_at
                                LIMIT ?3)",
                params![id, cutoff, PRUNE_BATCH_ROWS],
            )? as i64;
        }
        if max_rows_per_task > 0 {
            let ids: Vec<String> = {
                let mut statement = conn.prepare("SELECT id FROM tasks")?;
                let mapped: Vec<String> = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .filter_map(|result| result.ok())
                    .collect();
                mapped
            };
            for id in ids {
                let keep = max_rows_per_task;
                by_count += conn.execute(
                    "DELETE FROM logs
                      WHERE id IN (
                        SELECT id FROM logs
                         WHERE task_id = ?1
                           AND id NOT IN (SELECT id FROM logs
                                           WHERE task_id = ?2
                                           ORDER BY executed_at DESC, id DESC
                                           LIMIT ?3)
                         ORDER BY executed_at
                         LIMIT ?4)",
                    params![id, id, keep, PRUNE_BATCH_ROWS],
                )? as i64;
            }
        }
        Ok(LogPruneOutcome {
            deleted: by_age + by_count,
            by_age,
            by_count,
        })
    })
}

/// 一个任务最近的正式执行记录（轻量字段）。
pub fn list_recent_task_logs(task_id: &str, limit: i64) -> Result<Vec<LogSummary>, DbError> {
    with_db(|conn, _| {
        let sql = format!(
            "SELECT {LOG_SUMMARY_COLUMNS} FROM logs
              WHERE task_id = ?1 AND kind = 'task'
              ORDER BY executed_at DESC, id DESC LIMIT ?2"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(params![task_id, limit.max(1)], map_log_summary)?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct RunTotals {
    pub runs: i64,
    pub ok: i64,
    pub avg_duration_ms: Option<f64>,
}

/// 一个任务最近一次正式执行记录（轻量字段）；没有执行过则为 `None`。
pub fn get_last_task_log(task_id: &str) -> Result<Option<LogSummary>, DbError> {
    Ok(list_recent_task_logs(task_id, 1)?.into_iter().next())
}

/// 自某个时刻以来的任务执行统计。
pub fn count_runs_since(cutoff: i64) -> Result<RunTotals, DbError> {
    with_db(|conn, _| {
        let row = conn.query_row(
            "SELECT COUNT(*) AS runs,
                    SUM(CASE WHEN error IS NULL AND response_status IS NOT NULL
                              AND response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
                    AVG(duration_ms) AS avg_ms
               FROM logs
              WHERE kind = 'task' AND executed_at >= ?1",
            params![cutoff],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                ))
            },
        )?;
        Ok(RunTotals {
            runs: row.0,
            ok: row.1.unwrap_or(0),
            avg_duration_ms: row.2,
        })
    })
}

pub fn get_setting(key: &str) -> Result<Option<String>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = statement.query_map(params![key], |row| row.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    })
}

pub fn set_setting(key: &str, value: Option<&str>) -> Result<(), DbError> {
    with_db(|conn, _| {
        match value {
            None => {
                conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            }
            Some(value) => {
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
            }
        }
        Ok(())
    })
}

/// 实际生效的保留窗口：界面设置优先于配置文件默认值。
/// 是否默认跳过 TLS 证书校验（未设置时视为开启）。
pub fn get_skip_tls_verify() -> bool {
    match get_setting(SKIP_TLS_VERIFY_SETTING) {
        Ok(Some(value)) => value.trim() != "0",
        _ => true,
    }
}

pub fn get_prevent_sleep_on_ac() -> bool {
    match get_setting(PREVENT_SLEEP_ON_AC_SETTING) {
        Ok(Some(value)) => value.trim() == "1",
        _ => false,
    }
}

pub fn get_effective_retention_days(default_days: i64) -> Result<i64, DbError> {
    if let Some(raw) = get_setting(LOG_RETENTION_SETTING)? {
        if let Ok(parsed) = raw.parse::<i64>() {
            if (0..=3650).contains(&parsed) {
                return Ok(parsed);
            }
        }
    }
    Ok(default_days)
}

pub fn get_log_age_range() -> Result<(Option<i64>, Option<i64>), DbError> {
    with_db(|conn, _| {
        let row = conn.query_row(
            "SELECT MIN(executed_at), MAX(executed_at) FROM logs",
            [],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )?;
        Ok(row)
    })
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct LogCleanupOutcome {
    pub deleted: i64,
    pub remaining: i64,
    pub cutoff: Option<i64>,
    pub storage_before: LogStorageUsage,
    pub storage_after: LogStorageUsage,
    pub reclaimed_bytes: i64,
    pub vacuum_error: Option<String>,
}

/// 删除旧日志（或全部），然后 VACUUM 并截断 WAL，让文件真正变小。
///
/// `task_id` 限定只清某个任务的日志；None = 全部任务。
pub fn cleanup_logs(cutoff: Option<i64>, task_id: Option<&str>) -> Result<LogCleanupOutcome, DbError> {
    let before = get_log_storage_usage();
    let (deleted, vacuum_error) = with_db(|conn, _| {
        let deleted = match (cutoff, task_id) {
            (None, None) => conn.execute("DELETE FROM logs", [])?,
            (None, Some(id)) => {
                conn.execute("DELETE FROM logs WHERE task_id = ?1", params![id])?
            }
            (Some(value), None) => {
                conn.execute("DELETE FROM logs WHERE executed_at < ?1", params![value])?
            }
            (Some(value), Some(id)) => conn.execute(
                "DELETE FROM logs WHERE task_id = ?1 AND executed_at < ?2",
                params![id, value],
            )?,
        } as i64;
        let mut vacuum_error = None;
        let result = (|| -> rusqlite::Result<()> {
            conn.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE);
                 PRAGMA auto_vacuum = INCREMENTAL;
                 VACUUM;
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            vacuum_error = Some(error.to_string());
        }
        Ok((deleted, vacuum_error))
    })?;
    let after = get_log_storage_usage();
    Ok(LogCleanupOutcome {
        deleted,
        // 只清某个任务时，“剩余”按这个任务的条数算，其它任务不受影响。
        remaining: match task_id {
            Some(id) => with_db(|conn, _| Ok(count_logs(conn, Some(id), None)?.count))?,
            None => count_remaining()?,
        },
        cutoff,
        storage_before: before,
        storage_after: after,
        reclaimed_bytes: (before.total_bytes - after.total_bytes).max(0),
        vacuum_error,
    })
}

fn count_remaining() -> Result<i64, DbError> {
    with_db(|conn, _| {
        let value: i64 = conn.query_row("SELECT count(*) FROM logs", [], |row| row.get(0))?;
        Ok(value)
    })
}

/// 持久化一条测试台留档并清理超过 TEST_RUN_KEEP 的旧记录。
pub fn insert_test_run(
    task_id: &str,
    ok: bool,
    summary: &str,
    steps: &str,
    created_at: i64,
) -> Result<i64, DbError> {
    with_db(|conn, _| {
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO test_runs (task_id, created_at, ok, summary, steps) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, created_at, if ok { 1 } else { 0 }, summary, steps],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM test_runs
              WHERE task_id = ?1
                AND id NOT IN (
                  SELECT id FROM test_runs WHERE task_id = ?2 ORDER BY id DESC LIMIT ?3
                )",
            params![task_id, task_id, TEST_RUN_KEEP],
        )?;
        tx.commit()?;
        Ok(id)
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct TestRunSummaryRow {
    pub id: i64,
    pub task_id: String,
    pub created_at: i64,
    pub ok: i64,
    pub summary: String,
}

pub fn list_test_runs(task_id: &str, limit: i64) -> Result<Vec<TestRunSummaryRow>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn.prepare(
            "SELECT id, task_id, created_at, ok, summary
               FROM test_runs WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![task_id, limit], |row| {
            Ok(TestRunSummaryRow {
                id: row.get(0)?,
                task_id: row.get(1)?,
                created_at: row.get(2)?,
                ok: row.get(3)?,
                summary: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

pub fn get_test_run(id: i64) -> Result<Option<TestRunRow>, DbError> {
    with_db(|conn, _| {
        let mut statement = conn.prepare(
            "SELECT id, task_id, created_at, ok, summary, steps FROM test_runs WHERE id = ?1",
        )?;
        let mut rows = statement.query_map(params![id], |row| {
            Ok(TestRunRow {
                id: row.get(0)?,
                task_id: row.get(1)?,
                created_at: row.get(2)?,
                ok: row.get(3)?,
                summary: row.get(4)?,
                steps: row.get(5)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    })
}

// ---------------------------------------------------------------------------
// 数据库浏览（只读）：界面「数据库」面板用
// ---------------------------------------------------------------------------

/// 表结构里的一列。
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseColumn {
    pub name: String,
    /// 声明类型（`TEXT` / `INTEGER` / …）。
    pub decl_type: String,
}

/// 一张表及其规模。
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseTable {
    pub name: String,
    pub columns: Vec<DatabaseColumn>,
    pub row_count: i64,
}

/// 某张表的一页数据。
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseRows {
    pub table: String,
    pub columns: Vec<DatabaseColumn>,
    /// 每行是一个 `{列名: 值}` 的对象。
    pub rows: Vec<JsonMap<String, Json>>,
    /// 该表的总行数。
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

/// 把表名转义成 SQL 标识符。
///
/// SQLite 的标识符用双引号包裹，内部的 `"` 要写成 `""`。
/// 表名来自 `sqlite_master`，正常情况下不含引号，但转义后拼接才是安全的。
pub fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 用户可见的表（排除 SQLite 内部表）。
fn visible_table_names(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut statement = conn.prepare(
        "SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.filter_map(|result| result.ok()).collect())
}

/// 表的列结构（用 `pragma_table_info` 取值函数，参数化避免拼接表名）。
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<DatabaseColumn>, DbError> {
    let mut statement = conn.prepare("SELECT name, type FROM pragma_table_info(?1)")?;
    let rows = statement.query_map(params![table], |row| {
        Ok(DatabaseColumn {
            name: row.get(0)?,
            decl_type: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        })
    })?;
    Ok(rows.filter_map(|result| result.ok()).collect())
}

/// SQLite 值 → JSON。
fn json_value(value: rusqlite::types::ValueRef<'_>) -> Json {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(number) => Json::from(number),
        ValueRef::Real(number) => Json::from(number),
        ValueRef::Text(text) => Json::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => {
            use base64::Engine as _;
            Json::String(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
    }
}

/// 全部可见表 + 列结构 + 行数。
pub fn list_database_tables() -> Result<Vec<DatabaseTable>, DbError> {
    with_db(|conn, _| {
        let mut tables = Vec::new();
        for name in visible_table_names(conn)? {
            let columns = table_columns(conn, &name)?;
            let row_count: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {}", quote_identifier(&name)),
                [],
                |row| row.get(0),
            )?;
            tables.push(DatabaseTable {
                name,
                columns,
                row_count,
            });
        }
        Ok(tables)
    })
}

/// 某张表的一页数据（只读）。
///
/// 表名必须在 [`visible_table_names`] 里出现，否则拒绝执行——避免把表名拼进 SQL。
pub fn list_database_rows(
    table: &str,
    limit: i64,
    offset: i64,
) -> Result<DatabaseRows, DbError> {
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    with_db(|conn, _| {
        if !visible_table_names(conn)?.iter().any(|name| name == table) {
            return Err(DbError(format!("表不存在：{table}")));
        }
        let columns = table_columns(conn, table)?;
        // 表名按 SQL 标识符规则转义（内部双引号要写两遍），否则带引号的表名会破坏语句。
        let quoted = quote_identifier(table);
        let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| row.get(0))?;
        let mut statement = conn.prepare(&format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2"))?;
        let mut rows = Vec::new();
        let mut query = statement.query(params![limit, offset])?;
        while let Some(row) = query.next()? {
            let mut item = JsonMap::new();
            for index in 0..columns.len() {
                let value = row.get_ref(index)?;
                item.insert(columns[index].name.clone(), json_value(value));
            }
            rows.push(item);
        }
        Ok(DatabaseRows {
            table: table.to_string(),
            columns,
            rows,
            total,
            limit,
            offset,
        })
    })
}
