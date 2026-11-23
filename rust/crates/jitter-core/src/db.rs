//! SQLite 数据层：schema、增量迁移、任务/日志/测试留档/设置的读写、保留清理。
//!
//! 与 TypeScript 版（`src/db.ts`）使用**同一个** schema 与迁移规则，
//! 所以现有数据库文件可以直接被 Rust 版接管，无需任何转换。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use chrono::{DateTime, Local};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as Json};

use crate::types::{LogKind, RedirectMode, TaskStatus};

pub const LOG_RETENTION_SETTING: &str = "logRetentionDays";

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
  matched          INTEGER
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
}

const LOG_FULL_COLUMNS: &str = "id, task_id, executed_at, request_url, request_method, request_headers, request_body, response_status, response_headers, response_body, duration_ms, error, aborted, kind, parent_log_id, matched";

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
}

const LOG_SUMMARY_COLUMNS: &str = "id, task_id, executed_at, request_url, request_method, response_status, duration_ms, error, aborted, kind, parent_log_id, matched";

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
}

/// 创建/更新任务共用的列值计算（guard 开关的判定逻辑与 TS 版一致）。
struct TaskColumns {
    notify_enabled: i64,
    notify: Option<RequestParts>,
    precheck: Option<RequestParts>,
    guard_enabled: bool,
    weekdays: Option<String>,
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
        || input.precheck_time_end.is_some();
    let guard_enabled = input.precheck_enabled && (precheck.is_some() || local_guard);
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
    TaskColumns {
        notify_enabled,
        notify,
        precheck,
        guard_enabled,
        weekdays,
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

fn with_db<T>(callback: impl FnOnce(&mut Connection, &Path) -> Result<T, DbError>) -> Result<T, DbError> {
    let mut guard = db_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = guard.as_mut().ok_or_else(|| DbError("数据库尚未初始化，请先调用 initDb()".into()))?;
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
    let db = guard.as_mut().ok_or_else(|| DbError("数据库尚未初始化，请先调用 initDb()".into()))?;
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

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), DbError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|result| result.ok())
        .collect();
    if !columns.iter().any(|name| name == column) {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    }
    Ok(())
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
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
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
        let has_window = is_hhmm(&window_start)
            && is_hhmm(&window_end)
            && window_start != window_end;
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
        tracing::warn!(
            "[jitter] 已把旧调度「{name}」改为「每天窗口」；请到页面确认执行时间"
        );
    }
    Ok(())
}

