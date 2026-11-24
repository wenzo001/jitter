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

use chrono::{Datelike, Local, TimeZone};
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

/// 设置页展示用的年度概览。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayYearMeta {
    pub year: i32,
    pub day_count: i64,
    pub fetched_at: i64,
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
    let data = match {
        let map = cache().read().ok()?;
        map.get(&year).cloned()
    } {
        Some(data) => data,
        None => load_year_from_db(year)?,
    };
    let date = format!("{:04}-{:02}-{:02}", datetime.year(), datetime.month(), datetime.day());
    if let Some(day) = data.days.iter().find(|day| day.date == date) {
        return Some(day.is_off_day);
    }
    // 列表外的日期按星期判断。
    use chrono::Weekday;
    Some(matches!(datetime.weekday(), Weekday::Sat | Weekday::Sun))
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

/// 设置页展示：数据库里缓存了哪些年份。
pub fn list_years() -> Vec<HolidayYearMeta> {
    crate::db::list_holiday_years()
        .unwrap_or_default()
        .into_iter()
        .map(|(year, days, fetched_at)| HolidayYearMeta {
            year,
            day_count: parse_year(&days)
                .map(|data| data.days.len() as i64)
                .unwrap_or(0),
            fetched_at,
        })
        .collect()
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
