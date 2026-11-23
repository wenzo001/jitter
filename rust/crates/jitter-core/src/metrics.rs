//! 运行统计：每任务最近 N 次成功率与全局概览。

use chrono::{DateTime, Local};
use serde::Serialize;

use crate::db::{count_runs_since, list_recent_task_logs, list_tasks};

/// 每个任务的成功率基于最近多少次执行。
pub const METRICS_WINDOW: i64 = 20;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct TaskMetrics {
    pub task_id: String,
    pub runs: i64,
    pub ok: i64,
    pub success_rate: Option<f64>,
    pub avg_duration_ms: Option<i64>,
    pub last_executed_at: Option<i64>,
    pub last_status: Option<i64>,
    pub last_error: Option<String>,
    pub last_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsOverview {
    pub tasks: i64,
    pub active: i64,
    pub running: i64,
    pub today_runs: i64,
    pub today_ok: i64,
    pub week_runs: i64,
    pub week_ok: i64,
    pub success_rate_7d: Option<f64>,
    pub avg_duration_ms_7d: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsReport {
    pub overview: MetricsOverview,
    pub tasks: Vec<TaskMetrics>,
    pub window: i64,
}

fn start_of_local_day(now: i64) -> i64 {
    let datetime = DateTime::from_timestamp_millis(now)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch"))
        .with_timezone(&Local);
    datetime
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or(now)
}

fn rate(ok: i64, runs: i64) -> Option<f64> {
    if runs <= 0 {
        return None;
    }
    Some(((ok as f64 / runs as f64) * 1000.0).round() / 1000.0)
}

/// 每个任务最近几次执行的健康度（每任务一次有界索引扫描）。
pub fn get_task_metrics(window: i64) -> Result<Vec<TaskMetrics>, crate::db::DbError> {
    let limit = window.clamp(1, 200);
    let mut metrics = Vec::new();
    for task in list_tasks()? {
        let rows = list_recent_task_logs(&task.id, limit)?;
        let mut ok = 0i64;
        let mut duration_total = 0i64;
        let mut duration_count = 0i64;
        for row in &rows {
            let success = row.error.is_none()
                && row.response_status.map(|status| (200..300).contains(&status)).unwrap_or(false);
            if success {
                ok += 1;
            }
            if let Some(duration) = row.duration_ms {
                duration_total += duration;
                duration_count += 1;
            }
        }
        let last = rows.first();
        metrics.push(TaskMetrics {
            task_id: task.id.clone(),
            runs: rows.len() as i64,
            ok,
            success_rate: rate(ok, rows.len() as i64),
            avg_duration_ms: if duration_count > 0 {
                Some(duration_total / duration_count)
            } else {
                None
            },
            last_executed_at: last.map(|row| row.executed_at),
            last_status: last.and_then(|row| row.response_status),
            last_error: last.and_then(|row| row.error.clone()),
            last_kind: last.map(|row| row.kind.clone()),
        });
    }
    Ok(metrics)
}

/// 顶栏的头条数字：今天跑了多少、近一周成功率、当前在途数量。
pub fn get_overview(now: i64, running: i64) -> Result<MetricsOverview, crate::db::DbError> {
    let tasks = list_tasks()?;
    let today = count_runs_since(start_of_local_day(now))?;
    let week = count_runs_since(now - 7 * DAY_MS)?;
    Ok(MetricsOverview {
        tasks: tasks.len() as i64,
        active: tasks.iter().filter(|task| task.status == "active").count() as i64,
        running,
        today_runs: today.runs,
        today_ok: today.ok,
        week_runs: week.runs,
        week_ok: week.ok,
        success_rate_7d: rate(week.ok, week.runs),
        avg_duration_ms_7d: week.avg_duration_ms.map(|value| value.round() as i64),
    })
}

pub fn get_metrics_report(now: i64, running: i64, window: i64) -> Result<MetricsReport, crate::db::DbError> {
    Ok(MetricsReport {
        overview: get_overview(now, running)?,
        tasks: get_task_metrics(window)?,
        window: window.clamp(1, 200),
    })
}