/// 给每个任务一个显式位置，保持「最新在前」的可见顺序。
fn backfill_sort_order(conn: &mut Connection) -> Result<(), DbError> {
    let ids: Vec<String> = {
        let mut statement = conn.prepare("SELECT id FROM tasks ORDER BY created_at DESC, rowid DESC")?;
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
        tx.execute("UPDATE tasks SET sort_order = ?1 WHERE id = ?2", params![index as i64, id])?;
    }
    tx.commit()?;
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<(), DbError> {
    ensure_column(conn, "tasks", "request_options", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(conn, "tasks", "notify_options", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(conn, "tasks", "paused_until", "INTEGER")?;
    ensure_column(conn, "tasks", "paused_from", "INTEGER")?;
    ensure_column(conn, "tasks", "expect_expr", "TEXT")?;
    ensure_column(conn, "tasks", "schedule_kind", "TEXT NOT NULL DEFAULT 'daily'")?;
    ensure_column(conn, "tasks", "daily_jitter_minutes", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "tasks", "interval_seconds", "INTEGER")?;
    ensure_column(conn, "tasks", "interval_jitter_seconds", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "tasks", "interval_start_at", "INTEGER")?;
    ensure_column(conn, "tasks", "precheck_enabled", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "tasks", "precheck_curl_command", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_url", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_method", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_headers", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_body", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_options", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(conn, "tasks", "precheck_expect_status", "INTEGER")?;
    ensure_column(conn, "tasks", "precheck_expr", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_weekdays", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_time_start", "TEXT")?;
    ensure_column(conn, "tasks", "precheck_time_end", "TEXT")?;
    ensure_column(conn, "tasks", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
    backfill_sort_order(conn)?;
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
            std::fs::create_dir_all(parent)
                .map_err(|error| DbError(format!("无法创建数据目录 {}: {error}", parent.display())))?;
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
            tx.execute("UPDATE tasks SET sort_order = ?1 WHERE id = ?2", params![index as i64, id])?;
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
              expect_status, expect_body, expect_expr
            ) VALUES (
              ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
              ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44
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
                input.expect_status,
                input.expect_body,
                input.expect_expr,
            ],
        )?;
        Ok(())
    })?;
    get_task(id)?.ok_or_else(|| DbError("任务写入后无法读取".into()))
}

/// 覆盖任务的可编辑配置，保留 id/status/next_run_at/paused_*/created_at。
pub fn update_task_config(id: &str, input: &NewTaskInput, now: i64) -> Result<Option<TaskRow>, DbError> {
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
              expect_status = ?34, expect_body = ?35, expect_expr = ?36, updated_at = ?37
             WHERE id = ?38",
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
                input.expect_status,
                input.expect_body,
                input.expect_expr,
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
        let mut statement = conn.prepare("SELECT * FROM tasks ORDER BY sort_order ASC, created_at DESC")?;
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

pub fn update_task_status(id: &str, status: TaskStatus, next_run_at: Option<i64>, now: i64) -> Result<(), DbError> {
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
}

pub fn insert_log(input: &NewLogInput) -> Result<i64, DbError> {
    with_db(|conn, _| {
        conn.execute(
            "INSERT INTO logs (
              task_id, executed_at, request_url, request_method, request_headers, request_body,
              response_status, response_headers, response_body, duration_ms, error, aborted,
              kind, parent_log_id, matched
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
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
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

pub fn get_log(id: i64) -> Result<Option<LogRow>, DbError> {
    with_db(|conn, _| {
        let mut statement =
            conn.prepare(&format!("SELECT {LOG_FULL_COLUMNS} FROM logs WHERE id = ?1"))?;
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

pub fn list_logs(task_id: &str, limit: i64, before: Option<LogCursor>) -> Result<Vec<LogRow>, DbError> {
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
                    params![task_id, cursor.executed_at, cursor.executed_at, cursor.id, limit],
                    map_log,
                )?;
            }
        }
        let items: Vec<LogRow> = rows.by_ref().filter_map(|result| result.ok()).collect();
        Ok(items)
    })
}

/// 带保留窗口上界的轻量日志列表。
pub fn list_log_summaries(
    task_id: &str,
    limit: i64,
    before: Option<LogCursor>,
    since: Option<i64>,
) -> Result<Vec<LogSummary>, DbError> {
    with_db(|conn, _| {
        let select = format!("SELECT {LOG_SUMMARY_COLUMNS} FROM logs");
        let order = " ORDER BY executed_at DESC, id DESC LIMIT";
        let (sql, parameters): (String, Vec<Box<dyn rusqlite::ToSql>>) = match (before, since) {
            (None, None) => (format!("{select} WHERE task_id = ?1{order} ?2"), vec![Box::new(task_id.to_string()), Box::new(limit)]),
            (None, Some(since)) => (
                format!("{select} WHERE task_id = ?1 AND executed_at >= ?2{order} ?3"),
                vec![Box::new(task_id.to_string()), Box::new(since), Box::new(limit)],
            ),
            (Some(cursor), None) => (
                format!(
                    "{select} WHERE task_id = ?1 AND (executed_at < ?2 OR (executed_at = ?3 AND id < ?4)){order} ?5"
                ),
                vec![
                    Box::new(task_id.to_string()),
                    Box::new(cursor.executed_at),
                    Box::new(cursor.executed_at),
                    Box::new(cursor.id),
                    Box::new(limit),
                ],
            ),
            (Some(cursor), Some(since)) => (
                format!(
                    "{select} WHERE task_id = ?1 AND (executed_at < ?2 OR (executed_at = ?3 AND id < ?4)) AND executed_at >= ?5{order} ?6"
                ),
                vec![
                    Box::new(task_id.to_string()),
                    Box::new(cursor.executed_at),
                    Box::new(cursor.executed_at),
                    Box::new(cursor.id),
                    Box::new(since),
                    Box::new(limit),
                ],
            ),
        };
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(parameters), map_log_summary)?;
        Ok(rows.filter_map(|result| result.ok()).collect())
    })
}

pub fn get_journal_mode() -> Result<String, DbError> {
    with_db(|conn, _| {
        let value: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        Ok(value)
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
        conn.execute_batch(&format!(
            "PRAGMA incremental_vacuum({});",
            pages.max(1)
        ))?;
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
    std::fs::metadata(path).map(|meta| meta.len() as i64).unwrap_or(0)
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
struct LogCountRow {
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

fn count_logs(conn: &Connection, where_clause: &str, cutoff: Option<i64>) -> Result<LogCountRow, DbError> {
    let sql = format!(
        "SELECT count(*) AS count,
                coalesce(sum({LOG_BYTES_EXPR}), 0) AS bytes,
                min(executed_at) AS oldest,
                max(executed_at) AS newest
         FROM logs {where_clause}"
    );
    let row = match cutoff {
        Some(value) => conn.query_row(&sql, params![value], |row| {
            Ok(LogCountRow {
                count: row.get(0)?,
                bytes: row.get(1)?,
                oldest: row.get(2)?,
                newest: row.get(3)?,
            })
        })?,
        None => conn.query_row(&sql, [], |row| {
            Ok(LogCountRow {
                count: row.get(0)?,
                bytes: row.get(1)?,
                oldest: row.get(2)?,
                newest: row.get(3)?,
            })
        })?,
    };
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
pub fn get_log_cleanup_preview(now: i64) -> Result<LogCleanupPreview, DbError> {
    with_db(|conn, _| {
        let totals = count_logs(conn, "", None)?;
        let mut options = Vec::new();
        for days in LOG_CLEANUP_DAYS {
            let cutoff = now - days * DAY_MS;
            let row = count_logs(conn, "WHERE executed_at < ?", Some(cutoff))?;
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
            storage: get_log_storage_usage(),
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

/// 保留清理：删超过 `retention_days` 的日志，和每任务只留最新的 `max_rows_per_task` 条。
pub fn prune_logs(now: i64, retention_days: i64, max_rows_per_task: i64) -> Result<LogPruneOutcome, DbError> {
    with_db(|conn, _| {
        let mut by_age = 0i64;
        let mut by_count = 0i64;
        if retention_days > 0 {
            let cutoff = now - retention_days * DAY_MS;
            by_age = conn.execute(
                "DELETE FROM logs
                  WHERE id IN (SELECT id FROM logs
                                WHERE executed_at < ?1
                                ORDER BY executed_at
                                LIMIT ?2)",
                params![cutoff, PRUNE_BATCH_ROWS],
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
pub fn cleanup_logs(cutoff: Option<i64>) -> Result<LogCleanupOutcome, DbError> {
    let before = get_log_storage_usage();
    let (deleted, vacuum_error) = with_db(|conn, _| {
        let deleted = match cutoff {
            None => conn.execute("DELETE FROM logs", [])?,
            Some(value) => conn.execute("DELETE FROM logs WHERE executed_at < ?1", params![value])?,
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
        remaining: count_remaining()?,
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
pub fn insert_test_run(task_id: &str, ok: bool, summary: &str, steps: &str, created_at: i64) -> Result<i64, DbError> {
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
        let mut statement = conn.prepare("SELECT id, task_id, created_at, ok, summary, steps FROM test_runs WHERE id = ?1")?;
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
