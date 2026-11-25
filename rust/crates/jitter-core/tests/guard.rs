use chrono::{Local, NaiveDate, TimeZone};
use jitter_core::guard::{
    evaluate_host_guard, evaluate_local_guard, has_host_conditions, has_local_conditions,
    ip_matches_any, ip_matches_pattern, local_guard_of, parse_day_type, parse_ip_pattern,
    parse_time_range, parse_weekdays, DayType, HostGuardConfig, LocalGuardConfig,
};
use jitter_core::host::{NetworkConnection, NetworkKind};
use serde_json::json;

/// 本地时间助手。
fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    let date = NaiveDate::from_ymd_opt(year, month, day).expect("valid date");
    Local
        .from_local_datetime(&date.and_hms_opt(hour, minute, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis()
}

fn guard_with(
    weekdays: Option<Vec<i64>>,
    time_start: Option<&str>,
    time_end: Option<&str>,
) -> LocalGuardConfig {
    LocalGuardConfig {
        weekdays,
        time_start: time_start.map(str::to_string),
        time_end: time_end.map(str::to_string),
        day_type: None,
    }
}

fn guard() -> LocalGuardConfig {
    guard_with(None, None, None)
}

#[test]
fn parse_weekdays_accepts_arrays_and_comma_strings() {
    assert_eq!(
        parse_weekdays(Some(&json!([1, 2, 3]))).expect("ok"),
        Some(vec![1, 2, 3])
    );
    assert_eq!(
        parse_weekdays(Some(&json!("3,1,3"))).expect("ok"),
        Some(vec![1, 3])
    );
    assert_eq!(
        parse_weekdays(Some(&json!("0,6"))).expect("ok"),
        Some(vec![0, 6])
    );
}

#[test]
fn empty_weekdays_mean_no_restriction() {
    assert_eq!(parse_weekdays(None).expect("ok"), None);
    assert_eq!(parse_weekdays(Some(&json!(""))).expect("ok"), None);
    assert_eq!(parse_weekdays(Some(&json!([]))).expect("ok"), None);
}

#[test]
fn parse_weekdays_rejects_out_of_range_or_non_numeric_values() {
    assert!(parse_weekdays(Some(&json!([7]))).is_err());
    assert!(parse_weekdays(Some(&json!([-1]))).is_err());
    assert!(parse_weekdays(Some(&json!("mon"))).is_err());
}

#[test]
fn both_empty_time_range_means_no_restriction() {
    assert_eq!(
        parse_time_range(Some(&json!("")), Some(&json!(""))).expect("ok"),
        None
    );
    assert_eq!(parse_time_range(None, None).expect("ok"), None);
}

#[test]
fn time_range_requires_both_sides_and_a_valid_format() {
    assert!(parse_time_range(Some(&json!("09:00")), Some(&json!(""))).is_err());
    assert!(parse_time_range(Some(&json!("9:00")), Some(&json!("18:00"))).is_err());
    assert!(parse_time_range(Some(&json!("09:00")), Some(&json!("24:00"))).is_err());
    assert!(parse_time_range(Some(&json!("09:00")), Some(&json!("09:00"))).is_err());
}

#[test]
fn time_range_accepts_a_cross_midnight_range() {
    assert_eq!(
        parse_time_range(Some(&json!("22:00")), Some(&json!("02:00"))).expect("ok"),
        Some(("22:00".to_string(), "02:00".to_string()))
    );
}

#[test]
fn local_guard_of_reads_a_valid_configuration() {
    let config = local_guard_of(Some("1,3,5"), Some("09:00"), Some("18:00"), None);
    assert_eq!(config.weekdays, Some(vec![1, 3, 5]));
    assert_eq!(config.time_start.as_deref(), Some("09:00"));
    assert_eq!(config.time_end.as_deref(), Some("18:00"));
}

#[test]
fn local_guard_of_treats_junk_as_no_restriction() {
    let config = local_guard_of(Some("x,9"), Some("bad"), Some("18:00"), None);
    assert_eq!(config, LocalGuardConfig::default());
    assert_eq!(
        local_guard_of(None, None, None, None),
        LocalGuardConfig::default()
    );
}

#[test]
fn parse_day_type_accepts_only_known_values() {
    assert_eq!(parse_day_type(Some(&json!("workday"))).expect("ok"), Some(DayType::Workday));
    assert_eq!(parse_day_type(Some(&json!("offday"))).expect("ok"), Some(DayType::Offday));
    assert_eq!(parse_day_type(Some(&json!(""))).expect("ok"), None);
    assert_eq!(parse_day_type(Some(&json!(null))).expect("ok"), None);
    assert!(parse_day_type(Some(&json!("holiday"))).is_err());
}

/// 测试注入：把某年固定为指定的放假 / 调休数据，写进数据库供判断懒加载。
/// 数据库是进程级单例：返回的 guard 要由调用方持有到测试结束，
/// 否则其它测试中途 init_db 切库会让本次读不到刚写入的数据。
static DB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn with_mock_year(year: i32, days: &[(&str, bool)]) -> std::sync::MutexGuard<'static, ()> {
    let guard = DB_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = std::env::temp_dir().join(format!("jitter-guard-holiday-{year}"));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("app.db").to_string_lossy().to_string();
    let raw = serde_json::json!({
        "year": year,
        "days": days.iter()
            .map(|(date, is_off)| serde_json::json!({"date": date, "isOffDay": is_off}))
            .collect::<Vec<_>>(),
    })
    .to_string();
    let _ = jitter_core::db::init_db(Some(&path));
    jitter_core::db::upsert_holiday_year(year, &raw, 0, days.len() as i64).expect("upsert");
    guard
}

