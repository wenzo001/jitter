use chrono::{Local, NaiveDate, TimeZone};
use serde_json::json;

use jitter_core::schedule::*;
use jitter_core::window::{start_of_local_day, PauseInterval};

const SECOND: i64 = 1000;
const MINUTE: i64 = 60 * SECOND;

/// 本地时间助手（锚定间隔用例）。
fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    let date = NaiveDate::from_ymd_opt(year, month, day).expect("valid date");
    Local
        .from_local_datetime(&date.and_hms_opt(hour, minute, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis()
}

/// 2026-01-05 10:30:15.400 本地时间。
fn now() -> i64 {
    let date = NaiveDate::from_ymd_opt(2026, 1, 5).expect("valid date");
    let naive = date.and_hms_opt(10, 30, 15).expect("valid time") + chrono::Duration::milliseconds(400);
    Local
        .from_local_datetime(&naive)
        .earliest()
        .expect("valid local time")
        .timestamp_millis()
}

fn map(fields: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    fields.as_object().expect("object").clone()
}

fn interval_spec(seconds: i64, jitter: i64) -> ScheduleSpec {
    build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": seconds,
        "interval_jitter_seconds": jitter,
    })))
    .expect("valid schedule")
}

fn fixed(value: f64) -> impl FnMut() -> f64 {
    move || value
}

#[test]
fn daily_keeps_the_historical_window_rules() {
    let spec = build_schedule(&map(json!({
        "window_start": "23:50",
        "window_end": "00:10",
    })))
    .expect("valid schedule");
    assert_eq!(spec.kind, ScheduleKind::Daily);
    let window = spec.window.expect("window");
    assert!(window.cross_midnight);
}

#[test]
fn daily_rejects_invalid_windows_but_accepts_an_exact_time() {
    assert!(build_schedule(&map(json!({
        "window_start": "25:00",
        "window_end": "10:00",
    })))
    .is_err());

    let exact = build_schedule(&map(json!({
        "window_start": "10:00",
        "window_end": "10:00",
    })))
    .expect("valid schedule");
    assert_eq!(exact.exact_time.as_deref(), Some("10:00"));
    assert!(exact.window.expect("window").instant);
}

#[test]
fn daily_validates_the_jitter() {
    let jittered = build_schedule(&map(json!({
        "window_start": "10:00",
        "window_end": "10:00",
        "daily_jitter_minutes": 5,
    })))
    .expect("valid schedule");
    assert_eq!(jittered.jitter_minutes, 5);
    // ±5 把瞬时窗口变成一个真正的 10 分钟窗口。
    let window = jittered.window.expect("window");
    assert_eq!(window.start, "09:55");
    assert_eq!(window.end, "10:05");
    assert!(!window.instant);

    assert!(build_schedule(&map(json!({
        "window_start": "10:00",
        "window_end": "10:00",
        "daily_jitter_minutes": 61,
    })))
    .is_err());
    assert!(build_schedule(&map(json!({
        "window_start": "10:00",
        "window_end": "10:00",
        "daily_jitter_minutes": -1,
    })))
    .is_err());
    // 没有精确时间的抖动没有意义。
    assert!(build_schedule(&map(json!({
        "window_start": "09:00",
        "window_end": "10:00",
        "daily_jitter_minutes": 5,
    })))
    .is_err());
}

#[test]
fn interval_accepts_seconds_and_jitter() {
    let spec = interval_spec(90, 10);
    assert_eq!(spec.kind, ScheduleKind::Interval);
    assert_eq!(spec.interval_seconds, Some(90));
    assert_eq!(spec.interval_jitter_seconds, 10);
}

#[test]
fn interval_rejects_out_of_range_and_oversized_jitter() {
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": 0,
    })))
    .is_err());
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": 40 * 86400,
    })))
    .is_err());
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": 10,
        "interval_jitter_seconds": 11,
    })))
    .is_err());
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": "abc",
    })))
    .is_err());
}

#[test]
fn cron_is_no_longer_a_valid_schedule_kind() {
    assert!(build_schedule(&map(json!({ "schedule_kind": "cron" }))).is_err());
}

#[test]
fn an_unknown_schedule_kind_is_rejected() {
    assert!(build_schedule(&map(json!({ "schedule_kind": "weekly" }))).is_err());
}

