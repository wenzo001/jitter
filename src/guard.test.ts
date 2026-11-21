import { describe, expect, test } from "bun:test";
import {
  evaluateLocalGuard,
  GuardError,
  hasLocalConditions,
  localGuardOf,
  parseTimeRange,
  parseWeekdays,
  type LocalGuardConfig,
} from "./guard";

/** Local-time helper; -1 for "no restriction". */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function guard(overrides: Partial<LocalGuardConfig> = {}): LocalGuardConfig {
  return { weekdays: null, timeStart: null, timeEnd: null, ...overrides };
}

describe("parseWeekdays", () => {
  test("accepts arrays and comma strings", () => {
    expect(parseWeekdays([1, 2, 3])).toEqual([1, 2, 3]);
    expect(parseWeekdays("3,1,3")).toEqual([1, 3]);
    expect(parseWeekdays("0,6")).toEqual([0, 6]);
  });

  test("empty means no restriction", () => {
    expect(parseWeekdays(null)).toBeNull();
    expect(parseWeekdays("")).toBeNull();
    expect(parseWeekdays([])).toBeNull();
  });

  test("rejects out-of-range or non-numeric values", () => {
    expect(() => parseWeekdays([7])).toThrow(GuardError);
    expect(() => parseWeekdays([-1])).toThrow(GuardError);
    expect(() => parseWeekdays("mon")).toThrow(GuardError);
  });
});

describe("parseTimeRange", () => {
  test("both empty means no restriction", () => {
    expect(parseTimeRange("", "")).toBeNull();
    expect(parseTimeRange(null, null)).toBeNull();
  });

  test("requires both sides and a valid HH:mm", () => {
    expect(() => parseTimeRange("09:00", "")).toThrow(GuardError);
    expect(() => parseTimeRange("9:00", "18:00")).toThrow(GuardError);
    expect(() => parseTimeRange("09:00", "24:00")).toThrow(GuardError);
    expect(() => parseTimeRange("09:00", "09:00")).toThrow(GuardError);
  });

  test("accepts a cross-midnight range", () => {
    expect(parseTimeRange("22:00", "02:00")).toEqual({ start: "22:00", end: "02:00" });
  });
});

describe("localGuardOf (stored rows)", () => {
  test("reads a valid configuration", () => {
    expect(
      localGuardOf({
        precheck_weekdays: "1,3,5",
        precheck_time_start: "09:00",
        precheck_time_end: "18:00",
      }),
    ).toEqual({ weekdays: [1, 3, 5], timeStart: "09:00", timeEnd: "18:00" });
  });

  test("treats junk as 'no restriction' instead of throwing", () => {
    expect(
      localGuardOf({
        precheck_weekdays: "x,9",
        precheck_time_start: "bad",
        precheck_time_end: "18:00",
      }),
    ).toEqual({ weekdays: null, timeStart: null, timeEnd: null });
    expect(localGuardOf({})).toEqual({ weekdays: null, timeStart: null, timeEnd: null });
  });
});

describe("evaluateLocalGuard", () => {
  test("no conditions always passes", () => {
    const verdict = evaluateLocalGuard(guard(), at(2026, 1, 5, 10, 30));
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("未设置本地条件");
    expect(hasLocalConditions(guard())).toBe(false);
  });

  test("weekday allow-list passes and blocks", () => {
    // 2026-01-05 is a Monday.
    expect(evaluateLocalGuard(guard({ weekdays: [1] }), at(2026, 1, 5, 10, 30)).passed).toBe(true);
    const blocked = evaluateLocalGuard(guard({ weekdays: [2, 3] }), at(2026, 1, 5, 10, 30));
    expect(blocked.passed).toBe(false);
    expect(blocked.reason).toContain("周一");
  });

  test("time range passes inside and blocks outside", () => {
    const range = { timeStart: "09:00", timeEnd: "18:00" };
    expect(evaluateLocalGuard(guard(range), at(2026, 1, 5, 9, 0)).passed).toBe(true);
    expect(evaluateLocalGuard(guard(range), at(2026, 1, 5, 17, 59)).passed).toBe(true);
    expect(evaluateLocalGuard(guard(range), at(2026, 1, 5, 18, 0)).passed).toBe(false);
    const blocked = evaluateLocalGuard(guard(range), at(2026, 1, 5, 8, 59));
    expect(blocked.passed).toBe(false);
    expect(blocked.reason).toContain("09:00–18:00");
  });

  test("a cross-midnight range belongs to the day it started on", () => {
    const overnight = { timeStart: "22:00", timeEnd: "02:00" };
    // Tuesday 00:30 is the tail of MONDAY's 22:00–02:00 instance.
    const mondayOnly = evaluateLocalGuard(
      guard({ ...overnight, weekdays: [1] }),
      at(2026, 1, 6, 0, 30),
    );
    expect(mondayOnly.passed).toBe(true);

    const tuesdayOnly = evaluateLocalGuard(
      guard({ ...overnight, weekdays: [2] }),
      at(2026, 1, 6, 0, 30),
    );
    expect(tuesdayOnly.passed).toBe(false);

    // 03:00 is outside the overnight range entirely.
    expect(
      evaluateLocalGuard(guard({ ...overnight, weekdays: [1] }), at(2026, 1, 6, 3, 0)).passed,
    ).toBe(false);
  });

  test("both conditions must pass", () => {
    const config = guard({ weekdays: [1], timeStart: "09:00", timeEnd: "18:00" });
    expect(evaluateLocalGuard(config, at(2026, 1, 5, 10, 0)).passed).toBe(true);
    expect(evaluateLocalGuard(config, at(2026, 1, 5, 20, 0)).passed).toBe(false);
    expect(evaluateLocalGuard(config, at(2026, 1, 6, 10, 0)).passed).toBe(false);
  });
});
