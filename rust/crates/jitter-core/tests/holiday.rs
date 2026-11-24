//! holiday 数据解析与判断的单元测试。
use jitter_core::holiday::{parse_year_public, HolidayYear};

#[test]
fn parses_official_payload() {
    let raw = r#"{
      "year": 2026,
      "days": [
        {"name": "元旦", "date": "2026-01-01", "isOffDay": true},
        {"name": "春节后调休上班", "date": "2026-02-07", "isOffDay": false}
      ]
    }"#;
    let data = parse_year_public(raw).expect("parse");
    assert_eq!(data.year, 2026);
    assert_eq!(data.days.len(), 2);
    assert!(data.days[0].is_off_day);
    assert!(!data.days[1].is_off_day);
    assert_eq!(data.days[0].date, "2026-01-01");
}

/// 存取往返：入库格式（序列化 HolidayYear）再解析，is_off_day 不能丢。
/// （回归：字段名 is_off_day 序列化后解析端找不到 isOffDay，数据全变空。）
#[test]
fn storage_roundtrip_keeps_is_off_day() {
    let data = HolidayYear {
        year: 2026,
        days: vec![
            jitter_core::holiday::HolidayDay {
                name: "元旦".into(),
                date: "2026-01-01".into(),
                is_off_day: true,
            },
            jitter_core::holiday::HolidayDay {
                name: "调休上班".into(),
                date: "2026-02-07".into(),
                is_off_day: false,
            },
        ],
    };
    let raw = serde_json::to_string(&data).expect("serialize");
    let parsed = parse_year_public(&raw).expect("re-parse");
    assert_eq!(parsed.days.len(), 2);
    assert!(parsed.days[0].is_off_day);
    assert!(!parsed.days[1].is_off_day);
}

#[test]
fn rejects_missing_year_or_days() {
    assert!(parse_year_public(r#"{"days": []}"#).is_err());
    assert!(parse_year_public(r#"{"year": 2026}"#).is_err());
    assert!(parse_year_public("not json").is_err());
}
