import { describe, expect, test } from "bun:test";
import {
  WindowError,
  classifyTimerFire,
  nextWindowStartAfter,
  parseWindow,
  planNewTask,
  planNextWindowAfter,
  planRecovery,
  randomPoint,
  validateWindow,
  windowInstanceAt,
} from "./window";

const at = (day: number, hour: number, minute: number): number =>
  new Date(2026, 10, day, hour, minute, 0, 0).getTime();

const fixed = (value: number) => () => value;

describe("parseWindow", () => {
  test("parses a same-day window", () => {
    expect(parseWindow("10:10", "10:20")).toMatchObject({
      durationMinutes: 10,
      crossMidnight: false,
    });
  });

  test("parses a cross-midnight window as its total duration", () => {
    expect(parseWindow("23:50", "00:10")).toMatchObject({
      durationMinutes: 20,
      crossMidnight: true,
    });
  });

  test("rejects invalid formats and equal endpoints", () => {
    expect(validateWindow("24:00", "10:00")).toContain("HH:mm");
    expect(validateWindow("10:00", "10:00")).toContain("不能相同");
    expect(validateWindow("10:20", "10:10")).toBeNull();
  });
});

describe("windowInstanceAt", () => {
  const spec = parseWindow("23:50", "00:10");

  test("finds an instance that started today", () => {
    const instance = windowInstanceAt(at(6, 23, 55), spec);
    expect(instance).toEqual({ start: at(6, 23, 50), end: at(7, 0, 10) });
  });

  test("finds the previous day's instance after midnight", () => {
    const instance = windowInstanceAt(at(7, 0, 5), spec);
    expect(instance).toEqual({ start: at(6, 23, 50), end: at(7, 0, 10) });
  });

  test("returns null outside the window", () => {
    expect(windowInstanceAt(at(7, 0, 20), spec)).toBeNull();
  });

  test("handles a same-day window", () => {
    const same = parseWindow("10:10", "10:20");
    expect(windowInstanceAt(at(6, 10, 15), same)).toEqual({
      start: at(6, 10, 10),
      end: at(6, 10, 20),
    });
    expect(windowInstanceAt(at(6, 10, 20), same)).toBeNull();
  });
});

describe("planning", () => {
  const same = parseWindow("10:10", "10:20");
  const cross = parseWindow("23:50", "00:10");

  test("randomPoint respects half-open bounds", () => {
    expect(randomPoint(100, 200, fixed(0))).toBe(100);
    expect(randomPoint(100, 200, fixed(0.5))).toBe(150);
    expect(randomPoint(100, 200, fixed(0.999999))).toBe(199);
  });

  test("plans today's window when before it", () => {
    expect(planNewTask(at(6, 9, 0), same, fixed(0))).toBe(at(6, 10, 10));
  });

  test("plans the remaining window when already inside it", () => {
    expect(planNewTask(at(6, 10, 15), same, fixed(0))).toBe(at(6, 10, 15));
    expect(planNewTask(at(6, 10, 15), same, fixed(0.5))).toBe(at(6, 10, 17) + 30_000);
  });

  test("plans tomorrow after the window has ended", () => {
    expect(planNewTask(at(6, 10, 30), same, fixed(0))).toBe(at(7, 10, 10));
  });

  test("plans the next instance after a completed run", () => {
    expect(planNextWindowAfter(at(6, 10, 15), same, fixed(0))).toBe(at(7, 10, 10));
    expect(planNextWindowAfter(at(6, 23, 55), cross, fixed(0))).toBe(at(7, 23, 50));
  });

  test("after a cross-midnight run the next instance starts on the same day", () => {
    expect(planNextWindowAfter(at(7, 0, 5), cross, fixed(0))).toBe(at(7, 23, 50));
  });

  test("handles crossing midnight before the start", () => {
    expect(planNewTask(at(6, 12, 0), cross, fixed(0))).toBe(at(6, 23, 50));
    expect(windowInstanceAt(at(6, 23, 59), cross)).toEqual({
      start: at(6, 23, 50),
      end: at(7, 0, 10),
    });
  });

  test("handles crossing midnight after midnight", () => {
    const spec = cross;
    expect(windowInstanceAt(at(7, 0, 5), spec)).not.toBeNull();
    expect(planNewTask(at(7, 0, 5), spec, fixed(0))).toBe(at(7, 0, 5));
    expect(planNewTask(at(7, 0, 20), spec, fixed(0))).toBe(at(7, 23, 50));
  });

  test("nextWindowStartAfter returns today or tomorrow", () => {
    expect(nextWindowStartAfter(at(6, 9, 0), same)).toBe(at(6, 10, 10));
    expect(nextWindowStartAfter(at(6, 10, 15), same)).toBe(at(7, 10, 10));
  });
});

