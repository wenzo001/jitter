//! 执行前判断的本地部分（不发请求）：「只在指定星期」与「只在时段内」。
//!
//! 两者都可选，且与前置 curl 组合使用。语义与其余部分一致：
//! 本地挂钟、分钟精度，结束早于开始的时段跨午夜并归属**开始日**。

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};
use serde_json::Value as Json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardError(pub String);

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GuardError {}

fn err<T>(message: impl Into<String>) -> Result<T, GuardError> {
    Err(GuardError(message.into()))
}

pub const WEEKDAY_LABELS: [&str; 7] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/// 接受 `[1,2,3]` 或 `"1,2,3"`；空表示「不限制」。
pub fn parse_weekdays(value: Option<&Json>) -> Result<Option<Vec<i64>>, GuardError> {
    let value = match value {
        None | Some(Json::Null) => return Ok(None),
        Some(value) => value,
    };
    let raw: Vec<Json> = match value {
        Json::Array(items) => items.clone(),
        Json::String(text) if text.is_empty() => return Ok(None),
        Json::String(text) => text
            .split(',')
            .map(|part| Json::String(part.trim().to_string()))
            .collect(),
        _ => return err("执行星期必须是数组或逗号分隔的数字"),
    };

    let mut days: Vec<i64> = Vec::new();
    for item in &raw {
        let number = match item {
            Json::Null => continue,
            Json::String(text) if text.trim().is_empty() => continue,
            Json::Number(number) => number.as_f64(),
            Json::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        };
        let day = match number {
            Some(day) if day.is_finite() && day.fract() == 0.0 => day as i64,
            _ => return err("执行星期必须是 0–6 的整数（0 = 周日）"),
        };
        if !(0..=6).contains(&day) {
            return err("执行星期必须是 0–6 的整数（0 = 周日）");
        }
        if !days.contains(&day) {
            days.push(day);
        }
    }
    if days.is_empty() {
        return Ok(None);
    }
    days.sort_unstable();
    Ok(Some(days))
}

/// 两边都空表示「没有时段限制」；只填一边是错误。
pub fn parse_time_range(
    start: Option<&Json>,
    end: Option<&Json>,
) -> Result<Option<(String, String)>, GuardError> {
    let text = |value: Option<&Json>| -> Option<String> {
        value
            .and_then(|value| value.as_str())
            .map(|text| text.trim().to_string())
    };
    let start_text = text(start).unwrap_or_default();
    let end_text = text(end).unwrap_or_default();
    if start_text.is_empty() && end_text.is_empty() {
        return Ok(None);
    }
    if start_text.is_empty() || end_text.is_empty() {
        return err("执行时段需要同时填写开始和结束时间");
    }
    if !is_hhmm(&start_text) {
        return err("执行时段开始时间必须是 HH:mm 格式");
    }
    if !is_hhmm(&end_text) {
        return err("执行时段结束时间必须是 HH:mm 格式");
    }
    if start_text == end_text {
        return err("执行时段的开始和结束时间不能相同");
    }
    Ok(Some((start_text, end_text)))
}

fn is_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[0] <= b'2'
        && (bytes[0] < b'2' || bytes[1] <= b'3')
        && bytes[3] <= b'5'
}

fn to_minutes(value: &str) -> i64 {
    if !is_hhmm(value) {
        return 0;
    }
    let hours: i64 = value[0..2].parse().unwrap_or(0);
    let minutes: i64 = value[3..5].parse().unwrap_or(0);
    hours * 60 + minutes
}

/// 存储行里的本地条件（宽松读取：坏数据一律视为「不限制」）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LocalGuardConfig {
    /// `None` 表示每天；否则是 0..6（0 = 周日）。
    pub weekdays: Option<Vec<i64>>,
    pub time_start: Option<String>,
    pub time_end: Option<String>,
}

