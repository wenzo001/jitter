use std::fs;
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
fn save_uploaded_backup_validates_header_and_prefixes_name() {
    let db_path = temp_db_path();
    let _guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let good = b"SQLite format 3\0 rest of file";
    let entry = backup::save_uploaded_backup(&db_path, "my.db", good).expect("save");
    assert_eq!(entry.name, "uploaded-my.db");

    let again = backup::save_uploaded_backup(&db_path, "uploaded-my.db", good);
    assert!(again.is_err(), "同名备份应当被拒绝");

    assert!(backup::save_uploaded_backup(&db_path, "bad.db", b"not a sqlite file").is_err());
    assert!(backup::save_uploaded_backup(&db_path, "../evil.db", good).is_err());

    let _ = fs::remove_dir_all(db_path.parent().unwrap());
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
fn swap_database_removes_wal_sidecars() {
    let db_path = temp_db_path();
    fs::write(&db_path, b"SQLite format 3\0 old").unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", db_path.to_string_lossy()));
    let shm = std::path::PathBuf::from(format!("{}-shm", db_path.to_string_lossy()));
    fs::write(&wal, b"stale").unwrap();
    fs::write(&shm, b"stale").unwrap();

    let source = db_path.parent().unwrap().join("source.db");
    fs::write(&source, b"SQLite format 3\0 new").unwrap();

    backup::swap_database(&db_path, &source).expect("swap");
    assert!(!wal.exists());
    assert!(!shm.exists());
    assert_eq!(fs::read(&db_path).unwrap(), b"SQLite format 3\0 new");

    let _ = fs::remove_dir_all(db_path.parent().unwrap());
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
