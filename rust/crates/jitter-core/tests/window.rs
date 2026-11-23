use chrono::{Local, NaiveDate, TimeZone};
use jitter_core::window::*;

fn at(day: u32, hour: u32, minute: u32) -> i64 {
    let base = NaiveDate::from_ymd_opt(2026, 11, 1).expect("valid base date");
    let date = base + chrono::Days::new(day as u64 - 1);
    Local
        .from_local_datetime(&date.and_hms_opt(hour, minute, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis()
}

fn fixed(value: f64) -> impl FnMut() -> f64 {
    move || value
}

#[test]
fn parses_a_same_day_window() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(spec.duration_minutes, 10);
    assert!(!spec.cross_midnight);
}

#[test]
fn parses_a_cross_midnight_window_as_its_total_duration() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(spec.duration_minutes, 20);
    assert!(spec.cross_midnight);
}

#[test]
fn rejects_invalid_formats_but_treats_equal_endpoints_as_an_exact_time() {
    assert!(validate_window("24:00", "10:00")
        .unwrap_or_default()
        .contains("HH:mm"));
    assert_eq!(validate_window("10:20", "10:10"), None);
    assert_eq!(validate_window("10:00", "10:00"), None);
    assert!(parse_window("10:00", "10:00").expect("valid window").instant);
}

#[test]
fn finds_an_instance_that_started_today() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    let instance = window_instance_at(at(6, 23, 55), &spec).expect("instance");
    assert_eq!(instance.start, at(6, 23, 50));
    assert_eq!(instance.end, at(7, 0, 10));
}

#[test]
fn finds_the_previous_days_instance_after_midnight() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    let instance = window_instance_at(at(7, 0, 5), &spec).expect("instance");
    assert_eq!(instance.start, at(6, 23, 50));
    assert_eq!(instance.end, at(7, 0, 10));
}

#[test]
fn returns_null_outside_the_window() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    assert!(window_instance_at(at(7, 0, 20), &spec).is_none());
}

#[test]
fn handles_a_same_day_window() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    let instance = window_instance_at(at(6, 10, 15), &spec).expect("instance");
    assert_eq!(instance.start, at(6, 10, 10));
    assert_eq!(instance.end, at(6, 10, 20));
    assert!(window_instance_at(at(6, 10, 20), &spec).is_none());
}

#[test]
fn random_point_respects_half_open_bounds() {
    assert_eq!(random_point(100, 200, &mut fixed(0.0)), 100);
    assert_eq!(random_point(100, 200, &mut fixed(0.5)), 150);
    assert_eq!(random_point(100, 200, &mut fixed(0.999999)), 199);
}

#[test]
fn plans_todays_window_when_before_it() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(plan_new_task(at(6, 9, 0), &spec, &mut fixed(0.0)), at(6, 10, 10));
}

#[test]
fn plans_the_remaining_window_when_already_inside_it() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(
        plan_new_task(at(6, 10, 15), &spec, &mut fixed(0.0)),
        at(6, 10, 15)
    );
    assert_eq!(
        plan_new_task(at(6, 10, 15), &spec, &mut fixed(0.5)),
        at(6, 10, 17) + 30_000
    );
}

#[test]
fn plans_tomorrow_after_the_window_has_ended() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(
        plan_new_task(at(6, 10, 30), &spec, &mut fixed(0.0)),
        at(7, 10, 10)
    );
}

#[test]
fn plans_the_next_instance_after_a_completed_run() {
    let same = parse_window("10:10", "10:20").expect("valid window");
    let cross = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        plan_next_window_after(at(6, 10, 15), &same, &mut fixed(0.0)),
        at(7, 10, 10)
    );
    assert_eq!(
        plan_next_window_after(at(6, 23, 55), &cross, &mut fixed(0.0)),
        at(7, 23, 50)
    );
}

#[test]
fn after_a_cross_midnight_run_the_next_instance_starts_on_the_same_day() {
    let cross = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        plan_next_window_after(at(7, 0, 5), &cross, &mut fixed(0.0)),
        at(7, 23, 50)
    );
}