fn stored(fields: serde_json::Value) -> StoredSchedule {
    let object = fields.as_object().expect("object");
    let get_string = |key: &str| object.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let get_int = |key: &str| object.get(key).and_then(|v| v.as_i64());
    StoredSchedule {
        schedule_kind: get_string("schedule_kind"),
        window_start: get_string("window_start"),
        window_end: get_string("window_end"),
        daily_jitter_minutes: get_int("daily_jitter_minutes"),
        interval_seconds: get_int("interval_seconds"),
        interval_jitter_seconds: get_int("interval_jitter_seconds"),
        interval_start_at: get_int("interval_start_at"),
    }
}

#[test]
fn legacy_rows_are_daily() {
    let spec = schedule_of(&stored(json!({
        "schedule_kind": null,
        "window_start": "10:10",
        "window_end": "10:20",
    })))
    .expect("valid schedule");
    assert_eq!(spec.kind, ScheduleKind::Daily);
    assert_eq!(spec.window.expect("window").start, "10:10");
}

#[test]
fn interval_rows_are_rebuilt_from_their_columns() {
    let spec = schedule_of(&stored(json!({
        "schedule_kind": "interval",
        "interval_seconds": 120,
        "interval_jitter_seconds": 5,
    })))
    .expect("valid schedule");
    assert_eq!(spec.interval_seconds, Some(120));
    assert_eq!(spec.interval_jitter_seconds, 5);
}

#[test]
fn first_run_is_one_interval_after_now() {
    let moment = now();
    assert_eq!(
        plan_schedule_new(moment, &interval_spec(30, 0), None, &mut fixed(0.0)).expect("plan"),
        moment + 30 * SECOND
    );
}

#[test]
fn jitter_adds_seconds_deterministically() {
    let moment = now();
    assert_eq!(
        plan_schedule_new(moment, &interval_spec(30, 10), None, &mut fixed(0.0)).expect("plan"),
        moment + 30 * SECOND
    );
    assert_eq!(
        plan_schedule_new(moment, &interval_spec(30, 10), None, &mut fixed(0.5)).expect("plan"),
        moment + 35 * SECOND
    );
}

#[test]
fn the_next_run_stays_anchored_on_the_scheduled_grid() {
    let moment = now();
    let target = moment;
    // 请求在刻度后 200ms 完成：网格不能漂移。
    assert_eq!(
        plan_schedule_after(moment + 200, &interval_spec(30, 0), target, None, &mut fixed(0.0))
            .expect("plan"),
        moment + 30 * SECOND
    );
}

#[test]
fn a_request_that_overruns_the_next_tick_restarts_the_grid() {
    let moment = now();
    let target = moment;
    let finished = moment + 40 * SECOND;
    assert_eq!(
        plan_schedule_after(finished, &interval_spec(30, 0), target, None, &mut fixed(0.0))
            .expect("plan"),
        finished + 30 * SECOND
    );
}

#[test]
fn a_pause_skips_whole_local_days() {
    let moment = now();
    let pause = PauseInterval {
        from: start_of_local_day(moment, 0),
        until: start_of_local_day(moment, 2),
    };
    let target = plan_schedule_new(moment, &interval_spec(3600, 0), Some(pause), &mut fixed(0.0))
        .expect("plan");
    assert!(target >= pause.until);
}

#[test]
fn a_pause_starting_tomorrow_keeps_todays_run() {
    let moment = now();
    let pause = PauseInterval {
        from: start_of_local_day(moment, 1),
        until: start_of_local_day(moment, 3),
    };
    assert_eq!(
        plan_schedule_new(moment, &interval_spec(3600, 0), Some(pause), &mut fixed(0.0))
            .expect("plan"),
        moment + 3600 * SECOND
    );
}

#[test]
fn preview_of_a_daily_schedule_lists_window_starts() {
    let moment = now();
    let spec = build_schedule(&map(json!({
        "window_start": "09:00",
        "window_end": "09:30",
    })))
    .expect("valid schedule");
    let preview = preview_schedule(&spec, moment, 2);
    assert_eq!(preview.next.len(), 2);
    assert!(preview.description.contains("每天"));
}

