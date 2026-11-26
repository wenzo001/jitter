//! 只读探针：以**只读**方式打开任意 Jitter 数据库并读取内容。
//!
//! # 用途
//!
//! 排查线上问题时需要看生产实例的数据，但绝不能改它。这个模块提供
//! 「只读打开 + 读取」的能力：
//!
//! - 用 `SQLITE_OPEN_READ_ONLY` 打开，绝不写库；
//! - 生产实例正在运行时也能读（WAL 模式下另有一份 `-wal` 文件，
//!   只读连接照样能看到已提交的数据）；
//! - 只读连接**不会修改** db / wal / shm 三个文件（连 mtime 都不变）。
//!
//! # 边界
//!
//! - 只支持 `SELECT` / `PRAGMA` 读，不提供任何写接口。
//! - 不跑迁移、不建表、不 checkpoint——那些都是写操作。
//! - 不读 `sqlite_master` 以外的系统表来推断结构。

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

/// 探针错误。
#[derive(Debug)]
pub struct ProbeError(pub String);

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProbeError {}

impl From<rusqlite::Error> for ProbeError {
    fn from(error: rusqlite::Error) -> Self {
        ProbeError(error.to_string())
    }
}

/// 以只读方式打开数据库。
///
/// `SQLITE_OPEN_READ_ONLY` 让 SQLite 在连接层面就拒绝写操作——
/// 这是比「代码里不写 INSERT」强得多的保证：即使探针代码有 bug，
/// 也写不进去。
///
/// 只读连接不创建 `-shm` 文件，也不动 `-wal`：生产实例正在跑的时候，
/// 三个文件的大小和 mtime 都不会变化。
pub fn open_readonly(path: &Path) -> Result<Connection, ProbeError> {
    if !path.exists() {
        return Err(ProbeError(format!("数据库不存在：{}", path.display())));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|error| ProbeError(format!("只读打开失败（{}）：{error}", path.display())))?;
    // busy_timeout 只影响等待，不影响只读性；生产实例正忙时给点耐心。
    conn.busy_timeout(std::time::Duration::from_millis(2000))?;
    Ok(conn)
}

/// 一条任务的只读摘要。
#[derive(Debug, Clone)]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub request_method: String,
    pub request_url: String,
    pub schedule: String,
    pub log_retention_days: Option<i64>,
    pub log_count: i64,
    pub last_executed_at: Option<i64>,
    pub last_error: Option<String>,
}

/// 一条执行记录的只读摘要。
#[derive(Debug, Clone)]
pub struct LogSummary {
    pub id: i64,
    pub task_id: String,
    pub task_name: String,
    pub executed_at: i64,
    pub request_method: Option<String>,
    pub request_url: Option<String>,
    pub response_status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub kind: String,
    pub error: Option<String>,
}

/// 全库概况。
#[derive(Debug, Clone)]
pub struct ProbeReport {
    pub db_path: String,
    pub task_count: i64,
    pub log_count: i64,
    pub settings: Vec<(String, String)>,
    pub tasks: Vec<TaskSummary>,
    pub recent_logs: Vec<LogSummary>,
    /// 出错的执行记录条数（`error` 非空）。
    pub error_count: i64,
}

/// 读取完整概况。
///
/// `recent_logs` 限制条数，避免把上百万行日志全读进内存。
pub fn collect_report(
    conn: &Connection,
    db_path: &Path,
    recent_limit: i64,
) -> Result<ProbeReport, ProbeError> {
    let task_count: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
    let log_count: i64 = conn.query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))?;
    let error_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM logs WHERE error IS NOT NULL AND error <> ''",
        [],
        |row| row.get(0),
    )?;

    let settings = read_settings(conn)?;
    let tasks = read_tasks(conn)?;
    let recent_logs = read_recent_logs(conn, recent_limit)?;

    Ok(ProbeReport {
        db_path: db_path.to_string_lossy().to_string(),
        task_count,
        log_count,
        settings,
        tasks,
        recent_logs,
        error_count,
    })
}

