//! 中国法定节假日数据（[holiday-cn](https://github.com/NateScarlet/holiday-cn)）：
//! 静默拉取、解析、内存缓存与「某天是工作日还是休息日」的判断。
//!
//! 数据按年缓存进 `holiday_years` 表（永远保留去年 / 今年 / 明年三年），
//! 判断只读内存缓存：当年数据缺失时返回 `None`，由调用方决定跳过该条件。
//!
//! 数据语义（见仓库 README）：
//! - `days` 列表内的日期按 `isOffDay` 判断（节假日放假 / 调休上班）；
//! - 列表外的日期按星期判断（周六日为休息日，其余为工作日）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate, TimeZone, Weekday};
use serde::Serialize;
use serde_json::Value as Json;

use crate::executor::now_ms;

const SOURCE_TIMEOUT: Duration = Duration::from_secs(20);
/// 数据源主站与镜像；逐个尝试，任意一个成功即可。
const MIRRORS: [&str; 3] = [
    "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json",
    "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json",
    "https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayDay {
    pub name: String,
    /// `YYYY-MM-DD`。
    pub date: String,
    pub is_off_day: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HolidayYear {
    pub year: i32,
    pub days: Vec<HolidayDay>,
}

/// 设置页展示用的年度概览（含明细，供弹窗查看）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayYearMeta {
    pub year: i32,
    /// 法定放假天数（`isOffDay = true` 的条目）。
    pub off_days: i64,
    /// 调休上班天数（`isOffDay = false` 的条目，通常落在周末）。
    pub makeup_days: i64,
    pub fetched_at: i64,
    /// 按日期升序排列的明细。
    pub days: Vec<HolidayDay>,
}

/// 单日的归类结果（顶栏标签与日历面板共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayInfo {
    /// `YYYY-MM-DD`。
    pub date: String,
    /// `holiday` 法定节假日放假 / `makeup` 调休上班 / `weekend` 普通周末 / `workday` 工作日。
    pub day_type: String,
    /// 是否上班（工作日与调休上班日为 true）。
    pub is_workday: bool,
    /// 节日名称（法定节假日与调休日有，普通日期没有）。
    pub name: Option<String>,
    /// 是否依据节假日数据判定；false 表示该年没有数据，只按星期推断。
    pub authoritative: bool,
    /// 星期几（1 = 周一 … 7 = 周日）。
    pub weekday: u32,
    /// 星期几（中文）。
    pub weekday_label: String,
}

const WEEKDAY_LABELS: [&str; 7] = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

fn weekday_label(weekday: Weekday) -> &'static str {
    WEEKDAY_LABELS[weekday.num_days_from_monday() as usize]
}

// ---------------------------------------------------------------------------
// 内存缓存：判断只读缓存，不碰数据库锁。
// ---------------------------------------------------------------------------

fn cache() -> &'static RwLock<HashMap<i32, Arc<HolidayYear>>> {
    static CACHE: OnceLock<RwLock<HashMap<i32, Arc<HolidayYear>>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        // 启动后首次访问时从数据库回填，进程内不再重复加载。
        let map: HashMap<i32, Arc<HolidayYear>> = crate::db::list_holiday_years()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(year, days, _fetched_at)| {
                parse_year(&days).ok().map(|data| (year, Arc::new(data)))
            })
            .collect();
        RwLock::new(map)
    })
}