/// 从存储行宽松读取本地条件。
pub fn local_guard_of(
    weekdays: Option<&str>,
    time_start: Option<&str>,
    time_end: Option<&str>,
) -> LocalGuardConfig {
    let mut days: Option<Vec<i64>> = None;
    if let Some(raw) = weekdays {
        if !raw.is_empty() {
            let parsed: Vec<i64> = raw
                .split(',')
                .map(|part| part.trim().parse::<i64>().unwrap_or(-1))
                .filter(|day| (0..=6).contains(day))
                .collect();
            if !parsed.is_empty() {
                let mut unique = parsed.clone();
                unique.sort_unstable();
                unique.dedup();
                days = Some(unique);
            }
        }
    }
    let start = time_start
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let end = time_end
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let valid_range = matches!((&start, &end), (Some(start), Some(end))
        if is_hhmm(start) && is_hhmm(end) && start != end);
    LocalGuardConfig {
        weekdays: days,
        time_start: if valid_range { start } else { None },
        time_end: if valid_range { end } else { None },
    }
}

pub fn has_local_conditions(config: &LocalGuardConfig) -> bool {
    (config
        .weekdays
        .as_ref()
        .map_or(false, |days| !days.is_empty()))
        || (config.time_start.is_some() && config.time_end.is_some())
}

fn describe_weekdays(days: &[i64]) -> String {
    days.iter()
        .map(|day| WEEKDAY_LABELS.get(*day as usize).copied().unwrap_or("?"))
        .collect::<Vec<_>>()
        .join("、")
}

/// 本地条件的判定结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardVerdict {
    pub passed: bool,
    pub reason: String,
}

/// 判断 `now` 的本地条件。无论通过与否都返回人话原因，
/// 让跳过日志和测试台都能解释自己。
pub fn evaluate_local_guard(config: &LocalGuardConfig, now: i64) -> GuardVerdict {
    let datetime: DateTime<Local> = DateTime::from_timestamp_millis(now)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch"))
        .with_timezone(&Local);
    let minutes = (datetime.hour() * 60 + datetime.minute()) as i64;
    let clock = format!("{:02}:{:02}", datetime.hour(), datetime.minute());
    let mut weekday = datetime.weekday().num_days_from_sunday() as i64;

    if let (Some(start), Some(end)) = (&config.time_start, &config.time_end) {
        let start_minutes = to_minutes(start);
        let end_minutes = to_minutes(end);
        let cross_midnight = end_minutes < start_minutes;
        let mut in_range = false;
        if !cross_midnight {
            in_range = minutes >= start_minutes && minutes < end_minutes;
        } else if minutes >= start_minutes {
            in_range = true;
        } else if minutes < end_minutes {
            // 22:00–02:00 的 00:30 仍属于昨天的实例。
            in_range = true;
            weekday = (weekday + 6) % 7;
        }
        if !in_range {
            let suffix = if cross_midnight {
                "（跨午夜）"
            } else {
                ""
            };
            return GuardVerdict {
                passed: false,
                reason: format!("当前 {clock} 不在执行时段 {start}–{end}{suffix} 内"),
            };
        }
    }

    if let Some(days) = &config.weekdays {
        if !days.is_empty() && !days.contains(&weekday) {
            return GuardVerdict {
                passed: false,
                reason: format!(
                    "今天是{}，不在允许执行的星期（{}）内",
                    WEEKDAY_LABELS[weekday as usize],
                    describe_weekdays(days)
                ),
            };
        }
    }

    let mut parts: Vec<String> = vec![format!("今天{} {clock}", WEEKDAY_LABELS[weekday as usize])];
    if let (Some(start), Some(end)) = (&config.time_start, &config.time_end) {
        parts.push(format!("时段 {start}–{end}"));
    }
    if let Some(days) = &config.weekdays {
        if !days.is_empty() {
            parts.push(format!("允许 {}", describe_weekdays(days)));
        }
    }
    if parts.len() == 1 {
        return GuardVerdict {
            passed: true,
            reason: "未设置本地条件（任何时间都执行）".to_string(),
        };
    }
    GuardVerdict {
        passed: true,
        reason: format!("本地条件满足（{}）", parts.join("，")),
    }
}

// ---------------------------------------------------------------------------
// 电源 / 本机 IP 条件
// ---------------------------------------------------------------------------

