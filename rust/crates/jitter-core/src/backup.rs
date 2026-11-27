//! 数据库备份 / 导出 / 导入 / 恢复。
//!
//! 与 TypeScript 版 `src/backup.ts` 行为对齐：备份用 `VACUUM INTO`（活库上
//! 做完整快照，正确合并 WAL，不停服务）；恢复前自动另存当前状态的安全备份。
//!
//! 恢复安全约束（本模块的责任边界）：
//! - 换入前必须完整校验备份文件（可打开、quick_check 通过、关键表/列齐备、
//!   user_version 不高于当前支持版本）；校验失败绝不触碰现场库。
//! - 替换走「staging 复制 → 现场安全副本 → 原子 rename」；rename 失败自动回滚。
//! - 换入成功后保留文件级安全副本（`<db>.restore-safe[-wal|-shm]`），供调用方
//!   在「重新初始化失败」时执行 [`rollback_swap`]；确认成功用 [`finalize_swap`]。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::db;

#[derive(Debug, Clone, Serialize)]
pub struct BackupEntry {
    pub name: String,
    pub size: u64,
    pub modified_at: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupError(pub String);

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BackupError {}

impl From<db::DbError> for BackupError {
    fn from(error: db::DbError) -> Self {
        BackupError(error.0)
    }
}

impl From<std::io::Error> for BackupError {
    fn from(error: std::io::Error) -> Self {
        BackupError(error.to_string())
    }
}

fn fail(message: &str) -> BackupError {
    BackupError(message.to_string())
}

/// 备份文件名白名单：字母数字开头，只含字母数字 / 点 / 下划线 / 连字符。
fn name_is_valid(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let rest_ok = chars.clone().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    let tail_ok = name.ends_with(".db") && name.len() > ".db".len();
    // 双保险之一：名字里不允许出现 ".."（防路径穿越）。
    rest_ok && tail_ok && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

fn backup_dir_for(db_path: &Path) -> PathBuf {
    db_path.parent().unwrap_or_else(|| Path::new(".")).join("backups")
}

pub fn get_backup_dir(db_path: &Path) -> PathBuf {
    backup_dir_for(db_path)
}

fn timestamp(now_ms: i64) -> String {
    let local = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|utc| utc.with_timezone(&chrono::Local))
        .unwrap_or_else(chrono::Local::now);
    local.format("%Y%m%d-%H%M%S").to_string()
}

/// 新备份的文件名；冲突时加数字后缀（`VACUUM INTO` 拒绝覆盖已有文件）。
pub fn backup_file_name(now_ms: i64, attempt: u32) -> String {
    let suffix = if attempt == 0 { String::new() } else { format!("-{attempt}") };
    format!("jitter-{}{suffix}.db", timestamp(now_ms))
}

/// 校验文件名并返回备份文件的绝对路径（防路径穿越）。
pub fn resolve_backup_path(db_path: &Path, name: &str) -> Result<PathBuf, BackupError> {
    if !name_is_valid(name) {
        return Err(fail(&format!("备份文件名不合法: {name}")));
    }
    let dir = backup_dir_for(db_path);
    let target = dir.join(name);
    // 双保险：解析后必须仍然在备份目录里。
    if target.parent() != Some(dir.as_path()) {
        return Err(fail(&format!("备份文件名不合法: {name}")));
    }
    Ok(target)
}

fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// 做一份完整快照（活库上安全，正确合并 WAL）。
pub fn create_backup(db_path: &Path, now_ms: i64) -> Result<BackupEntry, BackupError> {
    let dir = backup_dir_for(db_path);
    fs::create_dir_all(&dir)?;
    // 快照时强制把 WAL 合并进主文件，确保 VACUUM INTO 拿到的是最新状态。
    db::with_connection(|conn| {
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |_| Ok(()));
        Ok(())
    })?;

    let mut target: Option<PathBuf> = None;
    for attempt in 0..100u32 {
        let candidate = dir.join(backup_file_name(now_ms, attempt));
        if !candidate.exists() {
            target = Some(candidate);
            break;
        }
    }
    let target = target.ok_or_else(|| fail("备份文件名冲突，无法创建备份"))?;

    db::with_connection(|conn| {
        let escaped = target.to_string_lossy().replace('\'', "''");
        conn.execute(&format!("VACUUM INTO '{escaped}'"), [])?;
        Ok(())
    })
    .map_err(|error: db::DbError| {
        let _ = fs::remove_file(&target);
        BackupError(error.0)
    })?;

