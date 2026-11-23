//! 时间窗口与计划：跨午夜窗口、随机时刻、恢复与暂停。
//!
//! 与 TypeScript 版（`src/window.ts`）行为一致，尤其是：
//! - 窗口实例按**开始日**归属（23:50–00:10 属于开始日 D）。
//! - 暂停是**整自然日**的半开区间 `[from, until)`。
//! - 精确时间（start === end）是一个宽��为 60 秒的“瞬时窗口”。

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike};

/// 最长可暂停的天数。
pub const MAX_PAUSE_DAYS: i64 = 15;

/// 精确时间的一次触发能容忍多久：晚 3 秒仍算按时，晚 5 分钟记为错过。
pub const INSTANT_GRACE_MS: i64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowError(pub String);

impl std::fmt::Display for WindowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WindowError {}

/// 一个时间窗口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSpec {
    pub start: String,
    pub end: String,
    pub start_minutes: i64,
    pub end_minutes: i64,
    pub duration_minutes: i64,
    pub cross_midnight: bool,
    /// `start === end`：精确时间，计划点固定在 `start`。
    pub instant: bool,
}

/// 窗口实例：从 `start` 到 `end` 的一段绝对时间。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowInstance {
    pub start: i64,
    pub end: i64,
}

/// 暂停区间：整自然日的半开区间 `[from, until)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PauseInterval {
    pub from: i64,
    pub until: i64,
}

/// 恢复时的计划结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryPlan {
    pub target: i64,
    /// 被判定为错过的计划时刻。
    pub missed: Option<i64>,
    pub reason: RecoveryReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryReason {
    Future,
    InWindow,
    Missed,
    NextWindow,
}

impl RecoveryReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecoveryReason::Future => "future",
            RecoveryReason::InWindow => "in-window",
            RecoveryReason::Missed => "missed",
            RecoveryReason::NextWindow => "next-window",
        }
    }
}

/// 定时器触发时的判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerFireVerdict {
    Run,
    Miss,
}

fn parse_hhmm(value: &str, label: &str) -> Result<i64, WindowError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 5
        && bytes[2] == b':'
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit();
    if !valid {
        return Err(WindowError(format!(
            "{label}必须是 HH:mm 格式（00:00–23:59）"
        )));
    }
    let hours: i64 = value[0..2].parse().unwrap_or(0);
    let minutes: i64 = value[3..5].parse().unwrap_or(0);
    if hours > 23 || minutes > 59 {
        return Err(WindowError(format!(
            "{label}必须是 HH:mm 格式（00:00–23:59）"
        )));
    }
    Ok(hours * 60 + minutes)
}

/// `start === end` 表示“精确时间”；其余为普通窗口，`end < start` 表示跨午夜。
pub fn parse_window(start: &str, end: &str) -> Result<WindowSpec, WindowError> {
    let start_minutes = parse_hhmm(start, "开始时间")?;
    let end_minutes = parse_hhmm(end, "结束时间")?;
    let duration_minutes = (end_minutes - start_minutes + 24 * 60) % (24 * 60);
    Ok(WindowSpec {
        start: start.to_string(),
        end: end.to_string(),
        start_minutes,
        end_minutes,
        duration_minutes,
        cross_midnight: end_minutes < start_minutes,
        instant: duration_minutes == 0,
    })
}

/// 校验窗口格式；返回 `None` 表示可用。
pub fn validate_window(start: &str, end: &str) -> Option<String> {
    parse_window(start, end).err().map(|error| error.0)
}

/// 本地时间的零点，可按整自然日偏移。
pub fn start_of_local_day(now: i64, offset_days: i64) -> i64 {
    let date = to_local(now).date_naive();
    let date = shift_days(date, offset_days);
    date.and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or(now)
}

/// 由用户的两个选择构造暂停区间。
///
/// - `starts_today = true` → `[今天 00:00, 今天 + N 天 00:00)`。
/// - `starts_today = false` → `[明天 00:00, 明天 + N 天 00:00)`。
///
/// 两种情况都暂停整整 N 个自然日。
pub fn pause_interval(now: i64, days: i64, starts_today: bool) -> PauseInterval {
    let start_offset = if starts_today { 0 } else { 1 };
    PauseInterval {
        from: start_of_local_day(now, start_offset),
        until: start_of_local_day(now, start_offset + days),
    }
}

