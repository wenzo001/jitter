//! 调度模型：定时执行（每天窗口 / 精确时间 ± 抖动）与循环执行（固定间隔）。
//!
//! 与 TypeScript 版（`src/schedule.ts`）行为一致。两种方式存在同一张任务表上，
//! `schedule_kind` 默认 `daily`，旧库不需要改表。
//! 不支持 Cron 表达式：「每天一次」和「每隔 N 时间」已经覆盖实际用法。
//! 暂停对所有方式都按**整自然日**判断。

use serde_json::{Map, Value as Json};

use crate::window::{
    next_window_start_after, parse_window, plan_after_run_with_pause, plan_paused, plan_recovery,
    plan_with_pause, start_of_local_day, window_instance_at, PauseInterval, RecoveryReason,
    WindowError, WindowSpec,
};

pub const SCHEDULE_KIND_DAILY: &str = "daily";
pub const SCHEDULE_KIND_INTERVAL: &str = "interval";

pub const INTERVAL_MIN_SECONDS: i64 = 1;
/// 30 天；更长的周期更适合用每天窗口表达。
pub const INTERVAL_MAX_SECONDS: i64 = 30 * 24 * 60 * 60;
/// 精确时间允许的最大 ± 抖动。
pub const MAX_DAILY_JITTER_MINUTES: i64 = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleError(pub String);

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ScheduleError {}

impl From<WindowError> for ScheduleError {
    fn from(error: WindowError) -> Self {
        ScheduleError(error.0)
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, ScheduleError> {
    Err(ScheduleError(message.into()))
}

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub enum ScheduleKind {
    Daily,
    Interval,
}

impl ScheduleKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScheduleKind::Daily => SCHEDULE_KIND_DAILY,
            ScheduleKind::Interval => SCHEDULE_KIND_INTERVAL,
        }
    }
}

/// 调度配置。
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleSpec {
    pub kind: ScheduleKind,
    /// 有效窗口。精确时间的任务这是 `[T-N, T+N]`（抖动 0 → 长度为零的瞬时窗口）。
    pub window: Option<WindowSpec>,
    /// 每天模式为「精确时间」时的 `HH:mm`；时间范围时为 `None`。
    pub exact_time: Option<String>,
    /// 围绕 `exact_time` 的 ± 分钟抖动；0 表示准点执行。
    pub jitter_minutes: i64,
    /// 仅 `interval` 使用。
    pub interval_seconds: Option<i64>,
    pub interval_jitter_seconds: i64,
    /// 循环执行可选的首跑锚点：周期对齐到这个时刻。
    /// `None` 表示「从创建时开始数」。
    pub start_at: Option<i64>,
}