#[test]
fn handles_crossing_midnight_before_the_start() {
    let cross = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        plan_new_task(at(6, 12, 0), &cross, &mut fixed(0.0)),
        at(6, 23, 50)
    );
    let instance = window_instance_at(at(6, 23, 59), &cross).expect("instance");
    assert_eq!(instance.start, at(6, 23, 50));
    assert_eq!(instance.end, at(7, 0, 10));
}

#[test]
fn handles_crossing_midnight_after_midnight() {
    let cross = parse_window("23:50", "00:10").expect("valid window");
    assert!(window_instance_at(at(7, 0, 5), &cross).is_some());
    assert_eq!(
        plan_new_task(at(7, 0, 5), &cross, &mut fixed(0.0)),
        at(7, 0, 5)
    );
    assert_eq!(
        plan_new_task(at(7, 0, 20), &cross, &mut fixed(0.0)),
        at(7, 23, 50)
    );
}

#[test]
fn next_window_start_after_returns_today_or_tomorrow() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(next_window_start_after(at(6, 9, 0), &spec), at(6, 10, 10));
    assert_eq!(next_window_start_after(at(6, 10, 15), &spec), at(7, 10, 10));
}

#[test]
fn recovery_keeps_a_future_next_run_at() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    let planned = at(6, 10, 15);
    let result = plan_recovery(at(6, 9, 0), Some(planned), &spec, &mut fixed(0.5));
    assert_eq!(result.target, planned);
    assert_eq!(result.missed, None);
    assert_eq!(result.reason, RecoveryReason::Future);
}

#[test]
fn recovery_re_randomizes_inside_the_current_window() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    let result = plan_recovery(at(6, 10, 15), Some(at(6, 10, 11)), &spec, &mut fixed(0.5));
    assert_eq!(result.reason, RecoveryReason::InWindow);
    assert_eq!(result.missed, None);
    assert_eq!(result.target, at(6, 10, 15) + 150_000);
}

#[test]
fn recovery_records_a_missed_previous_window_when_inside_a_new_one() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    let planned = at(6, 23, 40);
    let result = plan_recovery(at(7, 0, 5), Some(planned), &spec, &mut fixed(0.0));
    assert_eq!(result.reason, RecoveryReason::InWindow);
    assert_eq!(result.missed, Some(planned));
    assert_eq!(result.target, at(7, 0, 5));
}

#[test]
fn recovery_records_a_missed_window_and_plans_tomorrow() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    let planned = at(6, 10, 15);
    let result = plan_recovery(at(7, 0, 20), Some(planned), &spec, &mut fixed(0.0));
    assert_eq!(result.reason, RecoveryReason::Missed);
    assert_eq!(result.missed, Some(planned));
    assert_eq!(result.target, at(7, 23, 50));
}

#[test]
fn recovery_plans_today_after_a_stale_plan_from_yesterday() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    let result = plan_recovery(at(6, 9, 0), Some(at(5, 10, 15)), &spec, &mut fixed(0.0));
    assert_eq!(result.reason, RecoveryReason::Missed);
    assert_eq!(result.missed, Some(at(5, 10, 15)));
    assert_eq!(result.target, at(6, 10, 10));
}

#[test]
fn recovery_does_not_record_a_miss_when_there_was_no_plan() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    let result = plan_recovery(at(6, 9, 0), None, &spec, &mut fixed(0.0));
    assert_eq!(result.reason, RecoveryReason::NextWindow);
    assert_eq!(result.missed, None);
    assert_eq!(result.target, at(6, 10, 10));
}

#[test]
fn timer_fire_runs_while_the_same_window_is_open() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(
        classify_timer_fire(at(6, 10, 15), at(6, 10, 15), &spec),
        TimerFireVerdict::Run
    );
    assert_eq!(
        classify_timer_fire(at(6, 10, 19), at(6, 10, 12), &spec),
        TimerFireVerdict::Run
    );
}