    let metadata = fs::metadata(&target)?;
    Ok(BackupEntry {
        name: target.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        size: metadata.len(),
        modified_at: mtime_ms(&metadata),
    })
}

/// 列出全部备份（按时间倒序）。
pub fn list_backups(db_path: &Path) -> Vec<BackupEntry> {
    let dir = backup_dir_for(db_path);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut result: Vec<BackupEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name_is_valid(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        result.push(BackupEntry {
            name,
            size: metadata.len(),
            modified_at: mtime_ms(&metadata),
        });
    }
    result.sort_by(|a, b| b.modified_at.partial_cmp(&a.modified_at).unwrap_or(std::cmp::Ordering::Equal));
    result
}

/// 备份文件是否存在。
pub fn backup_exists(db_path: &Path, name: &str) -> Result<bool, BackupError> {
    Ok(resolve_backup_path(db_path, name)?.exists())
}

/// 删除一份备份。
pub fn delete_backup(db_path: &Path, name: &str) -> Result<(), BackupError> {
    let target = resolve_backup_path(db_path, name)?;
    if !target.exists() {
        return Err(fail(&format!("备份不存在: {name}")));
    }
    fs::remove_file(&target)?;
    Ok(())
}

/// 当前代码支持的数据库 schema 版本（`PRAGMA user_version`）。
pub const DEFAULT_SUPPORTED_SCHEMA_VERSION: i64 = db::SCHEMA_VERSION;

/// 恢复时必须存在的关键表与列（与 db::SCHEMA 的迁移底线一致）。
/// 不在列表里的表/列（如 test_runs、holiday_years）由 init_db 幂等重建，
/// 不作为恢复的硬性前提。
const REQUIRED_SCHEMA: &[(&str, &[&str])] = &[
    (
        "tasks",
        &[
            "id",
            "name",
            "request_url",
            "request_method",
            "window_start",
            "window_end",
            "created_at",
            "updated_at",
        ],
    ),
    ("logs", &["id", "task_id", "executed_at"]),
    ("settings", &["key", "value"]),
];

/// 完整校验一个数据库文件：可打开（只读）、quick_check 通过、
/// 关键表/列与当前 schema 兼容、user_version 不高于 supported_schema_version。
///
/// 只做校验，绝不写文件（含创建 WAL/SHM）。
pub fn validate_database_file(path: &Path, supported_schema_version: i64) -> Result<(), BackupError> {
    if !path.exists() {
        return Err(fail(&format!("文件不存在: {}", path.display())));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| fail(&format!("备份不是可打开的 SQLite 数据库: {error}")))?;

    let quick_check: String = conn
        .query_row("PRAGMA quick_check;", [], |row| row.get(0))
        .map_err(|error| fail(&format!("备份完整性检查失败: {error}")))?;
    if quick_check != "ok" {
        return Err(fail("备份文件已损坏（quick_check 未通过）"));
    }

    let user_version: i64 = conn
        .query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(|error| fail(&format!("读取 user_version 失败: {error}")))?;
    if user_version > supported_schema_version {
        return Err(fail(&format!(
            "备份的 schema 版本 {user_version} 高于当前支持的版本 {supported_schema_version}，拒绝恢复"
        )));
    }

    for (table, columns) in REQUIRED_SCHEMA {
        let exists: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1;",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| fail(&format!("检查备份表 {table} 失败: {error}")))?;
        if exists != 1 {
            return Err(fail(&format!("备份缺少关键表: {table}")));
        }
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| fail(&format!("检查备份表 {table} 的列失败: {error}")))?;
        let existing: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| fail(&format!("检查备份表 {table} 的列失败: {error}")))?
            .filter_map(|result| result.ok())
            .collect();
        drop(statement);
        for column in *columns {
            if !existing.iter().any(|name| name == column) {
                return Err(fail(&format!("备份表 {table} 缺少关键列: {column}")));
            }
        }
    }
    Ok(())
}