#[test]
fn preview_of_an_interval_lists_evenly_spaced_moments() {
    let moment = now();
    let preview = preview_schedule(&interval_spec(300, 0), moment, 3);
    assert_eq!(
        preview.next,
        vec![moment + 300 * SECOND, moment + 600 * SECOND, moment + 900 * SECOND]
    );
    assert_eq!(preview.description, "每 5 分钟");
}

#[test]
fn short_intervals_tolerate_at_least_five_seconds() {
    assert_eq!(schedule_lateness_tolerance(&interval_spec(1, 0)), 5 * SECOND);
}

#[test]
fn long_intervals_cap_at_sixty_seconds() {
    assert_eq!(schedule_lateness_tolerance(&interval_spec(3600, 0)), 60 * SECOND);
    assert_eq!(schedule_lateness_tolerance(&interval_spec(86400, 0)), 60 * SECOND);
}

#[test]
fn classifies_late_ticks() {
    let moment = now();
    let spec = interval_spec(60, 0);
    assert!(!is_missed_non_daily(moment, moment - 1000, &spec));
    assert!(is_missed_non_daily(moment, moment - 5 * MINUTE, &spec));
}

#[test]
fn a_slightly_late_plan_runs_immediately() {
    let moment = now();
    let plan = plan_schedule_recovery(moment, &interval_spec(60, 0), Some(moment - 1000), None, &mut fixed(0.0))
        .expect("plan");
    assert_eq!(plan.target, moment);
    assert_eq!(plan.missed_planned_at, None);
}

#[test]
fn an_old_plan_is_recorded_as_missed() {
    let moment = now();
    let stale = moment - 3 * 3600 * 1000;
    let plan = plan_schedule_recovery(moment, &interval_spec(3600, 0), Some(stale), None, &mut fixed(0.0))
        .expect("plan");
    assert_eq!(plan.missed_planned_at, Some(stale));
    assert_eq!(plan.target, moment + 3600 * SECOND);
}

#[test]
fn a_future_plan_is_kept_as_is() {
    let moment = now();
    let future = moment + 5 * MINUTE;
    let plan = plan_schedule_recovery(moment, &interval_spec(60, 0), Some(future), None, &mut fixed(0.0))
        .expect("plan");
    assert_eq!(plan.target, future);
}

#[test]
fn describes_each_kind() {
    assert_eq!(describe_schedule(&interval_spec(30, 0)), "每 30 秒");
    assert_eq!(describe_schedule(&interval_spec(7200, 0)), "每 2 小时");
    assert!(describe_schedule(&interval_spec(60, 5)).contains("抖动"));
    assert!(describe_schedule(
        &build_schedule(&map(json!({
            "window_start": "10:00",
            "window_end": "10:10",
        })))
        .expect("valid schedule")
    )
    .contains("每天"));
}

#[test]
fn same_schedule_distinguishes_meaningful_edits_only() {
    let base = interval_spec(60, 0);
    assert!(same_schedule(&base, &interval_spec(60, 0)));
    assert!(!same_schedule(&base, &interval_spec(61, 0)));
    assert!(!same_schedule(&base, &interval_spec(60, 1)));
    assert!(!same_schedule(&base, &interval_spec(3600, 0)));
}

fn anchored(seconds: i64, start_at: i64, jitter: i64) -> ScheduleSpec {
    build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": seconds,
        "interval_jitter_seconds": jitter,
        "interval_start_at": start_at,
    })))
    .expect("valid schedule")
}

#[test]
fn stores_the_anchor_and_mentions_it_in_the_description() {
    let spec = anchored(7200, at(2026, 1, 5, 9, 0), 0);
    assert_eq!(spec.start_at, Some(at(2026, 1, 5, 9, 0)));
    assert!(describe_schedule(&spec).contains("起算"));
}

#[test]
fn rejects_an_invalid_anchor() {
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": 60,
        "interval_start_at": 0,
    })))
    .is_err());
    assert!(build_schedule(&map(json!({
        "schedule_kind": "interval",
        "interval_seconds": 60,
        "interval_start_at": -1,
    })))
    .is_err());
}

