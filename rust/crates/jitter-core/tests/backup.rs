use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use jitter_core::backup;
use jitter_core::db;

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 备份依赖进程级单例数据库，相关测试必须整段持锁。
static DB_LOCK: Mutex<()> = Mutex::new(());

fn temp_db_path() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "jitter-backup-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir.join("app.db")
}

/// 用当前 schema 的关键表/列构造一个真实、可打开的 SQLite 文件。
fn make_valid_db(path: &Path, user_version: i64) {
    let conn = rusqlite::Connection::open(path).expect("open sqlite");
    conn.execute_batch(
        r#"
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          request_url TEXT NOT NULL,
          request_method TEXT NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          executed_at INTEGER NOT NULL
        );
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        "#,
    )
    .expect("create schema");
    conn.pragma_update(None, "user_version", user_version)
        .expect("set user_version");
    drop(conn);
}

fn insert_task(path: &Path, id: &str) {
    let conn = rusqlite::Connection::open(path).expect("open sqlite");
    conn.execute(
        "INSERT INTO tasks (id, name, request_url, request_method, window_start, window_end, created_at, updated_at)
         VALUES (?1, ?1, 'https://example.com', 'GET', '10:00', '10:30', 0, 0)",
        [id],
    )
    .expect("insert task");
    drop(conn);
}

fn has_task(path: &Path, id: &str) -> bool {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open sqlite");
    let found: i64 = conn
        .query_row("SELECT count(*) FROM tasks WHERE id = ?1", [id], |row| row.get(0))
        .expect("query tasks");
    found == 1
}

#[test]
fn rejects_path_traversal_names() {
    let db_path = temp_db_path();
    for name in ["../app.db", "..app.db", "a..b.db", "a/b.db", "a\\b.db", ".db", "x.db/", "x.txt"] {
        assert!(
            backup::resolve_backup_path(&db_path, name).is_err(),
            "应当拒绝 {name}"
        );
    }
    assert!(backup::resolve_backup_path(&db_path, "jitter-20260101-000000.db").is_ok());
    assert!(backup::resolve_backup_path(&db_path, "uploaded-keep.db").is_ok());
}

#[test]
fn backup_file_name_has_collision_suffix() {
    let base = backup::backup_file_name(0, 0);
    assert!(base.starts_with("jitter-") && base.ends_with(".db"));
    let suffixed = backup::backup_file_name(0, 3);
    assert!(suffixed.starts_with("jitter-") && suffixed.ends_with("-3.db"));
}

#[test]
fn create_list_delete_round_trip() {
    let db_path = temp_db_path();
    let _guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = fs::remove_file(&db_path);
    db::init_db(Some(db_path.to_string_lossy().as_ref())).expect("init");

    // 库里有内容时做快照。
    db::create_task(&simple_task("t1"), "t1", 1000).expect("create task");

    let entry = backup::create_backup(&db_path, 1_000_000).expect("create backup");
    assert!(entry.name.starts_with("jitter-"));
    assert!(entry.size > 0);
    assert!(entry.modified_at > 0.0);

    let listed = backup::list_backups(&db_path);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, entry.name);

    assert!(backup::backup_exists(&db_path, &entry.name).expect("exists"));
    backup::delete_backup(&db_path, &entry.name).expect("delete");
    assert!(!backup::backup_exists(&db_path, &entry.name).expect("exists"));
    assert_eq!(backup::list_backups(&db_path).len(), 0);

    let _ = fs::remove_dir_all(db_path.parent().unwrap());
    db::close_db();
}

