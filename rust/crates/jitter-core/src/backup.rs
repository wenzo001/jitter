//! 数据库备份 / 导出 / 导入 / 恢复。
//!
//! 与 TypeScript 版 `src/backup.ts` 行为对齐：备份用 `VACUUM INTO`（活库上
//! 做完整快照，正确合并 WAL，不停服务）；恢复前自动另存当前状态的安全备份。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// 把上传的字节保存为一份备份（文件名固定加 uploaded- 前缀）。
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
    // 合法性预检：SQLite 文件以 "SQLite format 3\0" 开头。
    if !bytes.starts_with(b"SQLite format 3") {
        return Err(fail("文件不是 SQLite 数据库备份"));
    }
    fs::write(&target, bytes)?;
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

/// 校验备份存在，返回当前库的安全备份名与备份路径。
pub fn prepare_restore(db_path: &Path, name: &str, now_ms: i64) -> Result<RestorePlan, BackupError> {
    let backup_path = resolve_backup_path(db_path, name)?;
    if !backup_path.exists() {
        return Err(fail(&format!("备份不存在: {name}")));
    }
    let safety = create_backup(db_path, now_ms)?;
    Ok(RestorePlan {
        backup_path,
        safety_name: safety.name,
    })
}

/// 用备份文件替换主库文件（调用前必须已经关闭数据库连接）。
pub fn swap_database(db_path: &Path, backup_path: &Path) -> Result<(), BackupError> {
    if !backup_path.exists() {
        return Err(fail(&format!("备份不存在: {}", backup_path.display())));
    }
    let db_string = db_path.to_string_lossy().to_string();
    let _ = fs::remove_file(format!("{db_string}-wal"));
    let _ = fs::remove_file(format!("{db_string}-shm"));
    fs::copy(backup_path, db_path)?;
    Ok(())
}

/// 当前毫秒（给没有时钟上下文的调用方）。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