#[test]
fn timer_fire_is_a_miss_after_the_window() {
    let spec = parse_window("10:10", "10:20").expect("valid window");
    assert_eq!(
        classify_timer_fire(at(6, 10, 25), at(6, 10, 15), &spec),
        TimerFireVerdict::Miss
    );
    assert_eq!(
        classify_timer_fire(at(6, 9, 0), at(6, 10, 15), &spec),
        TimerFireVerdict::Miss
    );
}

#[test]
fn cross_midnight_timer_runs_while_its_instance_is_open() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        classify_timer_fire(at(7, 0, 5), at(6, 23, 55), &spec),
        TimerFireVerdict::Run
    );
    assert_eq!(
        classify_timer_fire(at(6, 23, 55), at(7, 0, 5), &spec),
        TimerFireVerdict::Run
    );
}

#[test]
fn cross_midnight_timer_from_a_closed_instance_is_a_miss() {
    let spec = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        classify_timer_fire(at(7, 0, 20), at(7, 0, 5), &spec),
        TimerFireVerdict::Miss
    );
    assert_eq!(
        classify_timer_fire(at(6, 12, 0), at(6, 23, 55), &spec),
        TimerFireVerdict::Miss
    );
}

#[test]
fn pause_resume_at_counts_from_today_or_tomorrow() {
    assert_eq!(pause_resume_at(at(9, 15, 30), 1, true), at(10, 0, 0));
    assert_eq!(pause_resume_at(at(9, 15, 30), 3, true), at(12, 0, 0));
    assert_eq!(
        pause_resume_at(at(9, 0, 0), MAX_PAUSE_DAYS, true),
        at(24, 0, 0)
    );
    assert_eq!(pause_resume_at(at(9, 15, 30), 1, false), at(11, 0, 0));
    assert_eq!(pause_resume_at(at(9, 15, 30), 3, false), at(13, 0, 0));
}

#[test]
fn start_of_local_day_ignores_the_clock() {
    assert_eq!(start_of_local_day(at(9, 23, 59), 0), at(9, 0, 0));
    assert_eq!(start_of_local_day(at(9, 23, 59), 1), at(10, 0, 0));
    assert_eq!(start_of_local_day(at(9, 23, 59), -1), at(8, 0, 0));
}

