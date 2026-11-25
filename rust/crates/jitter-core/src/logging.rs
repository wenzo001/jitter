//! 运行日志：按天轮转落盘、按保留期清理、给界面用的文件浏览。
//!
//! 发布版没有控制台（Windows GUI 子系统），所以日志必须写文件，
//! 否则用户遇到问题后什么线索都留不下。
//!
//! 文件名格式：`jitter-<YYYY-MM-DD>.log`，放在数据库同级的 `logs/` 目录。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{Datelike, Local, TimeZone};
use serde::Serialize;

/// 默认保留天数（可用环境变量 `JITTER_LOG_DAYS` 覆盖）。
pub const DEFAULT_RETENTION_DAYS: usize = 14;
/// 日志文件名前缀。
pub const LOG_PREFIX: &str = "jitter-";
/// 日志文件后缀。
pub const LOG_SUFFIX: &str = ".log";

/// 日志目录：与数据库同级的 `logs/`。
pub fn log_dir(db_path: &str) -> PathBuf {
    let db = Path::new(db_path);
    match db.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join("logs"),
        _ => PathBuf::from("logs"),
    }
}

/// 当天日期串 `YYYY-MM-DD`（本地时区）。
pub fn today_stamp(now_ms: i64) -> String {
    let datetime = Local.timestamp_millis_opt(now_ms).single();
    match datetime {
        Some(value) => format!(
            "{:04}-{:02}-{:02}",
            value.year(),
            value.month(),
            value.day()
        ),
        None => Local::now().format("%Y-%m-%d").to_string(),
    }
}

/// 日志文件名（不含目录）。
pub fn file_name_for(stamp: &str) -> String {
    format!("{LOG_PREFIX}{stamp}{LOG_SUFFIX}")
}

/// 文件名是否合法（只允许 `jitter-YYYY-MM-DD.log`，防目录穿越）。
pub fn is_valid_file_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(LOG_PREFIX) else {
        return false;
    };
    let Some(stamp) = rest.strip_suffix(LOG_SUFFIX) else {
        return false;
    };
    let parts: Vec<&str> = stamp.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
}

/// 保留天数：环境变量优先，其次默认。
pub fn retention_days_from_env() -> usize {
    std::env::var("JITTER_LOG_DAYS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|days| *days > 0 && *days <= 365)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// 一个日志文件的元信息（给界面用）。
#[derive(Debug, Clone, Serialize)]
pub struct LogFileInfo {
    pub name: String,
    pub size: u64,
    pub modified_at: i64,
}

/// 日志文件的一段内容。
#[derive(Debug, Clone, Serialize)]
pub struct LogFileChunk {
    pub name: String,
    pub content: String,
    /// 本次读取的起始字节偏移。
    pub offset: usize,
    /// 下一次读取的偏移（等于文件末尾时与 offset 相同）。
    pub next_offset: usize,
    /// 文件总字节数。
    pub size: u64,
}

/// 日志目录下的文件列表（新的在前）。
pub fn list_files(dir: &Path) -> Vec<LogFileInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<LogFileInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_valid_file_name(&name) {
                return None;
            }
            let meta = fs::metadata(entry.path()).ok()?;
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0);
            Some(LogFileInfo {
                name,
                size: meta.len(),
                modified_at,
            })
        })
        .collect();
    files.sort_by(|a, b| b.name.cmp(&a.name));
    files
}

/// 读取日志文件的一段内容（按字节偏移，支持大文件分页）。
pub fn read_file(
    dir: &Path,
    name: &str,
    offset: usize,
    limit: usize,
) -> Result<LogFileChunk, String> {
    if !is_valid_file_name(name) {
        return Err(format!("日志文件名不合法：{name}"));
    }
    let path = dir.join(name);
    let meta = std::fs::metadata(&path).map_err(|error| format!("读取日志失败：{error}"))?;
    let size = meta.len();
    let limit = limit.clamp(1, 512 * 1024);
    let mut file = File::open(&path).map_err(|error| format!("打开日志失败：{error}"))?;
    if (offset as u64) >= size {
        return Ok(LogFileChunk {
            name: name.to_string(),
            content: String::new(),
            offset,
            next_offset: offset,
            size,
        });
    }
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset as u64))
        .map_err(|error| format!("定位日志失败：{error}"))?;
    let mut buffer = vec![0u8; limit.min((size - offset as u64) as usize)];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("读取日志失败：{error}"))?;
    buffer.truncate(read);
    // 末尾可能是被切断的 UTF-8 字符（中文一行会被 64KB 的分页切在中间）。
    // 这几个字节留给下一段读，否则界面会显示成乱码（U+FFFD）。
    let valid = utf8_complete_prefix(&buffer);
    Ok(LogFileChunk {
        name: name.to_string(),
        content: String::from_utf8_lossy(&buffer[..valid]).to_string(),
        offset,
        next_offset: offset + valid,
        size,
    })
}

/// 返回缓冲区里「完整字符」的前缀长度。
///
/// 末尾若是没读完的字符，返回的位置会落在那个字符的起始字节之前，
/// 调用方把这部分留给下一段即可。
fn utf8_complete_prefix(buffer: &[u8]) -> usize {
    let len = buffer.len();
    if len == 0 {
        return 0;
    }
    // ASCII 结尾一定完整。
    if buffer[len - 1] & 0x80 == 0 {
        return len;
    }
    // 末尾不是 ASCII：从后往前找最后一个字符的 lead 字节。
    let mut start = len - 1;
    while start > 0 && buffer[start] & 0xC0 == 0x80 {
        start -= 1;
    }
    let expected = match buffer[start] {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        // 非法字节：交给 from_utf8_lossy 处理。
        _ => return len,
    };
    if len - start == expected {
        len
    } else {
        // 字符被切断：整段留给下一段。
        start
    }
}