/// 存储行里的环境条件：只有接通电源才执行、只有本机 IP 匹配才执行。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HostGuardConfig {
    pub require_ac_power: bool,
    pub ip_pattern: Option<String>,
}

/// 解析「本机 IP」条件：允许数字、点与 `*`，多组用逗号或空格分隔。
/// 空值表示不限制；返回统一成逗号分隔的规范化字符串。
pub fn parse_ip_pattern(value: Option<&Json>) -> Result<Option<String>, GuardError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let raw = match value {
        Json::Null => return Ok(None),
        Json::String(text) => text.trim(),
        _ => return err("本机 IP 条件必须是字符串"),
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let mut patterns: Vec<String> = Vec::new();
    for part in raw.split(|ch: char| ch == ',' || ch.is_whitespace()) {
        if part.is_empty() {
            continue;
        }
        if !part
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.' || ch == '*')
        {
            return err("本机 IP 条件只能包含数字、点和 *（多组用逗号分隔）");
        }
        if !part.chars().any(|ch| ch.is_ascii_digit()) && !part.contains('*') {
            return err("本机 IP 条件不能只有点");
        }
        patterns.push(part.to_string());
    }
    if patterns.is_empty() {
        return Ok(None);
    }
    Ok(Some(patterns.join(",")))
}

/// 单个模式的通配匹配：`*` 匹配任意数量的字符（实际 IP 里只有数字和点）。
pub fn ip_matches_pattern(ip: &str, pattern: &str) -> bool {
    let ip: Vec<char> = ip.chars().collect();
    let pattern: Vec<char> = pattern.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while i < ip.len() {
        if j < pattern.len() && pattern[j] == ip[i] {
            i += 1;
            j += 1;
        } else if j < pattern.len() && pattern[j] == '*' {
            star = Some(j);
            mark = i;
            j += 1;
        } else if let Some(star_index) = star {
            j = star_index + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while j < pattern.len() && pattern[j] == '*' {
        j += 1;
    }
    j == pattern.len()
}

/// 多个模式的任意一个命中即可。
pub fn ip_matches_any(ip: &str, patterns: &str) -> bool {
    patterns
        .split(',')
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .any(|pattern| ip_matches_pattern(ip, pattern))
}

pub fn has_host_conditions(config: &HostGuardConfig) -> bool {
    config.require_ac_power
        || config
            .ip_pattern
            .as_ref()
            .map_or(false, |pattern| !pattern.is_empty())
}

/// 判断电源 / 本机 IP 条件。`on_ac_power` 为 `None` 表示无法判断。
pub fn evaluate_host_guard(
    config: &HostGuardConfig,
    on_ac_power: Option<bool>,
    local_ips: &[String],
) -> GuardVerdict {
    if config.require_ac_power {
        match on_ac_power {
            Some(true) => {}
            Some(false) => {
                return GuardVerdict {
                    passed: false,
                    reason: "当前使用电池供电，未接通电源".to_string(),
                }
            }
            None => {
                return GuardVerdict {
                    passed: false,
                    reason: "无法获取电源状态，不能确认已接通电源".to_string(),
                }
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if config.require_ac_power {
        parts.push("已接通电源".to_string());
    }
    if let Some(pattern) = &config.ip_pattern {
        if !pattern.is_empty() {
            let matched = local_ips
                .iter()
                .find(|ip| ip_matches_any(ip, pattern))
                .cloned();
            if matched.is_none() {
                let current = if local_ips.is_empty() {
                    "未能读取本机 IP".to_string()
                } else {
                    local_ips.join(", ")
                };
                return GuardVerdict {
                    passed: false,
                    reason: format!("本机 IP（{current}）不匹配条件 {pattern}"),
                };
            }
            parts.push(format!(
                "本机 IP {} 匹配 {pattern}",
                matched.unwrap_or_default()
            ));
        }
    }

    if parts.is_empty() {
        return GuardVerdict {
            passed: true,
            reason: "未设置电源 / 本机 IP 条件".to_string(),
        };
    }
    GuardVerdict {
        passed: true,
        reason: format!("环境条件满足（{}）", parts.join("，")),
    }
}