#[test]
fn a_future_anchor_becomes_the_first_run() {
    let moment = now();
    let start = at(2026, 1, 6, 9, 0);
    assert_eq!(
        plan_schedule_new(moment, &anchored(3600, start, 0), None, &mut fixed(0.0)).expect("plan"),
        start
    );
}

#[test]
fn a_past_anchor_aligns_to_the_next_grid_tick() {
    let moment = now();
    // 09:00 + 2h 网格 → 11:00 是 10:30 之后的下一个刻度。
    assert_eq!(
        plan_schedule_new(moment, &anchored(7200, at(2026, 1, 5, 9, 0), 0), None, &mut fixed(0.0))
            .expect("plan"),
        at(2026, 1, 5, 11, 0)
    );
}

#[test]
fn the_grid_survives_a_run_that_finishes_late() {
    let spec = anchored(7200, at(2026, 1, 5, 9, 0), 0);
    let fired_at = at(2026, 1, 5, 11, 0) + 2000;
    assert_eq!(
        plan_schedule_after(fired_at, &spec, fired_at, None, &mut fixed(0.0)).expect("plan"),
        at(2026, 1, 5, 13, 0)
    );
}

#[test]
fn the_grid_survives_a_pause() {
    let moment = now();
    let spec = anchored(7200, at(2026, 1, 5, 9, 0), 0);
    let pause = PauseInterval {
        from: start_of_local_day(moment, 0),
        until: start_of_local_day(moment, 2),
    };
    let target = plan_schedule_new(moment, &spec, Some(pause), &mut fixed(0.0)).expect("plan");
    assert!(target >= pause.until);
    assert_eq!(
        (target - at(2026, 1, 5, 9, 0)) % (7200 * SECOND),
        0,
        "必须仍落在网格上"
    );
}

#[test]
fn preview_lists_the_anchored_ticks() {
    let moment = now();
    let preview = preview_schedule(&anchored(7200, at(2026, 1, 5, 9, 0), 0), moment, 3);
    assert_eq!(
        preview.next,
        vec![
            at(2026, 1, 5, 11, 0),
            at(2026, 1, 5, 13, 0),
            at(2026, 1, 5, 15, 0),
        ]
    );
}

#[test]
fn preview_without_an_anchor_keeps_counting_from_now() {
    let moment = now();
    let preview = preview_schedule(&interval_spec(60, 0), moment, 2);
    assert_eq!(preview.next, vec![moment + MINUTE, moment + 2 * MINUTE]);
}

#[test]
fn moving_the_anchor_counts_as_a_schedule_change() {
    let base = anchored(3600, at(2026, 1, 5, 9, 0), 0);
    assert!(same_schedule(
        &base,
        &anchored(3600, at(2026, 1, 5, 9, 0), 0)
    ));
    assert!(!same_schedule(
        &base,
        &anchored(3600, at(2026, 1, 5, 10, 0), 0)
    ));
    // 相同数字、不同锚点：也必须视为变更。
    assert!(!same_schedule(&interval_spec(3600, 0), &base));
}

#[test]
fn a_bogus_stored_anchor_degrades_to_from_now() {
    let spec = schedule_of(&stored(json!({
        "schedule_kind": "interval",
        "interval_seconds": 60,
        "interval_start_at": 0,
    })))
    .expect("valid schedule");
    assert_eq!(spec.start_at, None);
}

#[test]
fn a_window_that_is_still_open_is_the_first_predicted_run() {
    let moment = now();
    // NOW 是 10:30，09:00–11:00 的窗口还没关。
    let spec = build_schedule(&map(json!({
        "window_start": "09:00",
        "window_end": "11:00",
    })))
    .expect("valid schedule");
    let preview = preview_schedule(&spec, moment, 2);
    assert_eq!(preview.next[0], at(2026, 1, 5, 9, 0));
    assert_eq!(preview.next[1], at(2026, 1, 6, 9, 0));
}

#[test]
fn a_closed_window_rolls_over_to_tomorrow() {
    let moment = now();
    let spec = build_schedule(&map(json!({
        "window_start": "09:00",
        "window_end": "10:00",
    })))
    .expect("valid schedule");
    let preview = preview_schedule(&spec, moment, 1);
    assert_eq!(preview.next[0], at(2026, 1, 6, 9, 0));
}