/// 暂停结束的时刻（第一个可以再次执行的时间）。
pub fn pause_resume_at(now: i64, days: i64, starts_today: bool) -> i64 {
    pause_interval(now, days, starts_today).until
}

fn to_local(timestamp: i64) -> DateTime<Local> {
    DateTime::from_timestamp_millis(timestamp)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch"))
        .with_timezone(&Local)
}

/// 按整自然日偏移（保持挂钟时间，夏令时切换时与 JS 的 `setDate` 一致）。
fn shift_days(date: NaiveDate, days: i64) -> NaiveDate {
    if days >= 0 {
        date + chrono::Days::new(days as u64)
    } else {
        date - chrono::Days::new((-days) as u64)
    }
}

fn local_at(now: i64, minutes: i64) -> i64 {
    let datetime = to_local(now);
    let hours = minutes.div_euclid(60) as u32;
    let rest = minutes.rem_euclid(60) as u32;
    datetime
        .date_naive()
        .and_hms_opt(hours, rest, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or(now)
}

fn add_days(timestamp: i64, days: i64) -> i64 {
    let datetime = to_local(timestamp);
    let naive = datetime.naive_local();
    shift_days(naive.date(), days)
        .and_hms_opt(naive.hour(), naive.minute(), naive.second())
        .and_then(|value| value.and_local_timezone(Local).earliest())
        .map(|value| value.timestamp_millis())
        .unwrap_or(timestamp)
}

fn add_minutes(timestamp: i64, minutes: i64) -> i64 {
    timestamp + Duration::minutes(minutes).num_milliseconds()
}

fn end_of(start: i64, spec: &WindowSpec) -> i64 {
    add_minutes(start, spec.duration_minutes)
}

/// “这次触发是否还开着”的结束时刻：精确时间会加上宽限期。
fn instance_end_of(start: i64, spec: &WindowSpec) -> i64 {
    if spec.instant {
        start + INSTANT_GRACE_MS
    } else {
        end_of(start, spec)
    }
}

/// 包含 `now` 的窗口实例。按开始日归属，跨午夜时午夜后仍属于前一天。
pub fn window_instance_at(now: i64, spec: &WindowSpec) -> Option<WindowInstance> {
    let start_today = local_at(now, spec.start_minutes);
    let end_today = instance_end_of(start_today, spec);
    if now >= start_today && now < end_today {
        return Some(WindowInstance {
            start: start_today,
            end: end_today,
        });
    }
    let start_yesterday = add_days(start_today, -1);
    let end_yesterday = instance_end_of(start_yesterday, spec);
    if now >= start_yesterday && now < end_yesterday {
        return Some(WindowInstance {
            start: start_yesterday,
            end: end_yesterday,
        });
    }
    None
}

/// 下一个窗口的开始时刻（今天或明天）。
pub fn next_window_start_after(now: i64, spec: &WindowSpec) -> i64 {
    let start_today = local_at(now, spec.start_minutes);
    if start_today > now {
        start_today
    } else {
        add_days(start_today, 1)
    }
}

/// 定时器只允许在包含其目标时刻的窗口实例仍然打开时执行。
pub fn classify_timer_fire(now: i64, target: i64, spec: &WindowSpec) -> TimerFireVerdict {
    match window_instance_at(now, spec) {
        Some(instance) if target >= instance.start && target < instance.end => TimerFireVerdict::Run,
        _ => TimerFireVerdict::Miss,
    }
}

/// 在 `[from, to)` 里取一个随机点。
pub fn random_point(from: i64, to: i64, rng: &mut dyn FnMut() -> f64) -> i64 {
    let span = to - from;
    if span <= 0 {
        return from;
    }
    let ratio = rng().clamp(0.0, 0.999_999_999);
    from + (ratio * span as f64).floor() as i64
}

/// 新建任务时的计划。
pub fn plan_new_task(now: i64, spec: &WindowSpec, rng: &mut dyn FnMut() -> f64) -> i64 {
    if let Some(current) = window_instance_at(now, spec) {
        // 精确时间没有可随机的范围：尽快执行。
        if spec.instant {
            return now.max(current.start);
        }
        return random_point(now.max(current.start), current.end, rng);
    }
    let start = next_window_start_after(now, spec);
    random_point(start, end_of(start, spec), rng)
}

/// 一次执行之后的下一个窗口。
pub fn plan_next_window_after(now: i64, spec: &WindowSpec, rng: &mut dyn FnMut() -> f64) -> i64 {
    let start = next_window_start_after(now, spec);
    random_point(start, end_of(start, spec), rng)
}

/// 启动时的恢复：未来的计划保留，窗口内的过期计划重新随机，已关闭的记为错过。
pub fn plan_recovery(
    now: i64,
    next_run_at: Option<i64>,
    spec: &WindowSpec,
    rng: &mut dyn FnMut() -> f64,
) -> RecoveryPlan {
    if let Some(planned) = next_run_at {
        if planned > now {
            return RecoveryPlan {
                target: planned,
                missed: None,
                reason: RecoveryReason::Future,
            };
        }
    }

    if let Some(current) = window_instance_at(now, spec) {
        let missed = next_run_at.filter(|planned| *planned < current.start);
        let target = if spec.instant {
            now.max(current.start)
        } else {
            random_point(now.max(current.start), current.end, rng)
        };
        return RecoveryPlan {
            target,
            missed,
            reason: RecoveryReason::InWindow,
        };
    }

    let missed = next_run_at.filter(|planned| *planned <= now);
    let start = next_window_start_after(now, spec);
    RecoveryPlan {
        target: random_point(start, end_of(start, spec), rng),
        missed,
        reason: if missed.is_some() {
            RecoveryReason::Missed
        } else {
            RecoveryReason::NextWindow
        },
    }
}

/// 计划时刻是否落在被暂停的自然日里。
///
/// 判断依据是**窗口实例的开始日**，不是执行的挂钟时刻，也不是设置暂停的时刻。
pub fn plan_paused(target: i64, spec: &WindowSpec, pause: Option<PauseInterval>) -> bool {
    let pause = match pause {
        Some(pause) if pause.until > pause.from => pause,
        _ => return false,
    };
    let instance = match window_instance_at(target, spec) {
        Some(instance) => instance,
        None => return false,
    };
    let day = start_of_local_day(instance.start, 0);
    day >= pause.from && day < pause.until
}

/// 恢复日**自己那天**的窗口实例里的随机点。
///
/// `until` 是本地零点，`local_at(until, ...)` 取的正是那天的窗口开始；
/// 用 `plan_new_task(until, ...)` 对跨午夜窗口是错的：零点落在前一天的
/// 23:50–00:10 实例里，那仍然属于被暂停的一天。
pub fn plan_resume_window(until: i64, spec: &WindowSpec, rng: &mut dyn FnMut() -> f64) -> i64 {
    let start = local_at(until, spec.start_minutes);
    random_point(start, end_of(start, spec), rng)
}

/// 从 `from` 规划下一次执行；最近窗口所在日被暂停时跳到恢复日。
pub fn plan_with_pause(
    from: i64,
    spec: &WindowSpec,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> i64 {
    let pause = match pause {
        Some(pause) if from < pause.until => pause,
        _ => return plan_new_task(from, spec, rng),
    };
    let candidate = plan_new_task(from, spec, rng);
    if !plan_paused(candidate, spec, Some(pause)) {
        return candidate;
    }
    plan_resume_window(pause.until, spec, rng)
}

/// 执行之后的下一个窗口，跳过被暂停的日子。
pub fn plan_after_run_with_pause(
    now: i64,
    spec: &WindowSpec,
    pause: Option<PauseInterval>,
    rng: &mut dyn FnMut() -> f64,
) -> i64 {
    let candidate = plan_next_window_after(now, spec, rng);
    match pause {
        Some(pause) if plan_paused(candidate, spec, Some(pause)) => {
            plan_resume_window(pause.until, spec, rng)
        }
        _ => candidate,
    }
}

/// 今天（按本地日历）是多少号，供外部展示使用。
pub fn local_day_of(timestamp: i64) -> u32 {
    to_local(timestamp).day()
}

/// 本地日期（用于生成每日计划）。
pub fn local_date(timestamp: i64) -> NaiveDate {
    to_local(timestamp).date_naive()
}
