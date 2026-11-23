use std::fs;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use jitter_core::db::*;
use serde_json::json;

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 数据库是进程级单例，涉及它的测试必须串行（TS 版同理）。
static DB_LOCK: Mutex<()> = Mutex::new(());

fn temp_dir() -> String {
    // 每个测试用独立目录：测试并行跑，共用目录会互相踩。
    let dir = std::env::temp_dir().join(format!(
        "jitter-db-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir.to_string_lossy().to_string()
}

fn cleanup(path: &str) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(format!("{path}-wal"));
    let _ = fs::remove_file(format!("{path}-shm"));
    let _ = fs::remove_file(std::path::Path::new(path).parent().unwrap().join("backups"));
    let _ = fs::remove_dir(std::path::Path::new(path).parent().unwrap());
}

fn task_input(name: &str) -> NewTaskInput {
    NewTaskInput {
        name: name.to_string(),
        curl_command: Some(format!("curl https://example.com/{name}")),
        request: RequestParts {
            url: format!("https://example.com/{name}"),
            method: "GET".to_string(),
            headers: Some(json!({ "X-Test": "1" }).to_string()),
            body: None,
            options: Some("{}".to_string()),
        },
        window_start: "10:10".to_string(),
        window_end: "10:20".to_string(),
        ..Default::default()
    }
}

fn task_with_notify(name: &str) -> NewTaskInput {
    NewTaskInput {
        notify_enabled: true,
        notify_curl_command: Some("curl -X POST https://notify.example/ping".to_string()),
        notify_request: Some(RequestParts {
            url: "https://notify.example/ping".to_string(),
            method: "POST".to_string(),
            headers: Some(json!({ "Content-Type": "application/json" }).to_string()),
            body: Some("{\"text\":\"done\"}".to_string()),
            options: Some("{}".to_string()),
        }),
        expect_status: Some(200),
        ..task_input(name)
    }
}

fn task_with_guard(name: &str) -> NewTaskInput {
    NewTaskInput {
        precheck_enabled: true,
        precheck_curl_command: Some("curl https://guard.example/check".to_string()),
        precheck_request: Some(RequestParts {
            url: "https://guard.example/check".to_string(),
            method: "GET".to_string(),
            headers: Some("{}".to_string()),
            body: None,
            options: Some("{}".to_string()),
        }),
        precheck_weekdays: Some(vec![1, 3, 5]),
        precheck_time_start: Some("09:00".to_string()),
        precheck_time_end: Some("18:00".to_string()),
        ..task_input(name)
    }
}

#[test]
fn creates_and_reads_a_task_with_notification_config() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    assert_eq!(get_journal_mode().expect("journal"), "wal");

    let task = create_task(&task_with_notify("notify me"), "t1", 1000).expect("create");
    assert_eq!(task.id, "t1");
    assert_eq!(task.status, "active");
    assert_eq!(task.notify_enabled, 1);
    assert_eq!(task.notify_url.as_deref(), Some("https://notify.example/ping"));
    assert_eq!(task.notify_method.as_deref(), Some("POST"));
    assert_eq!(task.expect_status, Some(200));
    assert!(task.request_headers.as_deref().unwrap_or("").contains("X-Test"));

    let loaded = get_task("t1").expect("read").expect("exists");
    assert_eq!(loaded.name, "notify me");
    cleanup(&path);
    close_db();
}

#[test]
fn guard_is_only_enabled_with_a_real_condition() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");

    // 无条件的 guard 视为未启用。
    let empty = NewTaskInput {
        precheck_enabled: true,
        ..task_input("empty guard")
    };
    let stored = create_task(&empty, "g0", 1000).expect("create");
    assert_eq!(stored.precheck_enabled, 0);

    let guarded = create_task(&task_with_guard("real guard"), "g1", 1000).expect("create");
    assert_eq!(guarded.precheck_enabled, 1);
    assert_eq!(guarded.precheck_weekdays.as_deref(), Some("1,3,5"));
    assert_eq!(guarded.precheck_time_start.as_deref(), Some("09:00"));
    cleanup(&path);
    close_db();
}