fn cache_year(data: HolidayYear) {
    let year = data.year;
    if let Ok(mut map) = cache().write() {
        map.insert(year, Arc::new(data));
    }
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

fn parse_year(raw: &str) -> Result<HolidayYear, String> {
    parse_year_public(raw)
}

/// 测试与调试用的公开解析入口。
pub fn parse_year_public(raw: &str) -> Result<HolidayYear, String> {
    let value: Json =
        serde_json::from_str(raw).map_err(|error| format!("节假日数据不是合法 JSON：{error}"))?;
    let year = value
        .get("year")
        .and_then(Json::as_i64)
        .ok_or_else(|| "节假日数据缺少 year 字段".to_string())?
        as i32;
    let days = value
        .get("days")
        .and_then(Json::as_array)
        .ok_or_else(|| "节假日数据缺少 days 字段".to_string())?
        .iter()
        .filter_map(|entry| {
            let date = entry.get("date").and_then(Json::as_str)?.to_string();
            let is_off_day = entry.get("isOffDay").and_then(Json::as_bool)?;
            let name = entry
                .get("name")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            Some(HolidayDay {
                name,
                date,
                is_off_day,
            })
        })
        .collect();
    Ok(HolidayYear { year, days })
}

// ---------------------------------------------------------------------------
// 拉取与持久化
// ---------------------------------------------------------------------------

async fn fetch_year(year: i32) -> Result<HolidayYear, String> {
    fetch_year_public(year).await
}

/// 测试与诊断用的公开拉取入口。
pub async fn fetch_year_public(year: i32) -> Result<HolidayYear, String> {
    let mut errors: Vec<String> = Vec::new();
    for template in MIRRORS {
        let url = template.replace("{year}", &year.to_string());
        match crate::updater::get_with_proxy_fallback(&url, SOURCE_TIMEOUT, "application/json").await
        {
            Ok(response) => match response.text().await {
                Ok(text) => match parse_year(&text) {
                    Ok(data) => {
                        if data.year != year {
                            errors.push(format!("{url}: 返回了 {} 年的数据", data.year));
                            continue;
                        }
                        return Ok(data);
                    }
                    Err(error) => errors.push(format!("{url}: {error}")),
                },
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(format!(
        "{} 年节假日数据获取失败（{}）",
        year,
        errors.join("；")
    ))
}

fn target_years(now_ms: i64) -> Vec<i32> {
    let year = Local.timestamp_millis_opt(now_ms).single().map_or(0, |d| d.year());
    [year - 1, year, year + 1].into_iter().collect()
}

/// 拉取去年 / 今年 / 明年三年并写库 + 更新缓存；返回成功覆盖的年份。
/// 拉取失败静默返回错误列表（不做任何提示），已有数据继续使用。
pub async fn refresh_years() -> (Vec<i32>, Vec<String>) {
    let mut refreshed = Vec::new();
    let mut errors = Vec::new();
    for year in target_years(now_ms()) {
        match fetch_year(year).await {
            Ok(data) => {
                let day_count = data.days.len() as i64;
                // 存完整对象（含 year / days）：读取端统一用 parse_year 解析。
                let raw = serde_json::to_string(&data).unwrap_or_else(|_| {
                    format!(r#"{{"year":{}}}"#, data.year)
                });
                match crate::db::upsert_holiday_year(data.year, &raw, now_ms(), day_count) {
                    Ok(()) => {
                        cache_year(data);
                        refreshed.push(year);
                    }
                    Err(error) => errors.push(format!("{} 年写库失败：{}", year, error.0)),
                }
            }
            Err(error) => errors.push(error),
        }
    }
    (refreshed, errors)
}

/// 静默后台刷新：所有失败只进日志，不做任何用户提示。
pub async fn refresh_years_silent() {
    let (refreshed, errors) = refresh_years().await;
    if !errors.is_empty() {
        tracing::info!("[holiday] 节假日数据更新失败（继续使用本地缓存）: {}", errors.join("；"));
    }
    if !refreshed.is_empty() {
        tracing::info!("[holiday] 节假日数据已更新: {:?} 年", refreshed);
    }
}

// ---------------------------------------------------------------------------
// 判断与查询
// ---------------------------------------------------------------------------

/// 判断 `now_ms` 所在本地日期是否为休息日。
/// 返回 `None` 表示当年没有数据、无法判断（调用方应跳过该条件）。
pub fn is_off_day(now_ms: i64) -> Option<bool> {
    let datetime = Local.timestamp_millis_opt(now_ms).single()?;
    let year = datetime.year();
    let date = format!("{:04}-{:02}-{:02}", datetime.year(), datetime.month(), datetime.day());
    let current = year_data(year);
    if let Some(is_off) = lookup_listed_day(&date, year, year_data) {
        return Some(is_off);
    }
    // 列表外的日期按星期判断；当年数据缺失时无法判断。
    current.as_ref()?;
    use chrono::Weekday;
    Some(matches!(datetime.weekday(), Weekday::Sat | Weekday::Sun))
}

/// 节假日文件按「国务院公告年份」归档，12 月的日期可能记录在下一年的文件里
///（例如 2018-12-29 的调休上班在 2019.json 中），所以下一年也要查。
fn lookup_listed_day(
    date: &str,
    year: i32,
    fetch: impl Fn(i32) -> Option<Arc<HolidayYear>>,
) -> Option<bool> {
    for candidate in [year, year + 1] {
        let Some(data) = fetch(candidate) else {
            continue;
        };
        if let Some(day) = data.days.iter().find(|day| day.date == date) {
            return Some(day.is_off_day);
        }
    }
    None
}

/// 查某一天是否出现在节假日文件里（返回是否放假与节日名）。
/// 与 [`lookup_listed_day`] 同样跨年查找（12 月的日期可能记在下一年的文件里）。
fn find_listed_day(date: &str, year: i32) -> Option<(bool, String)> {
    for candidate in [year, year + 1] {
        let Some(data) = year_data(candidate) else {
            continue;
        };
        if let Some(day) = data.days.iter().find(|day| day.date == date) {
            return Some((day.is_off_day, day.name.clone()));
        }
    }
    None
}

/// 单日归类：法定节假日 / 调休上班 / 普通周末 / 工作日。
pub fn day_info(date: NaiveDate) -> DayInfo {
    let text = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    let year = date.year();
    let listed = find_listed_day(&text, year);
    let has_data = year_data(year).is_some();
    classify_day(date, listed, has_data)
}

/// 纯函数版的归类逻辑（便于单测，不碰数据库与缓存）。
fn classify_day(date: NaiveDate, listed: Option<(bool, String)>, has_data: bool) -> DayInfo {
    let text = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    let weekday = date.weekday().num_days_from_monday() as u32 + 1;
    let label = weekday_label(date.weekday()).to_string();
    if let Some((is_off_day, name)) = listed {
        return DayInfo {
            date: text,
            day_type: if is_off_day { "holiday" } else { "makeup" }.to_string(),
            is_workday: !is_off_day,
            name: if name.is_empty() { None } else { Some(name) },
            authoritative: true,
            weekday,
            weekday_label: label,
        };
    }
    // 不在节假日文件里：该年有数据时按星期判断，否则只按星期推断并标记为不可靠。
    let weekend = matches!(date.weekday(), Weekday::Sat | Weekday::Sun);
    DayInfo {
        date: text,
        day_type: if weekend { "weekend" } else { "workday" }.to_string(),
        is_workday: !weekend,
        name: None,
        authoritative: has_data,
        weekday,
        weekday_label: label,
    }
}

/// 今天（或指定时刻所在的那天）的归类。
pub fn today_info(now_ms: i64) -> DayInfo {
    let date = Local
        .timestamp_millis_opt(now_ms)
        .single()
        .map(|value| value.date_naive())
        .unwrap_or_else(|| Local::now().date_naive());
    day_info(date)
}

/// 某年某月的逐日归类（日历面板用）。
pub fn month_info(year: i32, month: u32) -> Vec<DayInfo> {
    let Some(first) = NaiveDate::from_ymd_opt(year, month, 1) else {
        return Vec::new();
    };
    let days = {
        let next = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)
        };
        let next = next.unwrap_or(first);
        (next - first).num_days() as u32
    };
    (0..days)
        .map(|offset| day_info(first + chrono::Days::new(offset as u64)))
        .collect()
}

/// 内存缓存优先，其次回查数据库。
fn year_data(year: i32) -> Option<Arc<HolidayYear>> {
    if let Some(data) = cache().read().ok()?.get(&year).cloned() {
        return Some(data);
    }
    load_year_from_db(year)
}

/// 缓存缺失时按年回查数据库；数据存在则填充缓存，仍无则 `None`。
fn load_year_from_db(year: i32) -> Option<Arc<HolidayYear>> {
    let raw = crate::db::get_holiday_year_days(year).ok()??;
    let data = Arc::new(parse_year(&raw).ok()?);
    if let Ok(mut map) = cache().write() {
        map.insert(year, data.clone());
    }
    Some(data)
}

/// 当天是否可判断（当年有数据）。前端用它决定是否禁用选项。
pub fn has_current_year_data(now_ms: i64) -> bool {
    let Some(datetime) = Local.timestamp_millis_opt(now_ms).single() else {
        return false;
    };
    let map = cache().read().ok();
    map.map(|map| map.contains_key(&datetime.year()))
        .unwrap_or(false)
}

/// 设置页展示：数据库里缓存了哪些年份（含放假 / 调休统计与明细）。
pub fn list_years() -> Vec<HolidayYearMeta> {
    crate::db::list_holiday_years()
        .unwrap_or_default()
        .into_iter()
        .map(|(year, raw, fetched_at)| {
            let mut days = parse_year(&raw).map(|data| data.days).unwrap_or_default();
            days.sort_by(|a, b| a.date.cmp(&b.date));
            HolidayYearMeta {
                year,
                off_days: days.iter().filter(|day| day.is_off_day).count() as i64,
                makeup_days: days.iter().filter(|day| !day.is_off_day).count() as i64,
                fetched_at,
                days,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn table(year: i32, days: &[(&str, bool)]) -> HolidayYear {
        HolidayYear {
            year,
            days: days
                .iter()
                .map(|(date, is_off)| HolidayDay {
                    name: String::new(),
                    date: (*date).to_string(),
                    is_off_day: *is_off,
                })
                .collect(),
        }
    }

    #[test]
    fn listed_day_is_found_in_the_next_year_table() {
        let mut tables: HashMap<i32, HolidayYear> = HashMap::new();
        // 公告年份归档：2034-12-30 的调休上班记录在 2035 年的文件里。
        tables.insert(2035, table(2035, &[("2034-12-30", false)]));
        let fetch = |year: i32| tables.get(&year).cloned().map(Arc::new);

        assert_eq!(lookup_listed_day("2034-12-30", 2034, fetch), Some(false));
        assert_eq!(lookup_listed_day("2034-12-31", 2034, fetch), None);
    }

    #[test]
    fn classifies_holiday_makeup_weekend_and_workday() {
        // 2026-01-05 是周一，2026-01-03 是周六。
        let monday = NaiveDate::from_ymd_opt(2026, 1, 5).expect("date");
        let saturday = NaiveDate::from_ymd_opt(2026, 1, 3).expect("date");

        let holiday = classify_day(monday, Some((true, "元旦".into())), true);
        assert_eq!(holiday.day_type, "holiday");
        assert!(!holiday.is_workday);
        assert_eq!(holiday.name.as_deref(), Some("元旦"));
        assert!(holiday.authoritative);

        let makeup = classify_day(saturday, Some((false, "春节调休".into())), true);
        assert_eq!(makeup.day_type, "makeup");
        assert!(makeup.is_workday);
        assert_eq!(makeup.weekday_label, "星期六");

        let weekend = classify_day(saturday, None, true);
        assert_eq!(weekend.day_type, "weekend");
        assert!(!weekend.is_workday);
        assert!(weekend.authoritative);
        assert!(weekend.name.is_none());

        let workday = classify_day(monday, None, true);
        assert_eq!(workday.day_type, "workday");
        assert!(workday.is_workday);
        assert_eq!(workday.weekday_label, "星期一");

        // 该年没有节假日数据时只按星期推断，并标记为不可靠。
        let uncertain = classify_day(monday, None, false);
        assert_eq!(uncertain.day_type, "workday");
        assert!(!uncertain.authoritative);
    }
}

// ---------------------------------------------------------------------------
// 启动 / 每月 1 号的静默更新
// ---------------------------------------------------------------------------

fn last_auto_month() -> &'static AtomicU32 {
    static LAST: OnceLock<AtomicU32> = OnceLock::new();
    LAST.get_or_init(|| AtomicU32::new(0))
}

/// 每月 1 号触发一次静默刷新（内存节流，重复调用无副作用）。
/// 返回是否真的触发了拉取（调用方决定是否 spawn）。
pub fn refresh_if_monthly_due(now_ms: i64) -> bool {
    let Some(datetime) = Local.timestamp_millis_opt(now_ms).single() else {
        return false;
    };
    let this_month = datetime.year() as u32 * 12 + datetime.month();
    if datetime.day() != 1 {
        return false;
    }
    match last_auto_month().compare_exchange(0, this_month, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => true,
        Err(previous) if previous != this_month => {
            last_auto_month().store(this_month, Ordering::SeqCst);
            true
        }
        Err(_) => false,
    }
}