#[test]
fn start_of_local_day_crosses_a_month_boundary() {
    let base = NaiveDate::from_ymd_opt(2026, 11, 30).expect("valid date");
    let moment = Local
        .from_local_datetime(&base.and_hms_opt(23, 59, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis();
    let december = NaiveDate::from_ymd_opt(2026, 12, 1).expect("valid date");
    let expected = Local
        .from_local_datetime(&december.and_hms_opt(0, 0, 0).expect("valid time"))
        .earliest()
        .expect("valid local time")
        .timestamp_millis();
    assert_eq!(start_of_local_day(moment, 1), expected);
}

#[test]
fn pause_interval_starting_today_counts_a_full_day() {
    let noon = at(9, 12, 0);
    let pause = pause_interval(noon, 1, true);
    assert_eq!(pause.from, at(9, 0, 0));
    assert_eq!(pause.until, at(10, 0, 0));

    let pause = pause_interval(noon, 2, true);
    assert_eq!(pause.from, at(9, 0, 0));
    assert_eq!(pause.until, at(11, 0, 0));

    let pause = pause_interval(at(9, 23, 58), 2, true);
    assert_eq!(pause.from, at(9, 0, 0));
    assert_eq!(pause.until, at(11, 0, 0));

    let pause = pause_interval(at(9, 0, 0), MAX_PAUSE_DAYS, true);
    assert_eq!(pause.from, at(9, 0, 0));
    assert_eq!(pause.until, at(24, 0, 0));
}

#[test]
fn a_two_day_pause_from_monday_noon_covers_monday_and_tuesday() {
    let pause = pause_interval(at(9, 12, 0), 2, true);
    assert_eq!(pause.from, at(9, 0, 0));
    assert_eq!(pause.until, at(11, 0, 0));
}

#[test]
fn pause_interval_starting_tomorrow_leaves_today_untouched() {
    let noon = at(9, 12, 0);
    let pause = pause_interval(noon, 1, false);
    assert_eq!(pause.from, at(10, 0, 0));
    assert_eq!(pause.until, at(11, 0, 0));

    let pause = pause_interval(noon, 2, false);
    assert_eq!(pause.from, at(10, 0, 0));
    assert_eq!(pause.until, at(12, 0, 0));

    let pause = pause_interval(at(9, 23, 59), 1, false);
    assert_eq!(pause.from, at(10, 0, 0));
    assert_eq!(pause.until, at(11, 0, 0));
}

#[test]
fn the_two_pause_choices_never_overlap_today() {
    let noon = at(9, 12, 0);
    assert!(pause_interval(noon, 1, false).from > noon);
    assert!(pause_interval(noon, 1, true).from < noon);
}

#[test]
fn plan_paused_is_judged_by_window_start_day() {
    let afternoon = parse_window("14:00", "14:10").expect("valid window");
    let cross = parse_window("23:50", "00:10").expect("valid window");

    let pause = pause_interval(at(9, 12, 0), 1, false);
    assert!(!plan_paused(at(9, 14, 5), &afternoon, Some(pause)));
    assert!(plan_paused(at(10, 14, 5), &afternoon, Some(pause)));
    assert!(!plan_paused(at(11, 14, 5), &afternoon, Some(pause)));

    let pause = pause_interval(at(9, 12, 0), 2, true);
    assert!(plan_paused(at(9, 14, 5), &afternoon, Some(pause)));
    assert!(plan_paused(at(10, 14, 5), &afternoon, Some(pause)));
    assert!(!plan_paused(at(11, 14, 5), &afternoon, Some(pause)));

    let starts_tomorrow = pause_interval(at(9, 12, 0), 1, false);
    let starts_today = pause_interval(at(9, 12, 0), 1, true);
    let tail = at(10, 0, 5);
    assert_eq!(
        window_instance_at(tail, &cross).expect("instance").start,
        at(9, 23, 50)
    );
    assert!(!plan_paused(tail, &cross, Some(starts_tomorrow)));
    assert!(plan_paused(tail, &cross, Some(starts_today)));
    assert!(plan_paused(at(10, 23, 55), &cross, Some(starts_tomorrow)));

    assert!(!plan_paused(at(9, 14, 5), &afternoon, None));
    let empty = PauseInterval {
        from: pause.until,
        until: pause.until,
    };
    assert!(!plan_paused(at(9, 14, 5), &afternoon, Some(empty)));
}

#[test]
fn plan_with_pause_keeps_todays_plan_when_the_pause_starts_tomorrow() {
    let afternoon = parse_window("14:00", "14:10").expect("valid window");
    let noon = at(9, 12, 0);
    let pause = pause_interval(noon, 1, false);
    let target = plan_with_pause(noon, &afternoon, Some(pause), &mut fixed(0.0));
    assert_eq!(target, at(9, 14, 0));
    assert!(!plan_paused(target, &afternoon, Some(pause)));
}

#[test]
fn plan_with_pause_jumps_to_the_resume_day() {
    let afternoon = parse_window("14:00", "14:10").expect("valid window");
    let noon = at(9, 12, 0);
    let pause = pause_interval(noon, 2, true);
    let target = plan_with_pause(noon, &afternoon, Some(pause), &mut fixed(0.0));
    assert_eq!(target, at(11, 14, 0));
    assert!(target >= pause.until);
}

#[test]
fn a_pause_already_in_progress_lands_on_the_resume_day() {
    let morning = parse_window("09:00", "09:10").expect("valid window");
    let pause = pause_interval(at(9, 12, 0), 3, true);
    assert_eq!(
        plan_with_pause(at(10, 9, 0), &morning, Some(pause), &mut fixed(0.0)),
        at(12, 9, 0)
    );
}

#[test]
fn resume_uses_the_resume_days_own_window() {
    let cross = parse_window("23:50", "00:10").expect("valid window");
    assert_eq!(
        plan_new_task(at(11, 0, 0), &cross, &mut fixed(0.0)),
        at(11, 0, 0)
    );
    assert_eq!(
        plan_resume_window(at(11, 0, 0), &cross, &mut fixed(0.0)),
        at(11, 23, 50)
    );
}

#[test]
fn no_pause_behaves_exactly_like_plan_new_task() {
    let afternoon = parse_window("14:00", "14:10").expect("valid window");
    assert_eq!(
        plan_with_pause(at(9, 12, 0), &afternoon, None, &mut fixed(0.0)),
        at(9, 14, 0)
    );
}

#[test]
fn plan_after_run_with_pause_skips_a_paused_day() {
    let afternoon = parse_window("14:00", "14:10").expect("valid window");
    let pause = pause_interval(at(9, 12, 0), 1, false);
    assert_eq!(
        plan_after_run_with_pause(at(9, 14, 5), &afternoon, Some(pause), &mut fixed(0.0)),
        at(11, 14, 0)
    );
    assert_eq!(
        plan_after_run_with_pause(at(9, 14, 5), &afternoon, None, &mut fixed(0.0)),
        at(10, 14, 0)
    );
    let expired = pause_interval(at(5, 12, 0), 1, true);
    assert_eq!(
        plan_after_run_with_pause(at(9, 14, 5), &afternoon, Some(expired), &mut fixed(0.0)),
        at(10, 14, 0)
    );
}

#[test]
fn bad_windows_are_rejected() {
    assert!(parse_window("10:00", "25:00").is_err());
}

#[test]
fn exact_time_is_flagged_as_instant() {
    let spec = parse_window("10:00", "10:00").expect("valid window");
    assert!(spec.instant);
    assert_eq!(spec.duration_minutes, 0);
}

#[test]
fn exact_time_plans_exactly_at_the_chosen_moment() {
    let spec = parse_window("10:00", "10:00").expect("valid window");
    assert_eq!(
        plan_new_task(at(20, 9, 30), &spec, &mut fixed(0.5)),
        at(20, 10, 0)
    );
    assert_eq!(
        plan_new_task(at(20, 10, 5), &spec, &mut fixed(0.5)),
        at(21, 10, 0)
    );
    assert_eq!(
        plan_next_window_after(at(20, 10, 0), &spec, &mut fixed(0.5)),
        at(21, 10, 0)
    );
}

#[test]
fn exact_time_tolerates_a_late_timer() {
    let spec = parse_window("10:00", "10:00").expect("valid window");
    assert_eq!(
        classify_timer_fire(at(20, 10, 0) + 2000, at(20, 10, 0), &spec),
        TimerFireVerdict::Run
    );
    assert_eq!(
        classify_timer_fire(at(20, 10, 2), at(20, 10, 0), &spec),
        TimerFireVerdict::Miss
    );
}

#[test]
fn exact_time_inside_the_grace_period_runs_immediately() {
    let spec = parse_window("10:00", "10:00").expect("valid window");
    let now = at(20, 10, 0) + 5000;
    assert_eq!(plan_new_task(now, &spec, &mut fixed(0.5)), now);

    let now = at(20, 10, 0) + 3000;
    let plan = plan_recovery(now, Some(at(20, 10, 0)), &spec, &mut fixed(0.5));
    assert_eq!(plan.target, now);
    assert_eq!(plan.reason, RecoveryReason::InWindow);
}

#[test]
fn a_paused_day_skips_the_exact_time() {
    let spec = parse_window("10:00", "10:00").expect("valid window");
    let pause = PauseInterval {
        from: start_of_local_day(at(20, 0, 0), 0),
        until: start_of_local_day(at(21, 0, 0), 0),
    };
    assert!(plan_paused(at(20, 10, 0), &spec, Some(pause)));
    assert_eq!(
        plan_with_pause(at(20, 8, 0), &spec, Some(pause), &mut fixed(0.0)),
        at(21, 10, 0)
    );
}

#[test]
fn a_jitter_band_keeps_the_run_inside_the_window() {
    let jittered = parse_window("09:55", "10:05").expect("valid window");
    let target = plan_new_task(at(20, 9, 0), &jittered, &mut fixed(0.5));
    assert!(target >= at(20, 9, 55));
    assert!(target < at(20, 10, 5));
    assert!(!plan_paused(target, &jittered, None));
}