#[test]
fn save_uploaded_backup_requires_real_database_content() {
    let db_path = temp_db_path();
    let _guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = fs::remove_file(&db_path);
    db::init_db(Some(db_path.to_string_lossy().as_ref())).expect("init");
    db::create_task(&simple_task("t1"), "t1", 1000).expect("create task");
    let entry = backup::create_backup(&db_path, 1_000_000).expect("backup");
    let real_bytes =
        fs::read(backup::get_backup_dir(&db_path).join(&entry.name)).expect("read backup bytes");
    db::close_db();

    let upload_path = temp_db_path();
    let good = backup::save_uploaded_backup(&upload_path, "my.db", &real_bytes).expect("save real db");
    assert_eq!(good.name, "uploaded-my.db");

    let again = backup::save_uploaded_backup(&upload_path, "uploaded-my.db", &real_bytes);
    assert!(again.is_err(), "同名备份应当被拒绝");

    // 只有 SQLite magic、内容不是数据库：必须拒绝（旧实现只查头部前缀）。
    let fake = b"SQLite format 3\0 rest of file is garbage";
    assert!(
        backup::save_uploaded_backup(&upload_path, "bad.db", fake).is_err(),
        "伪造 magic 的文件必须被拒绝"
    );
    assert!(
        !backup::get_backup_dir(&upload_path).join("uploaded-bad.db").exists(),
        "被拒绝的上传不能留下任何文件"
    );

    assert!(backup::save_uploaded_backup(&upload_path, "notdb.db", b"not a sqlite file").is_err());
    assert!(backup::save_uploaded_backup(&upload_path, "../evil.db", &real_bytes).is_err());

    let _ = fs::remove_dir_all(upload_path.parent().unwrap());
}

