//! `jitter probe`：只读查看任意 Jitter 数据库与运行日志。
//!
//! # 为什么要有它
//!
//! 排查线上问题时需要看生产实例的数据，但绝不能改它。这个子命令：
//!
//! - **只读**打开数据库（`SQLITE_OPEN_READ_ONLY`），写操作在连接层就被拒绝；
//! - 不起 HTTP 服务、不占端口、不抢单实例互斥体、不初始化自己的数据库；
//! - **不写业务数据，也不修改 db / wal 内容**；WAL 模式下 SQLite 可能更新 `-shm` 读标记；
//! - 顺带能看生产实例的运行日志目录。
//!
//! # 用法
//!
//! ```text
//! jitter.exe probe --db <数据库路径> [--logs <运行日志目录>] [--limit <条数>]
//! ```
//!
//! 例：
//!
//! ```powershell
//! jitter.exe probe --db "D:\下载\Compressed\data\app.db" --logs "D:\下载\Compressed\data\logs"
//! ```

use std::fmt;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use jitter_core::probe;

/// 探针的输出（纯文本，便于在终端里直接看）。
pub fn run(args: &[String]) -> i32 {
    let options = match parse_args(args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("参数错误：{message}");
            eprintln!("用法：jitter probe --db <数据库路径> [--logs <运行日志目录>] [--limit <条数>]");
            return 2;
        }
    };

    let db_path = PathBuf::from(&options.db_path);
    let conn = match probe::open_readonly(&db_path) {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };

    let report = match probe::collect_report(&conn, &db_path, options.limit) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("读取失败：{error}");
            return 1;
        }
    };

    print_report(&report, options.logs_dir.as_deref());
    0
}

struct Options {
    db_path: String,
    logs_dir: Option<String>,
    limit: i64,
}

/// 解析命令行参数。
fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut db_path: Option<String> = None;
    let mut logs_dir: Option<String> = None;
    let mut limit: i64 = 20;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--db" => {
                db_path = Some(next_value(args, &mut index, "--db")?);
            }
            "--logs" => {
                logs_dir = Some(next_value(args, &mut index, "--logs")?);
            }
            "--limit" => {
                let raw = next_value(args, &mut index, "--limit")?;
                limit = raw
                    .parse::<i64>()
                    .map_err(|_| format!("--limit 必须是数字：{raw}"))?
                    .clamp(1, 500);
            }
            "--help" | "-h" => {
                return Err("用法：jitter probe --db <数据库路径> [--logs <运行日志目录>] [--limit <条数>]".into());
            }
            other => return Err(format!("未知参数：{other}")),
        }
        index += 1;
    }

    Ok(Options {
        db_path: db_path.ok_or("缺少 --db <数据库路径>")?,
        logs_dir,
        limit,
    })
}

/// 取 `--flag` 后面跟的值，并前进游标。
fn next_value(args: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("{flag} 后面缺少值"))
}

/// 往 stdout 写一行；写失败就忽略。
///
/// 这里刻意不用 `println!`：它在 stdout 写失败时会 panic，
/// 而排障时经常把输出接管道只看前几行（`| head`、`Select-Object -First`），
/// 管道一关就panic，等于把真正要看的输出换成了一屏 panic 栈。
struct Out {
    writer: BufWriter<io::Stdout>,
}

impl Out {
    fn new() -> Self {
        Self {
            writer: BufWriter::new(io::stdout()),
        }
    }

    fn line(&mut self, args: fmt::Arguments<'_>) {
        let _ = self.writer.write_fmt(args);
        let _ = self.writer.write_all(b"\n");
    }

    fn blank(&mut self) {
        let _ = self.writer.write_all(b"\n");
    }

    fn finish(&mut self) {
        let _ = self.writer.flush();
    }
}

/// 打印报告。
fn print_report(report: &probe::ProbeReport, logs_dir: Option<&str>) {
    let mut out = Out::new();

    out.line(format_args!("数据库：{}", report.db_path));
    out.line(format_args!(
        "任务 {} 个 · 执行记录 {} 条 · 其中出错 {} 条",
        report.task_count, report.log_count, report.error_count
    ));

    if !report.settings.is_empty() {
        out.blank();
        out.line(format_args!("全局设置："));
        for (key, value) in &report.settings {
            out.line(format_args!("  {key} = {value}"));
        }
    }

    if !report.tasks.is_empty() {
        out.blank();
        out.line(format_args!("任务："));
        for task in &report.tasks {
            let retention = match task.log_retention_days {
                Some(0) => "永久保留".to_string(),
                Some(days) => format!("保留 {days} 天"),
                None => "跟随全局".to_string(),
            };
            let last = match task.last_executed_at {
                Some(at) => probe::format_time(at),
                None => "从未执行".to_string(),
            };
            out.line(format_args!(
                "  [{}] {} · {} · {} · 日志 {} 条 · {retention} · 最近 {last}",
                task.status, task.name, task.schedule, task.request_method, task.log_count
            ));
            out.line(format_args!(
                "      {} {}",
                task.request_method, task.request_url
            ));
            if let Some(error) = &task.last_error {
                out.line(format_args!("      最近错误：{error}"));
            }
        }
    }

    if !report.recent_logs.is_empty() {
        out.blank();
        out.line(format_args!("最近执行记录："));
        for log in &report.recent_logs {
            let status = match log.response_status {
                Some(code) => format!("HTTP {code}"),
                None => "无响应".to_string(),
            };
            let duration = match log.duration_ms {
                Some(ms) => format!("{ms} ms"),
                None => "-".to_string(),
            };
            out.line(format_args!(
                "  {} · {} · {} · {} · {}",
                probe::format_time(log.executed_at),
                log.task_name,
                status,
                duration,
                log.kind
            ));
            if let Some(error) = &log.error {
                out.line(format_args!("      {error}"));
            }
        }
    }

    if let Some(dir) = logs_dir {
        print_logs(dir, &mut out);
    }

    out.blank();
    out.line(format_args!(
        "（本次读取全程只读：没有写入数据库，也没有修改 app.db / app.db-wal；WAL 模式可能更新 -shm 读标记。）"
    ));
    out.finish();
}

/// 打印运行日志目录：文件列表 + 最近文件的尾部。
fn print_logs(dir: &str, out: &mut Out) {
    let path = Path::new(dir);
    let files = jitter_core::logging::list_files(path);
    out.blank();
    out.line(format_args!("运行日志目录：{dir}"));
    if files.is_empty() {
        out.line(format_args!("  （没有日志文件）"));
        return;
    }
    for file in files.iter().take(10) {
        out.line(format_args!(
            "  {} · {} B · {}",
            file.name,
            file.size,
            probe::format_time(file.modified_at)
        ));
    }
    // 只看最新那个文件的尾部——排障通常看最近的就行。
    if let Some(newest) = files.first() {
        let content = std::fs::read_to_string(path.join(&newest.name)).unwrap_or_default();
        let lines: Vec<&str> = content.lines().collect();
        let tail = lines.len().saturating_sub(40);
        out.blank();
        out.line(format_args!(
            "  —— {} 的最后 {} 行 ——",
            newest.name,
            lines.len() - tail
        ));
        for line in &lines[tail..] {
            out.line(format_args!("  {line}"));
        }
    }
}
