import { describe, expect, test } from "bun:test";
import {
  buildSchedule,
  describeSchedule,
  isMissedNonDaily,
  planScheduleAfter,
  planScheduleNew,
  planScheduleRecovery,
  previewSchedule,
  sameSchedule,
  scheduleLatenessTolerance,
  scheduleOf,
  ScheduleError,
  type ScheduleSpec,
} from "./schedule";
import { startOfLocalDay } from "./window";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Local-time helper for the anchored-interval cases. */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const NOW = new Date(2026, 0, 5, 10, 30, 15, 400).getTime();

function interval(seconds: number, jitter = 0): ScheduleSpec {
  return buildSchedule({
    schedule_kind: "interval",
    interval_seconds: seconds,
    interval_jitter_seconds: jitter,
  });
}

describe("buildSchedule", () => {
  test("daily keeps the historical window rules", () => {
    const spec = buildSchedule({ window_start: "23:50", window_end: "00:10" });
    expect(spec.kind).toBe("daily");
    expect(spec.window?.crossMidnight).toBe(true);
  });

  test("daily rejects invalid windows but accepts an exact time", () => {
    expect(() => buildSchedule({ window_start: "25:00", window_end: "10:00" })).toThrow();
    // start === end is the "exact time" shape.
    const exact = buildSchedule({ window_start: "10:00", window_end: "10:00" });
    expect(exact.exactTime).toBe("10:00");
    expect(exact.window?.instant).toBe(true);
  });

  test("daily validates the ± jitter", () => {
    const jittered = buildSchedule({
      window_start: "10:00",
      window_end: "10:00",
      daily_jitter_minutes: 5,
    });
    expect(jittered.jitterMinutes).toBe(5);
    // ±5 turns the instant into a real 10-minute window.
    expect(jittered.window?.start).toBe("09:55");
    expect(jittered.window?.end).toBe("10:05");
    expect(jittered.window?.instant).toBe(false);

    expect(() =>
      buildSchedule({ window_start: "10:00", window_end: "10:00", daily_jitter_minutes: 61 }),
    ).toThrow(ScheduleError);
    expect(() =>
      buildSchedule({ window_start: "10:00", window_end: "10:00", daily_jitter_minutes: -1 }),
    ).toThrow(ScheduleError);
    // Jitter without an exact time is meaningless.
    expect(() =>
      buildSchedule({ window_start: "09:00", window_end: "10:00", daily_jitter_minutes: 5 }),
    ).toThrow(ScheduleError);
  });

  test("interval accepts seconds and jitter", () => {
    const spec = interval(90, 10);
    expect(spec.kind).toBe("interval");
    expect(spec.intervalSeconds).toBe(90);
    expect(spec.intervalJitterSeconds).toBe(10);
  });

  test("interval rejects out-of-range and oversized jitter", () => {
    expect(() =>
      buildSchedule({ schedule_kind: "interval", interval_seconds: 0 }),
    ).toThrow(ScheduleError);
    expect(() =>
      buildSchedule({ schedule_kind: "interval", interval_seconds: 40 * 86400 }),
    ).toThrow(ScheduleError);
    expect(() =>
      buildSchedule({
        schedule_kind: "interval",
        interval_seconds: 10,
        interval_jitter_seconds: 11,
      }),
    ).toThrow(ScheduleError);
    expect(() =>
      buildSchedule({ schedule_kind: "interval", interval_seconds: "abc" }),
    ).toThrow(ScheduleError);
  });

  test("cron is no longer a valid schedule kind", () => {
    expect(() => buildSchedule({ schedule_kind: "cron" })).toThrow(ScheduleError);
  });

  test("an unknown schedule kind is rejected", () => {
    expect(() => buildSchedule({ schedule_kind: "weekly" })).toThrow(ScheduleError);
  });
});

describe("scheduleOf (legacy rows)", () => {
  test("rows created before scheduling modes are daily", () => {
    const spec = scheduleOf({
      schedule_kind: null,
      window_start: "10:10",
      window_end: "10:20",
    });
    expect(spec.kind).toBe("daily");
    expect(spec.window?.start).toBe("10:10");
  });

  test("interval rows are rebuilt from their columns", () => {
    const spec = scheduleOf({
      schedule_kind: "interval",
      interval_seconds: 120,
      interval_jitter_seconds: 5,
    });
    expect(spec.intervalSeconds).toBe(120);
    expect(spec.intervalJitterSeconds).toBe(5);
  });
});

