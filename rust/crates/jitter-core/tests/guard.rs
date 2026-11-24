use chrono::{Local, NaiveDate, TimeZone};
use jitter_core::guard::{
    evaluate_host_guard, evaluate_local_guard, has_host_conditions, has_local_conditions,
    ip_matches_any, ip_matches_pattern, local_guard_of, parse_ip_pattern, parse_time_range,
    parse_weekdays, HostGuardConfig, LocalGuardConfig,
};
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
    let config = local_guard_of(Some("1,3,5"), Some("09:00"), Some("18:00"));
    assert_eq!(config.weekdays, Some(vec![1, 3, 5]));
    assert_eq!(config.time_start.as_deref(), Some("09:00"));
    assert_eq!(config.time_end.as_deref(), Some("18:00"));
}

#[test]
fn local_guard_of_treats_junk_as_no_restriction() {
    let config = local_guard_of(Some("x,9"), Some("bad"), Some("18:00"));
    assert_eq!(config, LocalGuardConfig::default());
    assert_eq!(
        local_guard_of(None, None, None),
        LocalGuardConfig::default()
    );
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
        ip_pattern: None,
    };
    assert!(has_host_conditions(&config));
    assert!(evaluate_host_guard(&config, Some(true), &[]).passed);
    let battery = evaluate_host_guard(&config, Some(false), &[]);
    assert!(!battery.passed);
    assert!(battery.reason.contains("电池"));
    let unknown = evaluate_host_guard(&config, None, &[]);
    assert!(!unknown.passed);
    assert!(unknown.reason.contains("无法获取电源状态"));
}

#[test]
fn host_guard_checks_any_local_ip_against_pattern() {
    let config = HostGuardConfig {
        require_ac_power: false,
        ip_pattern: Some("10.1.*".to_string()),
    };
    let ips = vec!["172.30.228.138".to_string(), "10.1.22.5".to_string()];
    let verdict = evaluate_host_guard(&config, Some(true), &ips);
    assert!(verdict.passed);
    assert!(verdict.reason.contains("10.1.22.5"));

    let blocked = evaluate_host_guard(&config, Some(true), &["192.168.1.2".to_string()]);
    assert!(!blocked.passed);
    assert!(blocked.reason.contains("不匹配"));

    let empty = evaluate_host_guard(&config, Some(true), &[]);
    assert!(!empty.passed);
    assert!(empty.reason.contains("未能读取本机 IP"));
}

#[test]
fn host_guard_without_configuration_always_passes() {
    let config = HostGuardConfig::default();
    assert!(!has_host_conditions(&config));
    assert!(evaluate_host_guard(&config, None, &[]).passed);
}