describe("planRecovery", () => {
  const same = parseWindow("10:10", "10:20");
  const cross = parseWindow("23:50", "00:10");

  test("keeps a future next_run_at", () => {
    const planned = at(6, 10, 15);
    const result = planRecovery(at(6, 9, 0), planned, same, fixed(0.5));
    expect(result).toEqual({ target: planned, missed: null, reason: "future" });
  });

  test("re-randomizes inside the current window after a missed moment", () => {
    const result = planRecovery(at(6, 10, 15), at(6, 10, 11), same, fixed(0.5));
    expect(result.reason).toBe("in-window");
    expect(result.missed).toBeNull();
    expect(result.target).toBe(at(6, 10, 15) + 150_000);
  });

  test("records a missed previous window when inside a new one", () => {
    const planned = at(6, 23, 40);
    const result = planRecovery(at(7, 0, 5), planned, cross, fixed(0));
    expect(result.reason).toBe("in-window");
    expect(result.missed).toEqual({ plannedAt: planned });
    expect(result.target).toBe(at(7, 0, 5));
  });

  test("records a missed window and plans tomorrow when the window has passed", () => {
    const planned = at(6, 10, 15);
    const result = planRecovery(at(7, 0, 20), planned, cross, fixed(0));
    expect(result.reason).toBe("missed");
    expect(result.missed).toEqual({ plannedAt: planned });
    expect(result.target).toBe(at(7, 23, 50));
  });

  test("plans today after a stale plan from yesterday", () => {
    const result = planRecovery(at(6, 9, 0), at(5, 10, 15), same, fixed(0));
    expect(result.reason).toBe("missed");
    expect(result.missed).toEqual({ plannedAt: at(5, 10, 15) });
    expect(result.target).toBe(at(6, 10, 10));
  });

  test("does not record a miss when there was no plan", () => {
    const result = planRecovery(at(6, 9, 0), null, same, fixed(0));
    expect(result.reason).toBe("next-window");
    expect(result.missed).toBeNull();
    expect(result.target).toBe(at(6, 10, 10));
  });
});

describe("classifyTimerFire", () => {
  const same = parseWindow("10:10", "10:20");
  const cross = parseWindow("23:50", "00:10");

  test("runs a timer that is still inside the same window", () => {
    expect(classifyTimerFire(at(6, 10, 15), at(6, 10, 15), same)).toBe("run");
    expect(classifyTimerFire(at(6, 10, 19), at(6, 10, 12), same)).toBe("run");
  });

  test("treats a late timer after the window as missed", () => {
    expect(classifyTimerFire(at(6, 10, 25), at(6, 10, 15), same)).toBe("miss");
    expect(classifyTimerFire(at(6, 9, 0), at(6, 10, 15), same)).toBe("miss");
  });

  test("runs a cross-midnight timer while its instance is still open", () => {
    expect(classifyTimerFire(at(7, 0, 5), at(6, 23, 55), cross)).toBe("run");
    expect(classifyTimerFire(at(6, 23, 55), at(7, 0, 5), cross)).toBe("run");
  });

  test("treats a cross-midnight timer from a closed instance as missed", () => {
    expect(classifyTimerFire(at(7, 0, 20), at(7, 0, 5), cross)).toBe("miss");
    expect(classifyTimerFire(at(6, 12, 0), at(6, 23, 55), cross)).toBe("miss");
  });
});

test("WindowError is the error type for bad windows", () => {
  expect(() => parseWindow("10:00", "10:00")).toThrow(WindowError);
});