describe("interval planning", () => {
  test("first run is one interval after now", () => {
    expect(planScheduleNew(NOW, interval(30))).toBe(NOW + 30 * SECOND);
  });

  test("jitter adds 0..N seconds deterministically from rng", () => {
    expect(planScheduleNew(NOW, interval(30, 10), null, () => 0)).toBe(NOW + 30 * SECOND);
    expect(planScheduleNew(NOW, interval(30, 10), null, () => 0.5)).toBe(
      NOW + 35 * SECOND,
    );
  });

  test("the next run stays anchored on the scheduled grid", () => {
    const target = NOW;
    // The request finished 200ms after the tick: the grid must not drift.
    expect(planScheduleAfter(NOW + 200, interval(30), target)).toBe(NOW + 30 * SECOND);
  });

  test("a request that overruns the next tick restarts the grid", () => {
    const target = NOW;
    const finished = NOW + 40 * SECOND;
    expect(planScheduleAfter(finished, interval(30), target)).toBe(finished + 30 * SECOND);
  });

  test("a pause skips whole local days and resumes after it", () => {
    const pause = { from: startOfLocalDay(NOW), until: startOfLocalDay(NOW, 2) };
    const target = planScheduleNew(NOW, interval(3600), pause);
    expect(target).toBeGreaterThanOrEqual(pause.until);
  });

  test("a pause starting tomorrow keeps the run planned for today", () => {
    const pause = { from: startOfLocalDay(NOW, 1), until: startOfLocalDay(NOW, 3) };
    expect(planScheduleNew(NOW, interval(3600), pause)).toBe(NOW + 3600 * SECOND);
  });
});

describe("preview", () => {
  test("preview of a daily schedule lists window starts", () => {
    const spec = buildSchedule({ window_start: "09:00", window_end: "09:30" });
    const preview = previewSchedule(spec, NOW, 2);
    expect(preview.next.length).toBe(2);
    expect(preview.description).toContain("每天");
  });

  test("preview of an interval lists evenly spaced moments", () => {
    const preview = previewSchedule(interval(300), NOW, 3);
    expect(preview.next).toEqual([NOW + 300 * SECOND, NOW + 600 * SECOND, NOW + 900 * SECOND]);
    expect(preview.description).toBe("每 5 分钟");
  });
});

describe("lateness tolerance", () => {
  test("short intervals tolerate at least 5 seconds", () => {
    expect(scheduleLatenessTolerance(interval(1))).toBe(5 * SECOND);
  });

  test("long intervals cap at 60 seconds", () => {
    expect(scheduleLatenessTolerance(interval(3600))).toBe(60 * SECOND);
    expect(scheduleLatenessTolerance(interval(86400))).toBe(60 * SECOND);
  });

  test("classifies late ticks", () => {
    const spec = interval(60);
    expect(isMissedNonDaily(NOW, NOW - 1000, spec)).toBe(false);
    expect(isMissedNonDaily(NOW, NOW - 5 * MINUTE, spec)).toBe(true);
  });
});

describe("startup recovery", () => {
  test("a slightly late plan runs immediately instead of being dropped", () => {
    const plan = planScheduleRecovery(NOW, interval(60), NOW - 1000);
    expect(plan.target).toBe(NOW);
    expect(plan.missedPlannedAt).toBeNull();
  });

  test("an old plan is recorded as missed and the next tick is planned", () => {
    const stale = NOW - 3 * 3600 * 1000;
    const plan = planScheduleRecovery(NOW, interval(3600), stale);
    expect(plan.missedPlannedAt).toBe(stale);
    expect(plan.target).toBe(NOW + 3600 * SECOND);
  });

  test("a future plan is kept as-is", () => {
    const future = NOW + 5 * MINUTE;
    expect(planScheduleRecovery(NOW, interval(60), future).target).toBe(future);
  });
});

describe("descriptions and comparison", () => {
  test("describes each kind", () => {
    expect(describeSchedule(interval(30))).toBe("每 30 秒");
    expect(describeSchedule(interval(7200))).toBe("每 2 小时");
    expect(describeSchedule(interval(60, 5))).toContain("抖动");
    expect(describeSchedule(buildSchedule({ window_start: "10:00", window_end: "10:10" }))).toContain(
      "每天",
    );
  });

  test("sameSchedule distinguishes meaningful edits only", () => {
    const base = interval(60);
    expect(sameSchedule(base, interval(60))).toBe(true);
    expect(sameSchedule(base, interval(61))).toBe(false);
    expect(sameSchedule(base, interval(60, 1))).toBe(false);
    expect(sameSchedule(base, interval(3600))).toBe(false);
  });
});