/// 清理超过保留期的日志文件（尽力而为，失败忽略）。
pub fn prune_old_files(dir: &Path, retention_days: usize, now_ms: i64) {
    let Some(today) = Local.timestamp_millis_opt(now_ms).single() else {
        return;
    };
    let cutoff = today.date_naive() - chrono::Days::new(retention_days as u64);
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_valid_file_name(&name) {
            continue;
        }
        let stamp = name
            .trim_start_matches(LOG_PREFIX)
            .trim_end_matches(LOG_SUFFIX);
        let Ok(date) = chrono::NaiveDate::parse_from_str(stamp, "%Y-%m-%d") else {
            continue;
        };
        if date < cutoff {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 追加一行日志（不依赖 tracing，初始化前也能写）。
pub fn append_line(dir: &Path, line: &str) {
    let stamp = today_stamp(now_ms());
    let path = dir.join(file_name_for(&stamp));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// tracing 用的按天轮转写入器
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct DailyState {
    dir: PathBuf,
    date: String,
    file: Option<File>,
    retention_days: usize,
}

/// 按天轮转的文件写入器：同一天追加，跨天新建文件并清理过期文件。
#[derive(Clone)]
pub struct DailyLogWriter {
    state: Arc<Mutex<DailyState>>,
}

impl DailyLogWriter {
    pub fn new(dir: PathBuf, retention_days: usize) -> Self {
        DailyLogWriter {
            state: Arc::new(Mutex::new(DailyState {
                dir,
                date: String::new(),
                file: None,
                retention_days,
            })),
        }
    }

    fn rotate(state: &mut DailyState, date: &str) -> std::io::Result<()> {
        state.file = None;
        let _ = fs::create_dir_all(&state.dir);
        let path = state.dir.join(file_name_for(date));
        // append(true) 只给 FILE_APPEND_DATA 权限，Windows 上目录项里的
        // 文件大小要等句柄关闭才更新，界面会读到 0 字节；
        // 同时给 write(true)，大小才会实时更新。
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(true)
            .open(&path)?;
        state.file = Some(file);
        state.date = date.to_string();
        prune_old_files(&state.dir, state.retention_days, now_ms());
        Ok(())
    }
}

impl Write for DailyLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let date = today_stamp(now_ms());
        if state.file.is_none() || state.date != date {
            DailyLogWriter::rotate(&mut state, &date)?;
        }
        if let Some(file) = state.file.as_mut() {
            file.write_all(buf)?;
            file.flush()?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(file) = state.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for DailyLogWriter {
    type Writer = DailyLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_prefix_keeps_only_complete_characters() {
        // 完整的中文字符：整段保留。
        let full = "第一行".as_bytes();
        assert_eq!(utf8_complete_prefix(full), full.len());

        // 被切断的三字节字符（只剩前两个字节）：整段留给下一段。
        let cut = &"第一行".as_bytes()[..5];
        assert_eq!(utf8_complete_prefix(cut), 3);

        // 只剩一个 lead 字节：也留给下一段。
        let one = &"第".as_bytes()[..1];
        assert_eq!(utf8_complete_prefix(one), 0);

        // 纯 ASCII 不受影响。
        assert_eq!(utf8_complete_prefix(b"hello"), 5);
    }

    #[test]
    fn rejects_unsafe_file_names() {
        assert!(is_valid_file_name("jitter-2026-11-25.log"));
        assert!(!is_valid_file_name("../secret.log"));
        assert!(!is_valid_file_name("jitter-2026-11-25.log.bak"));
        assert!(!is_valid_file_name("notes.txt"));
        assert!(!is_valid_file_name("jitter-2026-1-1.log"));
    }

    #[test]
    fn writes_and_reads_back_a_log_file() {
        let dir = std::env::temp_dir().join(format!("jitter-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");

        let writer = DailyLogWriter::new(dir.clone(), 7);
        let mut handle = writer.clone();
        handle.write_all("第一行\n".as_bytes()).expect("write");
        handle.write_all(b"second line\n").expect("write");

        let files = list_files(&dir);
        assert_eq!(files.len(), 1);
        assert!(files[0].name.starts_with(LOG_PREFIX));
        assert!(files[0].size > 0);

        let name = files[0].name.clone();
        let chunk = read_file(&dir, &name, 0, 1024).expect("read");
        assert!(chunk.content.contains("第一行"));
        assert!(chunk.content.contains("second line"));
        assert_eq!(chunk.next_offset as u64, chunk.size);

        // 越界的偏移返回空内容而不是报错。
        let beyond = read_file(&dir, &name, chunk.size as usize + 10, 1024).expect("read");
        assert!(beyond.content.is_empty());

        // 非法文件名直接拒绝。
        assert!(read_file(&dir, "../app.db", 0, 10).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prunes_files_older_than_retention() {
        let dir = std::env::temp_dir().join(format!("jitter-log-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let old = dir.join(file_name_for("2020-01-01"));
        let recent = dir.join(file_name_for("2999-01-01"));
        fs::write(&old, b"old").expect("write");
        fs::write(&recent, b"recent").expect("write");

        prune_old_files(&dir, 7, now_ms());
        assert!(!old.exists(), "过期日志应被删除");
        assert!(recent.exists(), "未过期日志应保留");
        let _ = fs::remove_dir_all(&dir);
    }
}
