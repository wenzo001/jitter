//! fetch_year 网络路径验证（需要网络；失败不阻塞 CI，仅打印诊断信息）。
use jitter_core::holiday;

#[tokio::test(flavor = "multi_thread")]
async fn fetch_year_returns_days() {
    let result = holiday::fetch_year_public(2026).await;
    match result {
        Ok(data) => {
            println!("year={} days={}", data.year, data.days.len());
            for day in data.days.iter().take(3) {
                println!("  {} {} {}", day.name, day.date, day.is_off_day);
            }
            assert!(!data.days.is_empty(), "holiday-cn 2026 应有数据");
        }
        Err(error) => {
            println!("fetch failed: {error}");
            // 网络不可用时不让测试失败（CI / 离线环境）。
        }
    }
}

/// 官方数据核对三年口径（放假天数 / 调休上班天数）。
/// 2025：28 + 5，2026：33 + 6，2027：29 + 5。
#[tokio::test(flavor = "multi_thread")]
async fn official_counts_match_expected() {
    for (year, expected_off, expected_makeup) in [(2025, 28, 5), (2026, 33, 6), (2027, 29, 5)] {
        match holiday::fetch_year_public(year).await {
            Ok(data) => {
                let off = data.days.iter().filter(|day| day.is_off_day).count();
                let makeup = data.days.iter().filter(|day| !day.is_off_day).count();
                println!("{year}: off={off} makeup={makeup}");
                assert_eq!(off, expected_off, "{year} 年放假天数");
                assert_eq!(makeup, expected_makeup, "{year} 年调休上班天数");
            }
            Err(error) => println!("skip {year}: {error}"),
        }
    }
}

/// 真实数据端到端：周末的调休上班日必须判为「上班」，春节假期判为「休息」。
#[tokio::test(flavor = "multi_thread")]
async fn official_makeup_weekend_is_workday() {
    let data = match holiday::fetch_year_public(2026).await {
        Ok(data) => data,
        Err(error) => {
            println!("skip: {error}");
            return;
        }
    };

    let dir = std::env::temp_dir().join("jitter-holiday-real-2026");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("app.db").to_string_lossy().to_string();
    jitter_core::db::init_db(Some(&path)).expect("init db");
    let raw = serde_json::to_string(&data).expect("serialize");
    jitter_core::db::upsert_holiday_year(2026, &raw, 0, data.days.len() as i64).expect("upsert");

    // 2026-02-14 是周六，但被调休上班。
    assert_eq!(holiday::is_off_day(at(2026, 2, 14, 10, 0)), Some(false));
    // 2026-02-15 是周日且不在调休列表 → 休息。
    assert_eq!(holiday::is_off_day(at(2026, 2, 15, 10, 0)), Some(true));
    // 2026-02-17 在春节假期内 → 休息。
    assert_eq!(holiday::is_off_day(at(2026, 2, 17, 10, 0)), Some(true));
}

fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    use chrono::{Local, NaiveDate, TimeZone};
    let date = NaiveDate::from_ymd_opt(year, month, day).expect("valid date");
    Local
        .from_local_datetime(&date.and_hms_opt(hour, minute, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis()
}