describe("interval start anchor", () => {
  function anchored(seconds: number, startAt: number, jitter = 0): ScheduleSpec {
    return buildSchedule({
      schedule_kind: "interval",
      interval_seconds: seconds,
      interval_jitter_seconds: jitter,
      interval_start_at: startAt,
    });
  }

  test("stores the anchor and mentions it in the description", () => {
    const spec = anchored(7200, at(2026, 1, 5, 9, 0));
    expect(spec.startAt).toBe(at(2026, 1, 5, 9, 0));
    expect(describeSchedule(spec)).toContain("起算");
  });

  test("rejects an invalid anchor", () => {
    expect(() => anchored(60, 0)).toThrow(ScheduleError);
    expect(() => anchored(60, -1)).toThrow(ScheduleError);
  });

  test("a future anchor becomes the first run", () => {
    const start = at(2026, 1, 6, 9, 0);
    expect(planScheduleNew(NOW, anchored(3600, start))).toBe(start);
  });

  test("a past anchor aligns to the next grid tick", () => {
    // 09:00 + 2h grid → 11:00 is the next tick after 10:30.
    expect(planScheduleNew(NOW, anchored(7200, at(2026, 1, 5, 9, 0)))).toBe(
      at(2026, 1, 5, 11, 0),
    );
  });

  test("the grid survives a run that finishes late", () => {
    const spec = anchored(7200, at(2026, 1, 5, 9, 0));
    const firedAt = at(2026, 1, 5, 11, 0) + 2000;
    expect(planScheduleAfter(firedAt, spec, firedAt)).toBe(at(2026, 1, 5, 13, 0));
  });

  test("the grid survives a pause", () => {
    const spec = anchored(7200, at(2026, 1, 5, 9, 0));
    const pause = { from: startOfLocalDay(NOW), until: startOfLocalDay(NOW, 2) };
    const target = planScheduleNew(NOW, spec, pause);
    expect(target).toBeGreaterThanOrEqual(pause.until);
    expect((target - at(2026, 1, 5, 9, 0)) % (7200 * SECOND)).toBe(0);
  });

  test("preview lists the anchored ticks", () => {
    const preview = previewSchedule(anchored(7200, at(2026, 1, 5, 9, 0)), NOW, 3);
    expect(preview.next).toEqual([
      at(2026, 1, 5, 11, 0),
      at(2026, 1, 5, 13, 0),
      at(2026, 1, 5, 15, 0),
    ]);
  });

  test("preview without an anchor keeps counting from now", () => {
    const preview = previewSchedule(interval(60), NOW, 2);
    expect(preview.next).toEqual([NOW + MINUTE, NOW + 2 * MINUTE]);
  });

  test("moving the anchor counts as a schedule change", () => {
    const base = anchored(3600, at(2026, 1, 5, 9, 0));
    expect(sameSchedule(base, anchored(3600, at(2026, 1, 5, 9, 0)))).toBe(true);
    expect(sameSchedule(base, anchored(3600, at(2026, 1, 5, 10, 0)))).toBe(false);
    // Same numbers, different anchor: it must still be treated as changed.
    expect(sameSchedule(interval(3600), base)).toBe(false);
  });

  test("a bogus stored anchor degrades to 'from now'", () => {
    const spec = scheduleOf({
      schedule_kind: "interval",
      interval_seconds: 60,
      interval_start_at: 0,
    });
    expect(spec.startAt).toBeNull();
  });
});

describe("daily preview", () => {
  test("a window that is still open is the first predicted run", () => {
    // NOW is 10:30, so the 09:00–11:00 window has not closed yet.
    const spec = buildSchedule({ window_start: "09:00", window_end: "11:00" });
    const preview = previewSchedule(spec, NOW, 2);
    expect(preview.next[0]).toBe(at(2026, 1, 5, 9, 0));
    expect(preview.next[1]).toBe(at(2026, 1, 6, 9, 0));
  });

  test("a closed window rolls over to tomorrow", () => {
    const spec = buildSchedule({ window_start: "09:00", window_end: "10:00" });
    const preview = previewSchedule(spec, NOW, 1);
    expect(preview.next[0]).toBe(at(2026, 1, 6, 9, 0));
  });
});