#[test]
fn update_task_config_preserves_scheduling_state() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("before"), "t1", 1000).expect("create");
    update_task_next_run("t1", Some(5000), 2000).expect("next run");

    let mut input = task_input("after");
    input.request.url = "https://example.com/after".to_string();
    let updated = update_task_config("t1", &input, 3000).expect("update").expect("exists");
    assert_eq!(updated.name, "after");
    assert_eq!(updated.request_url, "https://example.com/after");
    assert_eq!(updated.next_run_at, Some(5000), "调度状态不被配置更新覆盖");
    assert_eq!(updated.created_at, 1000);
    assert_eq!(updated.updated_at, 3000);
    cleanup(&path);
    close_db();
}

#[test]
fn delete_task_removes_all_related_rows() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("victim"), "t1", 1000).expect("create");
    insert_log(&NewLogInput {
        task_id: "t1".into(),
        executed_at: 1100,
        ..Default::default()
    })
    .expect("log");
    insert_test_run("t1", true, "{}", "[]", 1200).expect("test run");

    let outcome = delete_task("t1").expect("delete");
    assert!(outcome.deleted);
    assert_eq!(outcome.deleted_logs, 1);
    assert_eq!(outcome.deleted_test_runs, 1);
    assert!(get_task("t1").expect("read").is_none());
    cleanup(&path);
    close_db();
}

#[test]
fn log_summaries_paging_and_since_window() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("logger"), "t1", 1000).expect("create");
    for index in 0..10i64 {
        insert_log(&NewLogInput {
            task_id: "t1".into(),
            executed_at: 2000 + index * 1000,
            response_status: Some(200),
            duration_ms: Some(100),
            ..Default::default()
        })
        .expect("log");
    }

    let first_page = list_log_summaries("t1", 3, None, None).expect("page");
    assert_eq!(first_page.len(), 3);
    assert_eq!(first_page[0].executed_at, 11000);
    assert!(first_page[0].request_url.is_none(), "测试没写 url，轻量行如实返回 None");

    let cursor = LogCursor {
        executed_at: first_page[2].executed_at,
        id: first_page[2].id,
    };
    let second_page = list_log_summaries("t1", 3, Some(cursor), None).expect("page");
    assert_eq!(second_page[0].executed_at, 8000);

    let recent = list_log_summaries("t1", 100, None, Some(7000)).expect("page");
    assert_eq!(recent.len(), 5);
    assert_eq!(recent[0].executed_at, 11000);

    let full = list_logs("t1", 100, None).expect("full");
    assert_eq!(full.len(), 10);
    let detail = get_log(full[0].id).expect("detail").expect("exists");
    assert_eq!(detail.executed_at, full[0].executed_at);
    cleanup(&path);
    close_db();
}

#[test]
fn retention_prunes_by_age_and_per_task_count() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("prune"), "t1", 1000).expect("create");
    // 日志分布在第 1..40 天。
    const DAY: i64 = 86_400_000;
    for index in 0..40i64 {
        insert_log(&NewLogInput {
            task_id: "t1".into(),
            executed_at: (index + 1) * DAY,
            ..Default::default()
        })
        .expect("log");
    }
    // 保留 30 天：第 1..9 天的 9 条被删。
    let outcome = prune_logs(40 * DAY, 30, 0);
    assert_eq!(outcome.expect("prune").by_age, 9);

    // 每任务只保留最新 5 条（此前剩 31 条，删 26 条）。
    let outcome = prune_logs(40 * DAY, 0, 5).expect("prune");
    assert_eq!(outcome.by_count, 26);
    let remaining = list_logs("t1", 100, None).expect("list");
    assert_eq!(remaining.len(), 5);
    assert_eq!(remaining[0].executed_at, 40 * DAY, "最新在前");
    cleanup(&path);
    close_db();
}