#[test]
fn no_conditions_always_passes() {
    let verdict = evaluate_local_guard(&guard(), at(2026, 1, 5, 10, 30));
    assert!(verdict.passed);
    assert!(verdict.reason.contains("未设置本地条件"));
    assert!(!has_local_conditions(&guard()));
}

#[test]
fn weekday_allow_list_passes_and_blocks() {
    // 2026-01-05 是周一。
    assert!(
        evaluate_local_guard(
            &guard_with(Some(vec![1]), None, None),
            at(2026, 1, 5, 10, 30)
        )
        .passed
    );
    let blocked = evaluate_local_guard(
        &guard_with(Some(vec![2, 3]), None, None),
        at(2026, 1, 5, 10, 30),
    );
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("周一"));
}

#[test]
fn time_range_passes_inside_and_blocks_outside() {
    let range = guard_with(None, Some("09:00"), Some("18:00"));
    assert!(evaluate_local_guard(&range, at(2026, 1, 5, 9, 0)).passed);
    assert!(evaluate_local_guard(&range, at(2026, 1, 5, 17, 59)).passed);
    assert!(!evaluate_local_guard(&range, at(2026, 1, 5, 18, 0)).passed);
    let blocked = evaluate_local_guard(&range, at(2026, 1, 5, 8, 59));
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("09:00–18:00"));
}

#[test]
fn a_cross_midnight_range_belongs_to_the_day_it_started_on() {
    let overnight = guard_with(None, Some("22:00"), Some("02:00"));
    // 周二 00:30 是周一 22:00–02:00 实例的尾巴。
    let monday_only = LocalGuardConfig {
        weekdays: Some(vec![1]),
        ..overnight.clone()
    };
    assert!(evaluate_local_guard(&monday_only, at(2026, 1, 6, 0, 30)).passed);

    let tuesday_only = LocalGuardConfig {
        weekdays: Some(vec![2]),
        ..overnight.clone()
    };
    assert!(!evaluate_local_guard(&tuesday_only, at(2026, 1, 6, 0, 30)).passed);

    // 03:00 完全在跨午夜时段之外。
    assert!(!evaluate_local_guard(&monday_only, at(2026, 1, 6, 3, 0)).passed);
}

#[test]
fn both_conditions_must_pass() {
    let config = guard_with(Some(vec![1]), Some("09:00"), Some("18:00"));
    assert!(evaluate_local_guard(&config, at(2026, 1, 5, 10, 0)).passed);
    assert!(!evaluate_local_guard(&config, at(2026, 1, 5, 20, 0)).passed);
    assert!(!evaluate_local_guard(&config, at(2026, 1, 6, 10, 0)).passed);
}

#[test]
fn workday_condition_blocks_listed_holidays() {
    // 2026-05-01（周五）在 mock 数据里是放假的法定节假日。
    let _lock = with_mock_year(2026, &[("2026-05-01", true)]);
    let workday_only = LocalGuardConfig {
        day_type: Some(DayType::Workday),
        ..guard()
    };
    let blocked = evaluate_local_guard(&workday_only, at(2026, 5, 1, 10, 0));
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("休息日"));
    // 5 月 4 日（周一）不在数据里：默认工作日，放行。
    assert!(evaluate_local_guard(&workday_only, at(2026, 5, 4, 10, 0)).passed);
}

#[test]
fn offday_condition_blocks_regular_workdays() {
    // 2027-06-05（周六）在 mock 数据里是放假的休息日。
    let _lock = with_mock_year(2027, &[("2027-06-05", true)]);
    let offday_only = LocalGuardConfig {
        day_type: Some(DayType::Offday),
        ..guard()
    };
    assert!(evaluate_local_guard(&offday_only, at(2027, 6, 5, 10, 0)).passed);
    // 6 月 4 日（周五）是普通工作日，不满足「仅休息日」。
    let blocked = evaluate_local_guard(&offday_only, at(2027, 6, 4, 10, 0));
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("工作日"));
}