/// 把上传的字节保存为一份备份（文件名固定加 uploaded- 前缀）。
///
/// 只认 SQLite magic 是不够的：先落到临时文件做完整校验，通过后才启用。
pub fn save_uploaded_backup(db_path: &Path, name: &str, bytes: &[u8]) -> Result<BackupEntry, BackupError> {
    if !name_is_valid(name) {
        return Err(fail(&format!("备份文件名不合法: {name}")));
    }
    let safe_name = if name.starts_with("uploaded-") {
        name.to_string()
    } else {
        format!("uploaded-{name}")
    };
    if !name_is_valid(&safe_name) {
        return Err(fail(&format!("备份文件名不合法: {safe_name}")));
    }
    let dir = backup_dir_for(db_path);
    fs::create_dir_all(&dir)?;
    let target = dir.join(&safe_name);
    if target.exists() {
        return Err(fail(&format!("同名备份已存在: {safe_name}")));
    }
    let staging = dir.join(format!(".{safe_name}.uploading"));
    fs::write(&staging, bytes)?;
    if let Err(error) = validate_database_file(&staging, DEFAULT_SUPPORTED_SCHEMA_VERSION) {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_file(&staging);
        return Err(error.into());
    }
    let metadata = fs::metadata(&target)?;
    Ok(BackupEntry {
        name: safe_name,
        size: metadata.len(),
        modified_at: mtime_ms(&metadata),
    })
}

#[derive(Debug, Clone)]
pub struct RestorePlan {
    pub backup_path: PathBuf,
    pub safety_name: String,
}

pub fn validate_restore_backup(db_path: &Path, name: &str) -> Result<PathBuf, BackupError> {
    let backup_path = resolve_backup_path(db_path, name)?;
    if !backup_path.exists() {
        return Err(fail(&format!("备份不存在: {name}")));
    }
    validate_database_file(&backup_path, DEFAULT_SUPPORTED_SCHEMA_VERSION)?;
    Ok(backup_path)
}

/// 校验备份（存在 + 内容合法），再为当前库另存安全备份。
/// 校验失败时不会创建任何新文件、不会触碰现场库。
pub fn prepare_restore(db_path: &Path, name: &str, now_ms: i64) -> Result<RestorePlan, BackupError> {
    let backup_path = validate_restore_backup(db_path, name)?;
    let safety = create_backup(db_path, now_ms)?;
    Ok(RestorePlan {
        backup_path,
        safety_name: safety.name,
    })
}

/// 默认的文件替换实现：std rename。
/// Windows 上 MoveFileEx 带 REPLACE_EXISTING，可原子覆盖已存在的目标文件。
fn default_replace(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::rename(source, target)
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()))
}

/// 用备份文件替换主库文件（调用前必须已经关闭数据库连接）。
///
/// 流程（全程可回滚，坏备份绝不触碰现场）：
/// 1. 完整校验备份；失败立即返回，现场不动。
/// 2. 备份 → staging 副本，再校验 staging（防拷贝损坏）。
/// 3. 现场 db 及 WAL/SHM 复制到安全副本 `<db>.restore-safe[-wal|-shm]`。
///    只有在安全副本就位之后才删除陈旧 WAL/SHM —— 绝不「先删边车再覆盖」。
/// 4. staging 原子 rename 到主库位置；失败则把安全副本还原回去。
/// 5. 成功后保留安全副本，由调用方在「重新初始化」成功后
///    [`finalize_swap`] 清理、失败时 [`rollback_swap`] 还原。
pub fn swap_database(db_path: &Path, backup_path: &Path) -> Result<(), BackupError> {
    swap_database_with_version(db_path, backup_path, DEFAULT_SUPPORTED_SCHEMA_VERSION)
}

/// 同 [`swap_database`]，但显式指定当前支持的 schema 版本。
pub fn swap_database_with_version(
    db_path: &Path,
    backup_path: &Path,
    supported_schema_version: i64,
) -> Result<(), BackupError> {
    swap_database_impl(db_path, backup_path, supported_schema_version, &default_replace)
}

/// 同 [`swap_database_with_version`]，但注入替换实现（测试回滚路径用）。
pub fn swap_database_with_replace(
    db_path: &Path,
    backup_path: &Path,
    supported_schema_version: i64,
    replace: &(dyn Fn(&Path, &Path) -> Result<(), std::io::Error> + Sync),
) -> Result<(), BackupError> {
    swap_database_impl(db_path, backup_path, supported_schema_version, replace)
}