/// 读全局设置（键值对）。
pub fn read_settings(conn: &Connection) -> Result<Vec<(String, String)>, ProbeError> {
    let mut statement = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    Ok(rows.filter_map(|result| result.ok()).collect())
}

/// 读任务摘要（含各自的日志条数与最近一次执行）。
pub fn read_tasks(conn: &Connection) -> Result<Vec<TaskSummary>, ProbeError> {
    let mut statement = conn.prepare(
        "SELECT t.id, t.name, t.status, t.request_method, t.request_url,
                t.schedule_kind, t.window_start, t.window_end, t.interval_seconds,
                t.log_retention_days,
                (SELECT COUNT(*) FROM logs l WHERE l.task_id = t.id) AS log_count,
                (SELECT MAX(l.executed_at) FROM logs l WHERE l.task_id = t.id) AS last_at,
                (SELECT l.error FROM logs l
                  WHERE l.task_id = t.id AND l.error IS NOT NULL AND l.error <> ''
                  ORDER BY l.executed_at DESC LIMIT 1) AS last_error
           FROM tasks t
          ORDER BY t.sort_order, t.created_at",
    )?;
    let rows = statement.query_map([], |row| {
        let schedule_kind: String = row.get(5)?;
        let window_start: String = row.get(6)?;
        let window_end: String = row.get(7)?;
        let interval_seconds: Option<i64> = row.get(8)?;
        let schedule = if schedule_kind == "interval" {
            match interval_seconds {
                Some(seconds) => format!("每 {seconds} 秒"),
                None => "每隔一段时间".to_string(),
            }
        } else {
            format!("每天 {window_start}–{window_end}")
        };
        Ok(TaskSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            status: row.get(2)?,
            request_method: row.get(3)?,
            request_url: row.get(4)?,
            schedule,
            log_retention_days: row.get(9)?,
            log_count: row.get(10)?,
            last_executed_at: row.get(11)?,
            last_error: row.get(12)?,
        })
    })?;
    Ok(rows.filter_map(|result| result.ok()).collect())
}