#[test]
fn missing_holiday_data_skips_the_day_type_condition() {
    // 2099 年没有任何数据：无法判断时跳过该条件（视为通过）并在原因中说明。
    let workday_only = LocalGuardConfig {
        day_type: Some(DayType::Workday),
        ..guard()
    };
    let verdict = evaluate_local_guard(&workday_only, at(2099, 3, 10, 10, 0));
    assert!(verdict.passed);
    assert!(verdict.reason.contains("已跳过"));
}

#[test]
fn day_type_counts_as_a_local_condition() {
    let config = LocalGuardConfig {
        day_type: Some(DayType::Workday),
        ..guard()
    };
    assert!(has_local_conditions(&config));
}

#[test]
fn ip_pattern_accepts_wildcards_and_multiple_groups() {
    assert_eq!(
        parse_ip_pattern(Some(&json!(" 10.1.* , 192.168.* "))).expect("ok"),
        Some("10.1.*,192.168.*".to_string())
    );
    assert_eq!(parse_ip_pattern(Some(&json!(""))).expect("ok"), None);
    assert_eq!(parse_ip_pattern(None).expect("ok"), None);
    assert!(parse_ip_pattern(Some(&json!("10.1.abc"))).is_err());
    assert!(parse_ip_pattern(Some(&json!("..."))).is_err());
    // 空白不分组，避免 "10.1. *" 被拆成两个模式后匹配所有 IP。
    assert!(parse_ip_pattern(Some(&json!("10.1. *"))).is_err());
    assert_eq!(
        parse_ip_pattern(Some(&json!("10.1.*,,192.168.*"))).expect("ok"),
        Some("10.1.*,192.168.*".to_string())
    );
}

#[test]
fn ip_wildcard_matches_digits_and_dots() {
    assert!(ip_matches_pattern("10.1.22.5", "10.1.*"));
    assert!(ip_matches_pattern("10.1.22.5", "10.*"));
    assert!(ip_matches_pattern("10.1.22.5", "*"));
    assert!(ip_matches_pattern("10.1.22.5", "*.5"));
    assert!(!ip_matches_pattern("10.1.22.5", "10.2.*"));
    assert!(!ip_matches_pattern("10.1.22.5", "10.1.22"));
    assert!(ip_matches_any("192.168.1.9", "10.1.*,192.168.*"));
    assert!(!ip_matches_any("172.16.0.2", "10.1.*,192.168.*"));
}

#[test]
fn host_guard_requires_ac_power_when_configured() {
    let config = HostGuardConfig {
        require_ac_power: true,
        require_network: false,
        ip_pattern: None,
    };
    assert!(has_host_conditions(&config));
    assert!(evaluate_host_guard(&config, Some(true), &[], &[]).passed);
    let battery = evaluate_host_guard(&config, Some(false), &[], &[]);
    assert!(!battery.passed);
    assert!(battery.reason.contains("电池"));
    let unknown = evaluate_host_guard(&config, None, &[], &[]);
    assert!(!unknown.passed);
    assert!(unknown.reason.contains("无法获取电源状态"));
}

#[test]
fn host_guard_checks_any_local_ip_against_pattern() {
    let config = HostGuardConfig {
        require_ac_power: false,
        require_network: false,
        ip_pattern: Some("10.1.*".to_string()),
    };
    let ips = vec!["172.30.228.138".to_string(), "10.1.22.5".to_string()];
    let verdict = evaluate_host_guard(&config, Some(true), &ips, &[]);
    assert!(verdict.passed);
    assert!(verdict.reason.contains("10.1.22.5"));

    let blocked = evaluate_host_guard(&config, Some(true), &["192.168.1.2".to_string()], &[]);
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("不匹配"));

    let empty = evaluate_host_guard(&config, Some(true), &[], &[]);
    assert!(!empty.passed);
    assert!(empty.reason.contains("未能读取本机 IP"));
}

#[test]
fn host_guard_without_configuration_always_passes() {
    let config = HostGuardConfig::default();
    assert!(!has_host_conditions(&config));
    assert!(evaluate_host_guard(&config, None, &[], &[]).passed);
}

/// 「已连接网络」：WiFi 或网线任一满足即可（条件内部是「或」）。
#[test]
fn host_guard_requires_network() {
    let config = HostGuardConfig {
        require_ac_power: false,
        require_network: true,
        ip_pattern: None,
    };
    assert!(has_host_conditions(&config));

    // 没有可用网卡 → 不通过。
    let offline = evaluate_host_guard(&config, Some(true), &[], &[]);
    assert!(!offline.passed);
    assert!(offline.reason.contains("未连接网络"));

    // 连着 WiFi → 通过。
    let wifi = vec![NetworkConnection {
        name: "WLAN".to_string(),
        kind: NetworkKind::Wifi,
    }];
    let verdict = evaluate_host_guard(&config, Some(true), &[], &wifi);
    assert!(verdict.passed);
    assert!(verdict.reason.contains("已连接网络"));
    assert!(verdict.reason.contains("WiFi"));

    // 插着网线 → 同样通过。
    let ethernet = vec![NetworkConnection {
        name: "以太网".to_string(),
        kind: NetworkKind::Ethernet,
    }];
    let wired = evaluate_host_guard(&config, Some(true), &[], &ethernet);
    assert!(wired.passed);
    assert!(wired.reason.contains("以太网"));
}