fn swap_database_impl(
    db_path: &Path,
    backup_path: &Path,
    supported_schema_version: i64,
    replace: &(dyn Fn(&Path, &Path) -> Result<(), std::io::Error> + Sync),
) -> Result<(), BackupError> {
    if !backup_path.exists() {
        return Err(fail(&format!("备份不存在: {}", backup_path.display())));
    }
    // 第一步：完整验证。验证失败绝不改动现场。
    validate_database_file(backup_path, supported_schema_version)?;

    let staging = sidecar_path(db_path, ".restore-staging");
    let safety = sidecar_path(db_path, ".restore-safe");
    let live_wal = sidecar_path(db_path, "-wal");
    let live_shm = sidecar_path(db_path, "-shm");
    let sidecars: [(&Path, PathBuf); 2] = [
        (live_wal.as_path(), sidecar_path(db_path, ".restore-safe-wal")),
        (live_shm.as_path(), sidecar_path(db_path, ".restore-safe-shm")),
    ];
    // 清理上一次异常退出留下的中间文件（名字确定，不会误删用户数据）。
    let _ = fs::remove_file(&staging);
    let _ = fs::remove_file(&safety);
    for (_, safe) in sidecars.iter() {
        let _ = fs::remove_file(safe);
    }

    // 第二步：备份 → staging，并验证拷贝完整性。
    fs::copy(backup_path, &staging)?;
    if let Err(error) = validate_database_file(&staging, supported_schema_version) {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }

    // 第三步：现场安全副本（含 WAL/SHM），先复制、后删除。
    let had_live = db_path.exists();
    if had_live {
        fs::copy(db_path, &safety)?;
    }
    for (live, safe) in sidecars.iter() {
        if live.exists() {
            fs::copy(live, safe)?;
        }
    }

    // 第四步：删除陈旧边车 + 原子替换；任何一步失败都回滚。
    let commit_result = (|| -> Result<(), BackupError> {
        for (live, _) in sidecars.iter() {
            let _ = fs::remove_file(live);
        }
        replace(&staging, db_path).map_err(|error| {
            fail(&format!("替换数据库文件失败: {error}"))
        })?;
        Ok(())
    })();

    if let Err(error) = commit_result {
        // 回滚：把安全副本还原回现场（用真实 rename，不用注入实现）。
        let _ = fs::remove_file(&staging);
        let mut rollback_errors = Vec::new();
        if had_live {
            for (live, safe) in sidecars.iter() {
                if let Err(rollback_error) = fs::remove_file(live) {
                    if rollback_error.kind() != std::io::ErrorKind::NotFound {
                        rollback_errors.push(format!("清理 {} 失败: {rollback_error}", live.display()));
                        continue;
                    }
                }
                if safe.exists() {
                    if let Err(rollback_error) = fs::rename(safe, live) {
                        rollback_errors.push(format!("恢复 {} 失败: {rollback_error}", live.display()));
                    }
                }
            }
            if let Err(rollback_error) = fs::rename(&safety, db_path) {
                rollback_errors.push(format!("恢复现场数据库失败: {rollback_error}"));
            }
        } else if let Err(rollback_error) = fs::remove_file(db_path) {
            if rollback_error.kind() != std::io::ErrorKind::NotFound {
                rollback_errors.push(format!("清理新数据库失败: {rollback_error}"));
            }
        }
        if rollback_errors.is_empty() {
            return Err(error);
        }
        return Err(fail(&format!(
            "{error}；且回滚失败: {}",
            rollback_errors.join("；")
        )));
    }
    Ok(())
}

/// 换入后「重新初始化失败」的回滚：把 swap 时保留的安全副本还原回现场。
/// 返回 true 表示确实存在安全副本并已还原。
pub fn rollback_swap(db_path: &Path) -> Result<bool, BackupError> {
    let safety = sidecar_path(db_path, ".restore-safe");
    if !safety.exists() {
        return Ok(false);
    }
    let live_wal = sidecar_path(db_path, "-wal");
    let live_shm = sidecar_path(db_path, "-shm");
    let sidecars: [(&Path, PathBuf); 2] = [
        (live_wal.as_path(), sidecar_path(db_path, ".restore-safe-wal")),
        (live_shm.as_path(), sidecar_path(db_path, ".restore-safe-shm")),
    ];
    for (live, safe) in sidecars.iter() {
        let _ = fs::remove_file(live);
        if safe.exists() {
            fs::rename(safe, live)?;
        }
    }
    fs::rename(&safety, db_path)?;
    Ok(true)
}

/// 恢复后的库确认初始化成功后，清理换入时保留的安全副本。
pub fn finalize_swap(db_path: &Path) -> Result<(), BackupError> {
    let _ = fs::remove_file(sidecar_path(db_path, ".restore-safe"));
    let _ = fs::remove_file(sidecar_path(db_path, ".restore-safe-wal"));
    let _ = fs::remove_file(sidecar_path(db_path, ".restore-safe-shm"));
    Ok(())
}

/// 当前毫秒（给没有时钟上下文的调用方）。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