/// 从 JSON 里取一个整数字段（接受数字或数字字符串），与 TS 版语义一致。
pub fn to_integer(value: Option<&Json>, label: &str) -> Result<Option<i64>, ScheduleError> {
    let value = match value {
        None | Some(Json::Null) => return Ok(None),
        Some(value) => value,
    };
    if let Json::String(text) = value {
        if text.trim().is_empty() {
            return Ok(None);
        }
    }
    let parsed = match value {
        Json::Number(number) => number.as_f64(),
        Json::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match parsed {
        Some(number) if number.is_finite() && number.fract() == 0.0 => Ok(Some(number as i64)),
        _ => err(format!("{label}必须是整数")),
    }
}

pub fn normalize_schedule_kind(value: Option<&Json>) -> Result<ScheduleKind, ScheduleError> {
    match value {
        None | Some(Json::Null) => Ok(ScheduleKind::Daily),
        Some(Json::String(text)) => match text.as_str() {
            "" => Ok(ScheduleKind::Daily),
            "daily" => Ok(ScheduleKind::Daily),
            "interval" => Ok(ScheduleKind::Interval),
            _ => err("调度方式必须是 daily（定时执行）或 interval（循环执行）"),
        },
        _ => err("调度方式必须是 daily（定时执行）或 interval（循环执行）"),
    }
}

fn minutes_to_hhmm(minutes: i64) -> String {
    let clamped = minutes.clamp(0, 23 * 60 + 59);
    format!("{:02}:{:02}", clamped / 60, clamped % 60)
}

/// 精确时间任务的有效窗口：`[T-N, T+N]`，截断在同一天内，
/// 这样执行永远不会漏到相邻的日子（那会改变暂停归属）。`N = 0` 得到瞬时窗口。
fn exact_time_window(time: &str, jitter_minutes: i64) -> Result<WindowSpec, ScheduleError> {
    if jitter_minutes <= 0 {
        return Ok(parse_window(time, time)?);
    }
    let parts: Vec<&str> = time.split(':').collect();
    let hours: i64 = parts.first().and_then(|part| part.parse().ok()).unwrap_or(0);
    let minutes: i64 = parts.get(1).and_then(|part| part.parse().ok()).unwrap_or(0);
    let center = hours * 60 + minutes;
    Ok(parse_window(
        &minutes_to_hhmm(center - jitter_minutes),
        &minutes_to_hhmm(center + jitter_minutes),
    )?)
}

/// 校验任务载荷里的调度部分。三种每天形态共用同一对时间字段：
///
/// - 时间范围：`start < end`（`end < start` 表示跨午夜）；
/// - 精确时间：`start === end`；
/// - 精确时间 + 抖动：`start === end` 加 `daily_jitter_minutes`。
pub fn build_schedule(fields: &Map<String, Json>) -> Result<ScheduleSpec, ScheduleError> {
    let kind = normalize_schedule_kind(fields.get("schedule_kind"))?;

    if kind == ScheduleKind::Daily {
        let start = fields
            .get("window_start")
            .and_then(|value| value.as_str())
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        let end = fields
            .get("window_end")
            .and_then(|value| value.as_str())
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        let jitter = to_integer(fields.get("daily_jitter_minutes"), "抖动分钟")?.unwrap_or(0);
        if jitter < 0 {
            return err("抖动分钟不能是负数");
        }
        if jitter > MAX_DAILY_JITTER_MINUTES {
            return err(format!("抖动最多 {MAX_DAILY_JITTER_MINUTES} 分钟"));
        }
        let exact = !start.is_empty() && start == end;
        if jitter > 0 && !exact {
            return err("只有「精确时间」才能设置抖动，请把开始和结束设为同一个时刻");
        }
        let window = if exact {
            exact_time_window(&start, jitter)?
        } else {
            parse_window(&start, &end)?
        };
        return Ok(ScheduleSpec {
            kind,
            window: Some(window),
            exact_time: if exact { Some(start) } else { None },
            jitter_minutes: jitter,
            interval_seconds: None,
            interval_jitter_seconds: 0,
            start_at: None,
        });
    }

    let seconds = to_integer(fields.get("interval_seconds"), "执行间隔")?;
    let seconds = match seconds {
        Some(seconds) => seconds,
        None => return err("请填写执行间隔"),
    };
    if seconds < INTERVAL_MIN_SECONDS || seconds > INTERVAL_MAX_SECONDS {
        return err(format!(
            "执行间隔必须在 {} 秒到 {} 天之间",
            INTERVAL_MIN_SECONDS,
            INTERVAL_MAX_SECONDS / 86400
        ));
    }
    let jitter = to_integer(fields.get("interval_jitter_seconds"), "随机抖动")?.unwrap_or(0);
    if jitter < 0 {
        return err("随机抖动不能是负数");
    }
    if jitter > seconds {
        return err("随机抖动不能大于执行间隔");
    }

    let start_at = to_integer(fields.get("interval_start_at"), "首次执行时间")?;
    if let Some(start_at) = start_at {
        if start_at <= 0 {
            return err("首次执行时间必须是有效的日期时间");
        }
    }
    Ok(ScheduleSpec {
        kind,
        window: None,
        exact_time: None,
        jitter_minutes: 0,
        interval_seconds: Some(seconds),
        interval_jitter_seconds: jitter,
        start_at,
    })
}

/// 存储行 → 调度配置。
#[derive(Debug, Clone, Default)]
pub struct StoredSchedule {
    pub schedule_kind: Option<String>,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
    pub daily_jitter_minutes: Option<i64>,
    pub interval_seconds: Option<i64>,
    pub interval_jitter_seconds: Option<i64>,
    pub interval_start_at: Option<i64>,
}

/// 从存储的任务行重建调度配置。
///
/// 读存储行时刻意宽松：手改的坏锚点降级为「从现在开始数」，
/// 而不是让整个任务没法调度。
pub fn schedule_of(task: &StoredSchedule) -> Result<ScheduleSpec, ScheduleError> {
    let start_at = task
        .interval_start_at
        .filter(|value| *value > 0);
    let jitter = task
        .daily_jitter_minutes
        .filter(|value| *value >= 0)
        .map(|value| value.min(MAX_DAILY_JITTER_MINUTES))
        .unwrap_or(0);

    let mut fields = Map::new();
    fields.insert(
        "schedule_kind".to_string(),
        Json::String(task.schedule_kind.clone().unwrap_or_else(|| "daily".to_string())),
    );
    fields.insert(
        "window_start".to_string(),
        Json::String(task.window_start.clone().unwrap_or_default()),
    );
    fields.insert(
        "window_end".to_string(),
        Json::String(task.window_end.clone().unwrap_or_default()),
    );
    fields.insert("daily_jitter_minutes".to_string(), Json::from(jitter));
    if let Some(seconds) = task.interval_seconds {
        fields.insert("interval_seconds".to_string(), Json::from(seconds));
    }
    fields.insert(
        "interval_jitter_seconds".to_string(),
        Json::from(task.interval_jitter_seconds.unwrap_or(0)),
    );
    if let Some(start_at) = start_at {
        fields.insert("interval_start_at".to_string(), Json::from(start_at));
    }
    build_schedule(&fields)
}

pub fn format_seconds(seconds: i64) -> String {
    if seconds % 86400 == 0 {
        return format!("{} 天", seconds / 86400);
    }
    if seconds % 3600 == 0 {
        return format!("{} 小时", seconds / 3600);
    }
    if seconds % 60 == 0 {
        return format!("{} 分钟", seconds / 60);
    }
    format!("{seconds} 秒")
}

pub fn describe_schedule(spec: &ScheduleSpec) -> String {
    if spec.kind == ScheduleKind::Daily {
        if let Some(exact) = &spec.exact_time {
            return if spec.jitter_minutes > 0 {
                format!("每天 {exact}（±{} 分钟内随机）", spec.jitter_minutes)
            } else {
                format!("每天 {exact}")
            };
        }
        let window = match &spec.window {
            Some(window) => window,
            None => return "定时执行".to_string(),
        };
        let across = if window.cross_midnight { "（跨午夜）" } else { "" };
        return format!("每天 {}–{}{} 随机一次", window.start, window.end, across);
    }
    let base = format!("每 {}", format_seconds(spec.interval_seconds.unwrap_or(0)));
    let anchor = match spec.start_at {
        Some(start_at) => format!("（从 {} 起算）", format_anchor(start_at)),
        None => String::new(),
    };
    let jitter = if spec.interval_jitter_seconds > 0 {
        format!("，另加随机 0–{} 秒抖动", spec.interval_jitter_seconds)
    } else {
        String::new()
    };
    format!("{base}{anchor}{jitter}")
}

/// 两个配置是否会以不同方式调度（用于保留未触发的计划）。
pub fn same_schedule(a: &ScheduleSpec, b: &ScheduleSpec) -> bool {
    if a.kind != b.kind {
        return false;
    }
    if a.kind == ScheduleKind::Daily {
        let a_window = a.window.as_ref();
        let b_window = b.window.as_ref();
        return a_window.zip(b_window).map_or(false, |(a, b)| {
            a.start == b.start && a.end == b.end
        }) && a.jitter_minutes == b.jitter_minutes;
    }
    a.interval_seconds == b.interval_seconds
        && a.interval_jitter_seconds == b.interval_jitter_seconds
        // 锚点决定网格：移动锚点必须重新规划，否则新的“从 09:00 开始”
        // 要等旧计划触发一次之后才生效。
        && a.start_at == b.start_at
}

fn pad2(value: u32) -> String {
    format!("{value:02}")
}

/// 锚点的本地时间标签；不是今年才带年份。
fn format_anchor(timestamp: i64) -> String {
    use chrono::{Datelike, Local, Timelike};
    let datetime = chrono::DateTime::from_timestamp_millis(timestamp)
        .map(|value| value.with_timezone(&Local))
        .unwrap_or_else(|| Local::now());
    let year = if datetime.year() == Local::now().year() {
        String::new()
    } else {
        format!("{}-", datetime.year())
    };
    format!(
        "{year}{}-{} {}:{}",
        pad2(datetime.month()),
        pad2(datetime.day()),
        pad2(datetime.hour()),
        pad2(datetime.minute())
    )
}

/// `anchor + k × interval` 里严格大于 `from` 的最小值（k ≥ 0）。
///
/// 让「从 09:00 开始，每 2 小时」保持 09:00 / 11:00 / 13:00，
/// 即使任务中途被创建、重启或暂停过。
fn next_tick_after(from: i64, anchor: i64, interval: i64) -> i64 {
    if from < anchor {
        return anchor;
    }
    let steps = (from - anchor).div_euclid(interval) + 1;
    anchor + steps * interval
}

fn pause_covers(timestamp: i64, pause: Option<PauseInterval>) -> bool {
    let pause = match pause {
        Some(pause) if pause.until > pause.from => pause,
        _ => return false,
    };
    let day = start_of_local_day(timestamp, 0);
    day >= pause.from && day < pause.until
}

fn jitter_milliseconds(spec: &ScheduleSpec, rng: &mut dyn FnMut() -> f64) -> i64 {
    if spec.interval_jitter_seconds <= 0 {
        return 0;
    }
    (rng() * (spec.interval_jitter_seconds * 1000 + 1) as f64).floor() as i64
}

/// 循环调度里严格大于 `from` 的下一次触发。
fn next_occurrence(from: i64, spec: &ScheduleSpec, rng: &mut dyn FnMut() -> f64) -> i64 {
    let interval = (spec.interval_seconds.unwrap_or(1)) * 1000;
    let base = match spec.start_at {
        Some(anchor) => next_tick_after(from, anchor, interval),
        None => from + interval,
    };
    base + jitter_milliseconds(spec, rng)
}

/// 跳过被暂停的整日，不逐次枚举。
fn skip_paused_days(
    from: i64,
    spec: &ScheduleSpec,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> i64 {
    let mut candidate = next_occurrence(from, spec, rng);
    if let Some(pause) = pause {
        for _ in 0..8 {
            if !pause_covers(candidate, Some(pause)) {
                break;
            }
            let resume_from = from.max(pause.until - 1);
            candidate = next_occurrence(resume_from, spec, rng);
        }
    }
    candidate
}

/// 一次规划的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanResult {
    pub target: i64,
    /// 被跳过且没有执行的旧计划（仅启动恢复时产生）。
    pub missed_planned_at: Option<i64>,
}

/// 全新任务或恢复后的第一次执行。
pub fn plan_schedule_new(
    now: i64,
    spec: &ScheduleSpec,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> Result<i64, ScheduleError> {
    if spec.kind == ScheduleKind::Daily {
        let window = spec.window.as_ref().ok_or_else(|| ScheduleError("窗口配置缺失".to_string()))?;
        return Ok(plan_with_pause(now, window, pause, rng));
    }
    Ok(skip_paused_days(now, spec, pause, rng))
}

/// 刚执行完的那次发生在 `fired_at`；下一次是什么时候？
pub fn plan_schedule_after(
    now: i64,
    spec: &ScheduleSpec,
    fired_at: i64,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> Result<i64, ScheduleError> {
    if spec.kind == ScheduleKind::Daily {
        let window = spec.window.as_ref().ok_or_else(|| ScheduleError("窗口配置缺失".to_string()))?;
        return Ok(plan_after_run_with_pause(now, window, pause, rng));
    }
    // 不漂移：网格锚定在被调度的时刻，让每分钟一次的 2 秒请求不会越跑越晚。
    // 只有请求真的跑过了下一个刻度，才从现在重新起算。
    let interval = (spec.interval_seconds.unwrap_or(1)) * 1000;
    if spec.start_at.is_some() {
        // 用户定义的锚点优先于「以上一次执行为锚」：
        // 取执行之后的下一个网格刻度，且绝不取已经过去的时刻。
        return Ok(skip_paused_days(fired_at.max(now), spec, pause, rng));
    }
    let base = if fired_at + interval <= now { now } else { fired_at };
    Ok(skip_paused_days(base, spec, pause, rng))
}

/// 目标时刻迟到多久才算「错过」而不是「立刻执行」。
/// 一台挂起的机器不能把每分钟任务的几天积压悄悄重放。
pub fn schedule_lateness_tolerance(spec: &ScheduleSpec) -> i64 {
    if spec.kind == ScheduleKind::Daily {
        return 0;
    }
    let period = (spec.interval_seconds.unwrap_or(60)) * 1000;
    60_000.min(5_000.max(period))
}

pub fn is_missed_non_daily(now: i64, target: i64, spec: &ScheduleSpec) -> bool {
    now - target > schedule_lateness_tolerance(spec)
}

/// 循环任务（非 daily）的启动恢复。
pub fn plan_schedule_recovery(
    now: i64,
    spec: &ScheduleSpec,
    next_run_at: Option<i64>,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> Result<PlanResult, ScheduleError> {
    if spec.kind == ScheduleKind::Daily {
        let window = spec.window.as_ref().ok_or_else(|| ScheduleError("窗口配置缺失".to_string()))?;
        let plan = plan_recovery(now, next_run_at, window, rng);
        return Ok(PlanResult {
            target: plan.target,
            missed_planned_at: plan.missed,
        });
    }

    if let Some(planned) = next_run_at {
        if planned > now {
            return Ok(PlanResult {
                target: planned,
                missed_planned_at: None,
            });
        }
        if !is_missed_non_daily(now, planned, spec) {
            // 还在容差窗口内：尽快执行它，而不是丢掉只是晚了几毫秒/几秒的一次。
            return Ok(PlanResult {
                target: now.max(planned),
                missed_planned_at: None,
            });
        }
    }
    let missed = next_run_at;
    Ok(PlanResult {
        target: skip_paused_days(now, spec, pause, rng),
        missed_planned_at: missed,
    })
}

/// 存储的计划是否属于被暂停的自然日（非 daily 方式）。
pub fn schedule_plan_paused(
    target: i64,
    spec: &ScheduleSpec,
    pause: Option<PauseInterval>,
) -> bool {
    if spec.kind == ScheduleKind::Daily {
        return match &spec.window {
            Some(window) => plan_paused(target, window, pause),
            None => false,
        };
    }
    pause_covers(target, pause)
}

/// 表单里的确定性预览（“这实际上什么时候会跑？”）。
#[derive(Debug, Clone, PartialEq)]
pub struct SchedulePreview {
    pub description: String,
    pub next: Vec<i64>,
}

pub fn preview_schedule(spec: &ScheduleSpec, now: i64, count: usize) -> SchedulePreview {
    let mut next: Vec<i64> = Vec::new();
    if spec.kind == ScheduleKind::Daily {
        if let Some(window) = &spec.window {
            // 还开着的窗口今天一定会跑，所以它必须是第一项：
            // 只用 next_window_start_after() 会悄悄跳到明天。
            let mut start = match window_instance_at(now, window) {
                Some(current) => current.start,
                None => next_window_start_after(now, window),
            };
            for _ in 0..count {
                next.push(start);
                start = next_window_start_after(start + 1000, window);
            }
        }
        return SchedulePreview {
            description: describe_schedule(spec),
            next,
        };
    }

    let step = (spec.interval_seconds.unwrap_or(0)) * 1000;
    let mut cursor = now;
    for _ in 0..count {
        cursor = match spec.start_at {
            Some(anchor) => next_tick_after(cursor, anchor, step),
            None => cursor + step,
        };
        next.push(cursor);
    }
    SchedulePreview {
        description: describe_schedule(spec),
        next,
    }
}

/// `RecoveryReason` 对外暴露的字符串形式（与 TS 版一致）。
pub fn recovery_reason_str(reason: &RecoveryReason) -> &'static str {
    reason.as_str()
}