/// 环境条件之间是「与」：电源、网络、本机 IP 任意一个不满足就不执行。
#[test]
fn host_guard_conditions_are_conjunctive() {
    let config = HostGuardConfig {
        require_ac_power: true,
        require_network: true,
        ip_pattern: Some("10.1.*".to_string()),
    };
    let wifi = vec![NetworkConnection {
        name: "WLAN".to_string(),
        kind: NetworkKind::Wifi,
    }];
    let ips = vec!["10.1.22.5".to_string()];

    // 全部满足 → 通过。
    let ok = evaluate_host_guard(&config, Some(true), &ips, &wifi);
    assert!(ok.passed);
    assert!(ok.reason.contains("已接通电源"));
    assert!(ok.reason.contains("已连接网络"));
    assert!(ok.reason.contains("本机 IP"));

    // 电源不满足 → 不通过（哪怕网络和 IP 都对）。
    let no_power = evaluate_host_guard(&config, Some(false), &ips, &wifi);
    assert!(!no_power.passed);
    assert!(no_power.reason.contains("电池"));

    // 网络不满足 → 不通过（哪怕电源和 IP 都对）。
    let no_network = evaluate_host_guard(&config, Some(true), &ips, &[]);
    assert!(!no_network.passed);
    assert!(no_network.reason.contains("未连接网络"));

    // IP 不匹配 → 不通过（哪怕电源和网络都对）。
    let bad_ip = evaluate_host_guard(&config, Some(true), &["192.168.1.2".to_string()], &wifi);
    assert!(!bad_ip.passed);
    assert!(bad_ip.reason.contains("不匹配"));
}

/// 调休上班日通常落在周末：必须按工作日处理，这是「仅工作日」最容易错的点。
#[test]
fn makeup_workday_on_weekend_counts_as_workday() {
    // 2030-01-01 是周二 → 01-05 周六（调休上班），01-06 周日（正常休息）。
    let _lock = with_mock_year(2030, &[("2030-01-05", false), ("2030-01-06", true)]);

    let workday = LocalGuardConfig {
        day_type: Some(DayType::Workday),
        ..guard()
    };
    let offday = LocalGuardConfig {
        day_type: Some(DayType::Offday),
        ..guard()
    };

    // 周六但调休上班 → 满足「仅工作日」。
    assert!(evaluate_local_guard(&workday, at(2030, 1, 5, 10, 0)).passed);
    // 同一个周六不满足「仅休息日」。
    let blocked = evaluate_local_guard(&offday, at(2030, 1, 5, 10, 0));
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("工作日"));

    // 周日不在调休列表 → 休息日。
    assert!(evaluate_local_guard(&offday, at(2030, 1, 6, 10, 0)).passed);
    assert!(!evaluate_local_guard(&workday, at(2030, 1, 6, 10, 0)).passed);
}

/// 跨午夜窗口按「开始那天」判断工作日/休息日：0 点后仍算前一天。
#[test]
fn cross_midnight_window_uses_start_day_for_day_type() {
    // 2032-01-02 是周五（工作日），2032-01-03 是周六（休息日）。
    // 用独立的年份，避免和上面 mock 的 2030 数据互相污染缓存。
    let _lock = with_mock_year(2032, &[]);

    let workday = LocalGuardConfig {
        time_start: Some("22:00".into()),
        time_end: Some("02:00".into()),
        day_type: Some(DayType::Workday),
        ..guard()
    };
    let offday = LocalGuardConfig {
        time_start: Some("22:00".into()),
        time_end: Some("02:00".into()),
        day_type: Some(DayType::Offday),
        ..guard()
    };

    // 周六 00:30 仍属于周五 22:00 开出的窗口 → 按周五（工作日）判定。
    assert!(evaluate_local_guard(&workday, at(2032, 1, 3, 0, 30)).passed);
    assert!(!evaluate_local_guard(&offday, at(2032, 1, 3, 0, 30)).passed);

    // 周六 23:00 是周六自己的窗口 → 休息日。
    assert!(!evaluate_local_guard(&workday, at(2032, 1, 3, 23, 0)).passed);
    assert!(evaluate_local_guard(&offday, at(2032, 1, 3, 23, 0)).passed);
}