#[test]
fn cleanup_logs_vacuums_and_reports() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("cleanup"), "t1", 1000).expect("create");
    for index in 0..5i64 {
        insert_log(&NewLogInput {
            task_id: "t1".into(),
            executed_at: 1000 + index,
            ..Default::default()
        })
        .expect("log");
    }
    let outcome = cleanup_logs(Some(1003)).expect("cleanup");
    assert_eq!(outcome.deleted, 3);
    assert_eq!(outcome.remaining, 2);
    assert_eq!(outcome.cutoff, Some(1003));

    let all = cleanup_logs(None).expect("cleanup all");
    assert_eq!(all.deleted, 2);
    assert_eq!(all.remaining, 0);
    cleanup(&path);
    close_db();
}

#[test]
fn settings_override_the_config_default() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    assert_eq!(get_effective_retention_days(30).expect("value"), 30);
    set_setting(LOG_RETENTION_SETTING, Some("90")).expect("save");
    assert_eq!(get_effective_retention_days(30).expect("value"), 90);
    set_setting(LOG_RETENTION_SETTING, Some("9999")).expect("save");
    assert_eq!(get_effective_retention_days(30).expect("value"), 30, "超范围值回落到默认");
    set_setting(LOG_RETENTION_SETTING, None).expect("clear");
    assert_eq!(get_effective_retention_days(30).expect("value"), 30);
    cleanup(&path);
    close_db();
}

#[test]
fn test_runs_keep_the_newest_per_task() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("bench"), "t1", 1000).expect("create");
    create_task(&task_input("other"), "t2", 1000).expect("create");
    for index in 0..15i64 {
        insert_test_run("t1", index % 2 == 0, "{\"ok\":true}", "[]", 1000 + index).expect("insert");
    }
    insert_test_run("t2", false, "{}", "[]", 1000).expect("insert");
    let runs = list_test_runs("t1", TEST_RUN_KEEP).expect("list");
    assert_eq!(runs.len(), TEST_RUN_KEEP as usize);
    assert_eq!(runs[0].created_at, 1014, "最新在前");
    assert_eq!(runs[0].ok, 1, "index 14 是偶数 → 成功");
    let detail = get_test_run(runs[0].id).expect("detail").expect("exists");
    assert_eq!(detail.steps, "[]");
    cleanup(&path);
    close_db();
}

#[test]
fn sort_order_and_reordering() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("first"), "t1", 1000).expect("create");
    create_task(&task_input("second"), "t2", 2000).expect("create");
    let tasks = list_tasks().expect("list");
    assert_eq!(tasks[0].id, "t2", "新任务在最前");
    assert!(tasks[0].sort_order < tasks[1].sort_order);

    reorder_tasks(&["t1".to_string(), "t2".to_string()]).expect("reorder");
    let tasks = list_tasks().expect("list");
    assert_eq!(tasks[0].id, "t1");
    cleanup(&path);
    close_db();
}

#[test]
fn migrations_repair_legacy_rows() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\legacy.db");
    let _ = fs::remove_file(&path);
    // 手工建一个"旧版"库：缺 schedule_kind / sort_order / paused_from 等新列。
    {
        let conn = rusqlite::Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE tasks (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, curl_command TEXT,
               request_url TEXT NOT NULL, request_method TEXT NOT NULL DEFAULT 'GET',
               request_headers TEXT, request_body TEXT, window_start TEXT NOT NULL,
               window_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
               next_run_at INTEGER, paused_until INTEGER, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, notify_enabled INTEGER NOT NULL DEFAULT 0,
               notify_curl_command TEXT,
               notify_url TEXT, notify_method TEXT, notify_headers TEXT, notify_body TEXT,
               expect_status INTEGER, expect_body TEXT
             );
             INSERT INTO tasks (id, name, request_url, window_start, window_end,
                                paused_until, created_at, updated_at)
             VALUES ('legacy1', '旧任务', 'https://example.com', '10:10', '10:20',
                     NULL, 1000, 1000);
             CREATE TABLE logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
               executed_at INTEGER NOT NULL, request_url TEXT, request_method TEXT,
               request_headers TEXT, request_body TEXT, response_status INTEGER,
               response_headers TEXT, response_body TEXT, duration_ms INTEGER,
               error TEXT, aborted INTEGER DEFAULT 0, kind TEXT NOT NULL DEFAULT 'task',
               parent_log_id INTEGER, matched INTEGER
             );",
        )
        .expect("seed");
    }
    init_db(Some(&path)).expect("init");
    let task = get_task("legacy1").expect("read").expect("exists");
    assert_eq!(task.schedule_kind, "daily");
    assert_eq!(task.window_start, "10:10", "合法窗口保留");
    assert!(task.sort_order >= 0, "迁移后有了显式顺序");

    // 再打开一次：幂等。
    close_db();
    init_db(Some(&path)).expect("reopen");
    assert!(get_task("legacy1").expect("read").is_some());
    cleanup(&path);
    close_db();
}