/// 读最近的执行记录（新的在前）。
pub fn read_recent_logs(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<LogSummary>, ProbeError> {
    let limit = limit.clamp(1, 500);
    let mut statement = conn.prepare(
        "SELECT l.id, l.task_id, COALESCE(t.name, ''), l.executed_at,
                l.request_method, l.request_url, l.response_status, l.duration_ms,
                l.kind, l.error
           FROM logs l
           LEFT JOIN tasks t ON t.id = l.task_id
          ORDER BY l.executed_at DESC, l.id DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map([limit], |row| {
        Ok(LogSummary {
            id: row.get(0)?,
            task_id: row.get(1)?,
            task_name: row.get(2)?,
            executed_at: row.get(3)?,
            request_method: row.get(4)?,
            request_url: row.get(5)?,
            response_status: row.get(6)?,
            duration_ms: row.get(7)?,
            kind: row.get(8)?,
            error: row.get(9)?,
        })
    })?;
    Ok(rows.filter_map(|result| result.ok()).collect())
}

/// 某张表的行数（表名必须命中白名单，避免拼进 SQL）。
///
/// 白名单里的表名来自代码常量，不接受外部输入。
pub fn count_rows(conn: &Connection, table: &str) -> Result<i64, ProbeError> {
    const ALLOWED: [&str; 5] = ["tasks", "logs", "settings", "test_runs", "holiday_years"];
    if !ALLOWED.contains(&table) {
        return Err(ProbeError(format!("不支持查询的表：{table}")));
    }
    let sql = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
    Ok(conn.query_row(&sql, [], |row| row.get(0))?)
}

/// 把时间戳格式化成本地可读时间。
pub fn format_time(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms).single() {
        Some(time) => time.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => ms.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个最小数据库（写模式，只在测试里用）。
    fn make_db(dir: &Path) -> Connection {
        let path = dir.join("probe.db");
        let conn = Connection::open(&path).expect("create");
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, status TEXT,
                    request_method TEXT, request_url TEXT, schedule_kind TEXT,
                    window_start TEXT, window_end TEXT, interval_seconds INTEGER,
                    log_retention_days INTEGER, created_at INTEGER, sort_order INTEGER);
             CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
                    executed_at INTEGER, request_method TEXT, request_url TEXT,
                    response_status INTEGER, duration_ms INTEGER, kind TEXT, error TEXT);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO tasks VALUES ('t1','任务一','active','GET','http://x','daily',
                    '09:00','10:00',NULL,30,100,0)",
            [],
        )
        .expect("task");
        conn.execute(
            "INSERT INTO logs (task_id, executed_at, request_method, request_url,
                    response_status, duration_ms, kind, error)
             VALUES ('t1', 1700000000000, 'GET', 'http://x', 200, 12, 'task', NULL)",
            [],
        )
        .expect("log");
        conn.execute("INSERT INTO settings VALUES ('k','v')", [])
            .expect("setting");
        conn
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jitter-probe-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn 只读连接能读到数据() {
        let dir = temp_dir("read");
        let conn = make_db(&dir);
        drop(conn);

        let ro = open_readonly(&dir.join("probe.db")).expect("open");
        let report = collect_report(&ro, &dir.join("probe.db"), 10).expect("report");
        assert_eq!(report.task_count, 1);
        assert_eq!(report.log_count, 1);
        assert_eq!(report.settings.len(), 1);
        assert_eq!(report.tasks[0].name, "任务一");
        assert_eq!(report.tasks[0].log_count, 1);
        assert_eq!(report.tasks[0].log_retention_days, Some(30));
        assert_eq!(report.recent_logs[0].task_name, "任务一");
    }

    #[test]
    fn 只读连接写不进去() {
        let dir = temp_dir("nowrite");
        let conn = make_db(&dir);
        drop(conn);

        let ro = open_readonly(&dir.join("probe.db")).expect("open");
        let result = ro.execute("UPDATE tasks SET name = '改了'", []);
        assert!(result.is_err(), "只读连接必须拒绝写操作");
        let result = ro.execute("DELETE FROM logs", []);
        assert!(result.is_err(), "只读连接必须拒绝删操作");
    }

    #[test]
    fn 只读打开不会改动数据库文件() {
        let dir = temp_dir("nomodify");
        let conn = make_db(&dir);
        drop(conn);
        let path = dir.join("probe.db");
        let before = std::fs::metadata(&path).expect("meta").len();
        let modified = std::fs::metadata(&path).expect("meta").modified().ok();

        let ro = open_readonly(&path).expect("open");
        let _ = collect_report(&ro, &path, 10).expect("report");
        drop(ro);

        assert_eq!(std::fs::metadata(&path).expect("meta").len(), before);
        if let Some(before_time) = modified {
            let after_time = std::fs::metadata(&path).expect("meta").modified().ok();
            assert_eq!(after_time, Some(before_time), "只读访问不能改动文件的修改时间");
        }
    }

    #[test]
    fn 不存在的库给出明确错误() {
        let dir = temp_dir("missing");
        let error = open_readonly(&dir.join("nope.db")).expect_err("应当失败");
        assert!(error.0.contains("不存在"));
    }

    #[test]
    fn 表名白名单挡住注入() {
        let dir = temp_dir("inject");
        let conn = make_db(&dir);
        drop(conn);
        let ro = open_readonly(&dir.join("probe.db")).expect("open");
        assert!(count_rows(&ro, "tasks; DROP TABLE logs").is_err());
        assert!(count_rows(&ro, "sqlite_master").is_err());
        assert_eq!(count_rows(&ro, "logs").expect("count"), 1);
    }
}