#[test]
fn validate_database_file_accepts_real_and_rejects_fake() {
    let dir = std::env::temp_dir().join(format!("jitter-validate-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let supported = backup::DEFAULT_SUPPORTED_SCHEMA_VERSION;

    let good = dir.join("good.db");
    make_valid_db(&good, 0);
    backup::validate_database_file(&good, supported).expect("真实数据库应通过校验");

    let fake = dir.join("fake.db");
    fs::write(&fake, b"SQLite format 3\0 garbage beyond the header").unwrap();
    assert!(
        backup::validate_database_file(&fake, supported).is_err(),
        "只有 magic 的伪文件必须被拒绝"
    );

    let not_a_db = dir.join("text.db");
    fs::write(&not_a_db, b"hello world").unwrap();
    assert!(backup::validate_database_file(&not_a_db, supported).is_err());

    let missing = dir.join("missing.db");
    assert!(backup::validate_database_file(&missing, supported).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn validate_database_file_enforces_user_version_ceiling() {
    let dir = std::env::temp_dir().join(format!("jitter-validate-uv-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();

    let path = dir.join("future.db");
    make_valid_db(&path, 99);
    assert!(
        backup::validate_database_file(&path, 5).is_err(),
        "user_version 高于当前支持版本的备份必须拒绝恢复"
    );
    backup::validate_database_file(&path, 99).expect("等于支持版本应通过");
    backup::validate_database_file(&path, 100).expect("低于支持版本（回滚场景）应通过");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn validate_database_file_requires_current_schema_tables_and_columns() {
    let dir = std::env::temp_dir().join(format!("jitter-validate-schema-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let supported = backup::DEFAULT_SUPPORTED_SCHEMA_VERSION;

    // 缺关键表。
    let missing_table = dir.join("partial.db");
    {
        let conn = rusqlite::Connection::open(&missing_table).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, request_url TEXT, request_method TEXT,
                                  window_start TEXT, window_end TEXT, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
    }
    assert!(
        backup::validate_database_file(&missing_table, supported).is_err(),
        "缺少 logs 关键表的备份必须拒绝"
    );

    // 关键表缺列。
    let missing_column = dir.join("missing-col.db");
    {
        let conn = rusqlite::Connection::open(&missing_column).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, request_url TEXT, request_method TEXT,
                                  window_start TEXT, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE logs (id INTEGER PRIMARY KEY, task_id TEXT, executed_at INTEGER);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
    }
    assert!(
        backup::validate_database_file(&missing_column, supported).is_err(),
        "tasks 缺少 window_end 列的备份必须拒绝"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn swap_rejects_invalid_backup_without_touching_live_db() {
    let dir = std::env::temp_dir().join(format!("jitter-swap-reject-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("app.db");
    make_valid_db(&db_path, 0);
    insert_task(&db_path, "keep-me");
    fs::write(format!("{}-wal", db_path.display()), b"live wal").unwrap();
    let original = fs::read(&db_path).unwrap();

    let bad = dir.join("bad.db");
    fs::write(&bad, b"SQLite format 3\0 not really a database").unwrap();
    assert!(backup::swap_database(&db_path, &bad).is_err(), "损坏备份必须拒绝换入");

    let future = dir.join("future.db");
    make_valid_db(&future, 9999);
    assert!(backup::swap_database(&db_path, &future).is_err(), "未来 schema 版本必须拒绝换入");

    assert_eq!(fs::read(&db_path).unwrap(), original, "校验失败不得改动现场数据库");
    assert_eq!(fs::read(format!("{}-wal", db_path.display())).unwrap(), b"live wal");
    assert!(!dir.join("app.db.restore-staging").exists(), "失败后不能留下 staging 残留");
    assert!(!dir.join("app.db.restore-safe").exists(), "失败后不能留下安全副本残留");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn swap_replaces_atomically_and_keeps_rollback_copy() {
    let dir = std::env::temp_dir().join(format!("jitter-swap-ok-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("app.db");
    make_valid_db(&db_path, 0);
    insert_task(&db_path, "old");
    let original = fs::read(&db_path).unwrap();
    fs::write(format!("{}-wal", db_path.display()), b"stale wal").unwrap();
    fs::write(format!("{}-shm", db_path.display()), b"stale shm").unwrap();

    let source = dir.join("source.db");
    make_valid_db(&source, 0);
    insert_task(&source, "new");

    backup::swap_database(&db_path, &source).expect("swap");
    assert!(has_task(&db_path, "new"), "恢复后应当读到备份里的数据");
    assert!(!has_task(&db_path, "old"));
    assert!(!Path::new(&format!("{}-wal", db_path.display())).exists(), "陈旧 WAL 必须被清理");
    assert!(!Path::new(&format!("{}-shm", db_path.display())).exists(), "陈旧 SHM 必须被清理");
    assert!(!dir.join("app.db.restore-staging").exists(), "staging 应当被 rename 消耗掉");
    // 替换前保留的可回滚安全副本，供「初始化失败」时由调用方回滚。
    let safety = dir.join("app.db.restore-safe");
    assert!(safety.exists(), "应保留可回滚的安全副本");
    assert_eq!(fs::read(&safety).unwrap(), original);

    // 初始化失败的回滚：恢复安全副本，现场数据原样回来。
    assert!(backup::rollback_swap(&db_path).expect("rollback"), "存在安全副本时应回滚成功");
    assert_eq!(fs::read(&db_path).unwrap(), original, "回滚后数据库应恢复原状");
    assert_eq!(fs::read(format!("{}-wal", db_path.display())).unwrap(), b"stale wal");
    assert!(!safety.exists(), "回滚后安全副本应被消耗");
    assert!(backup::rollback_swap(&db_path).expect("second rollback") == false, "没有安全副本时回滚返回 false");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn swap_finalizes_by_discarding_safety_copy() {
    let dir = std::env::temp_dir().join(format!("jitter-swap-finalize-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("app.db");
    make_valid_db(&db_path, 0);
    let source = dir.join("source.db");
    make_valid_db(&source, 0);

    backup::swap_database(&db_path, &source).expect("swap");
    assert!(dir.join("app.db.restore-safe").exists());
    backup::finalize_swap(&db_path).expect("finalize");
    assert!(!dir.join("app.db.restore-safe").exists(), "确认成功后安全副本应被清理");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn swap_rolls_back_when_replace_fails() {
    let dir = std::env::temp_dir().join(format!("jitter-swap-rollback-{}", SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("app.db");
    make_valid_db(&db_path, 0);
    insert_task(&db_path, "live");
    let original = fs::read(&db_path).unwrap();
    fs::write(format!("{}-wal", db_path.display()), b"live wal").unwrap();

    let source = dir.join("source.db");
    make_valid_db(&source, 0);
    insert_task(&source, "new");

    // 注入替换失败（模拟权限/占用等跨平台 rename 错误）。
    let failing = &|_src: &Path, _dst: &Path| -> Result<(), std::io::Error> {
        Err(std::io::Error::other("injected rename failure"))
    };
    let result = backup::swap_database_with_replace(
        &db_path,
        &source,
        backup::DEFAULT_SUPPORTED_SCHEMA_VERSION,
        failing,
    );
    assert!(result.is_err(), "替换失败必须报错");

    assert_eq!(fs::read(&db_path).unwrap(), original, "替换失败必须回滚现场数据库");
    assert!(has_task(&db_path, "live"), "回滚后现场数据仍可读");
    assert_eq!(
        fs::read(format!("{}-wal", db_path.display())).unwrap(),
        b"live wal",
        "回滚必须把 WAL 一并恢复"
    );
    assert!(!dir.join("app.db.restore-staging").exists(), "回滚后不能有 staging 残留");
    assert!(!dir.join("app.db.restore-safe").exists(), "回滚后安全副本应已被还原消耗");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn swap_reports_incomplete_rollback_when_a_sidecar_cannot_be_restored() {
    let dir = std::env::temp_dir().join(format!(
        "jitter-swap-sidecar-rollback-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("app.db");
    make_valid_db(&db_path, 0);
    insert_task(&db_path, "live");
    let original = fs::read(&db_path).unwrap();
    let wal_path = format!("{}-wal", db_path.display());
    fs::write(&wal_path, b"live wal").unwrap();

    let source = dir.join("source.db");
    make_valid_db(&source, 0);
    insert_task(&source, "new");
    let blocked_wal = std::path::PathBuf::from(&wal_path);
    let failing = move |_src: &Path, _dst: &Path| -> Result<(), std::io::Error> {
        let _ = fs::remove_file(&blocked_wal);
        fs::create_dir(&blocked_wal)?;
        Err(std::io::Error::other("injected replace failure"))
    };

    let error = backup::swap_database_with_replace(
        &db_path,
        &source,
        backup::DEFAULT_SUPPORTED_SCHEMA_VERSION,
        &failing,
    )
    .expect_err("replace must fail");
    assert!(error.0.contains("回滚失败"), "边车回滚失败必须显式报错: {error:?}");
    assert!(error.0.contains("wal"), "应指出具体失败的边车: {error:?}");
    assert_eq!(fs::read(&db_path).unwrap(), original, "主库仍应尽力恢复");
    assert!(Path::new(&wal_path).is_dir(), "夹具必须让 WAL 边车无法恢复");
    assert!(dir.join("app.db.restore-safe-wal").exists(), "恢复失败的边车副本必须保留供人工恢复");

    fs::remove_dir(&wal_path).expect("remove blocking WAL directory");
    assert!(has_task(&db_path, "live"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn restore_round_trip_preserves_data() {
    let db_path = temp_db_path();
    let _guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = fs::remove_file(&db_path);
    db::init_db(Some(db_path.to_string_lossy().as_ref())).expect("init");

    db::create_task(&simple_task("t1"), "t1", 1000).expect("create task");
    let plan = backup::prepare_restore(&db_path, &backup_name_of_first(&db_path), 2_000_000).expect("prepare");

    // 篡改当前数据：删掉任务。恢复后应当回来。
    db::delete_task("t1").expect("delete task");

    db::close_db();
    backup::swap_database(&db_path, &plan.backup_path).expect("swap");
    db::init_db(Some(db_path.to_string_lossy().as_ref())).expect("re-init");

    let task = db::get_task("t1").expect("read").expect("restored task exists");
    assert_eq!(task.name, "t1");
    // 恢复前自动另存了一份当前状态。
    assert!(!plan.safety_name.is_empty());

    let _ = fs::remove_dir_all(db_path.parent().unwrap());
    db::close_db();
}

#[test]
fn prepare_restore_rejects_invalid_backup_before_touching_anything() {
    let db_path = temp_db_path();
    let _guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = fs::remove_file(&db_path);
    db::init_db(Some(db_path.to_string_lossy().as_ref())).expect("init");

    let dir = backup::get_backup_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("corrupt.db"), b"SQLite format 3\0 not a real database").unwrap();

    let before = backup::list_backups(&db_path).len();
    let result = backup::prepare_restore(&db_path, "corrupt.db", 3_000_000);
    assert!(result.is_err(), "损坏备份应当在准备阶段就失败");
    assert_eq!(backup::list_backups(&db_path).len(), before, "校验失败不得创建安全备份");

    let _ = fs::remove_dir_all(db_path.parent().unwrap());
    db::close_db();
}

fn simple_task(name: &str) -> db::NewTaskInput {
    db::NewTaskInput {
        name: name.to_string(),
        curl_command: Some(format!("curl https://example.com/{name}")),
        request: db::RequestParts {
            url: format!("https://example.com/{name}"),
            method: "GET".to_string(),
            headers: Some("{\"X-Test\":\"1\"}".to_string()),
            body: None,
            options: Some("{}".to_string()),
        },
        window_start: "10:10".to_string(),
        window_end: "10:20".to_string(),
        ..Default::default()
    }
}

fn backup_name_of_first(db_path: &std::path::Path) -> String {
    backup::create_backup(db_path, 1_000_000).expect("create backup").name
}