#[test]
fn legacy_pause_and_cron_rows_are_backfilled() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\legacy2.db");
    let _ = fs::remove_file(&path);
    {
        let conn = rusqlite::Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE tasks (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, curl_command TEXT,
               request_url TEXT NOT NULL, request_method TEXT NOT NULL DEFAULT 'GET',
               request_headers TEXT, request_body TEXT, window_start TEXT NOT NULL,
               window_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
               schedule_kind TEXT, next_run_at INTEGER, paused_until INTEGER,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               notify_enabled INTEGER NOT NULL DEFAULT 0, notify_curl_command TEXT, notify_url TEXT,
               notify_method TEXT, notify_headers TEXT, notify_body TEXT,
               expect_status INTEGER, expect_body TEXT
             );
             INSERT INTO tasks (id, name, request_url, window_start, window_end,
                                schedule_kind, paused_until, created_at, updated_at)
             VALUES ('p1', '旧暂停', 'https://example.com', '10:10', '10:20',
                     'daily', 9999999999999, 1000, 1000);
             INSERT INTO tasks (id, name, request_url, window_start, window_end,
                                schedule_kind, created_at, updated_at)
             VALUES ('c1', '旧Cron', 'https://example.com', '', '', 'cron', 1000, 1000);",
        )
        .expect("seed");
    }
    init_db(Some(&path)).expect("init");
    let paused = get_task("p1").expect("read").expect("exists");
    assert!(paused.paused_from.is_some(), "旧暂停补了起点");
    assert!(paused.next_run_at.is_none(), "旧暂停清了计划");

    let cron = get_task("c1").expect("read").expect("exists");
    assert_eq!(cron.schedule_kind, "daily");
    assert_eq!(cron.window_start, "00:00", "坏窗口给了占位窗口");
    assert_eq!(cron.window_end, "00:05");
    cleanup(&path);
    close_db();
}

#[test]
fn run_totals_count_successes() {
    let dir = temp_dir();
    let _db_guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = format!("{dir}\\app.db");
    let _ = fs::remove_file(&path);
    init_db(Some(&path)).expect("init");
    create_task(&task_input("metrics"), "t1", 1000).expect("create");
    for (index, (status, error)) in [
        (Some(200i64), None),
        (Some(200), None),
        (Some(500), None),
        (None, Some("timeout".to_string())),
    ]
    .into_iter()
    .enumerate()
    {
        insert_log(&NewLogInput {
            task_id: "t1".into(),
            executed_at: 1000 + index as i64,
            response_status: status,
            // (类型已在元组里标注)
            error,
            duration_ms: Some(100 + index as i64 * 10),
            ..Default::default()
        })
        .expect("log");
    }
    let totals = count_runs_since(0).expect("totals");
    assert_eq!(totals.runs, 4);
    assert_eq!(totals.ok, 2);
    assert!(totals.avg_duration_ms.unwrap_or(0.0) > 100.0);
    cleanup(&path);
    close_db();
}
