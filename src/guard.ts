/**
 * Local (no-request) part of the pre-run guard: "only on these weekdays" and
 * "only inside this time range". Both are optional and combine with the guard
 * curl, so a task can be skipped without touching the network.
 *
 * Semantics match the rest of Jitter: local wall clock, minute precision, and
 * a range whose end is before its start crosses midnight and belongs to the
 * day it STARTED on.
 */

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface LocalGuardConfig {
  /** `null` means every day; otherwise 0..6 (0 = Sunday). */
  weekdays: number[] | null;
  timeStart: string | null;
  timeEnd: string | null;
}

export interface GuardVerdict {
  passed: boolean;
  reason: string;
}

function toMinutes(value: string): number {
  const match = HHMM.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Accepts `[1,2,3]` or `"1,2,3"`; empty means "no restriction". */
export function parseWeekdays(value: unknown): number[] | null {
  if (value === undefined || value === null || value === "") return null;
  let raw: unknown[];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    raw = value.split(",").map((part) => part.trim());
  } else {
    throw new GuardError("执行星期必须是数组或逗号分隔的数字");
  }

  const days = new Set<number>();
  for (const item of raw) {
    if (item === "" || item === null || item === undefined) continue;
    const day = Number(item);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new GuardError("执行星期必须是 0–6 的整数（0 = 周日）");
    }
    days.add(day);
  }
  if (days.size === 0) return null;
  return [...days].sort((a, b) => a - b);
}

/** Both empty means "no time restriction"; only one side is an error. */
export function parseTimeRange(
  start: unknown,
  end: unknown,
): { start: string; end: string } | null {
  const startText = typeof start === "string" ? start.trim() : "";
  const endText = typeof end === "string" ? end.trim() : "";
  if (!startText && !endText) return null;
  if (!startText || !endText) {
    throw new GuardError("执行时段需要同时填写开始和结束时间");
  }
  if (!HHMM.test(startText)) throw new GuardError("执行时段开始时间必须是 HH:mm 格式");
  if (!HHMM.test(endText)) throw new GuardError("执行时段结束时间必须是 HH:mm 格式");
  if (startText === endText) throw new GuardError("执行时段的开始和结束时间不能相同");
  return { start: startText, end: endText };
}

/** Lenient read from a stored row: bad legacy data simply means "no limit". */
export function localGuardOf(task: {
  precheck_weekdays?: string | null;
  precheck_time_start?: string | null;
  precheck_time_end?: string | null;
}): LocalGuardConfig {
  let weekdays: number[] | null = null;
  if (task.precheck_weekdays) {
    const parsed = task.precheck_weekdays
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
    if (parsed.length > 0) weekdays = [...new Set(parsed)].sort((a, b) => a - b);
  }
  const start = task.precheck_time_start ?? null;
  const end = task.precheck_time_end ?? null;
  const validRange =
    start !== null && end !== null && HHMM.test(start) && HHMM.test(end) && start !== end;
  return {
    weekdays,
    timeStart: validRange ? start : null,
    timeEnd: validRange ? end : null,
  };
}

export function hasLocalConditions(config: LocalGuardConfig): boolean {
  return (
    (config.weekdays !== null && config.weekdays.length > 0) ||
    (config.timeStart !== null && config.timeEnd !== null)
  );
}

function describeWeekdays(days: number[]): string {
  return days.map((day) => WEEKDAY_LABELS[day]).join("、");
}

/**
 * Judge the local conditions for `now`. Returns a human reason either way, so
 * the skipped log and the test bench can explain themselves.
 */
export function evaluateLocalGuard(config: LocalGuardConfig, now: number = Date.now()): GuardVerdict {
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  let weekday = date.getDay();

  if (config.timeStart !== null && config.timeEnd !== null) {
    const start = toMinutes(config.timeStart);
    const end = toMinutes(config.timeEnd);
    const crossMidnight = end < start;
    let inRange: boolean;
    if (!crossMidnight) {
      inRange = minutes >= start && minutes < end;
    } else if (minutes >= start) {
      inRange = true;
    } else if (minutes < end) {
      // 00:30 of a 22:00–02:00 range still belongs to YESTERDAY's instance.
      inRange = true;
      weekday = (weekday + 6) % 7;
    } else {
      inRange = false;
    }
    if (!inRange) {
      const suffix = crossMidnight ? "（跨午夜）" : "";
      return {
        passed: false,
        reason: `当前 ${clock} 不在执行时段 ${config.timeStart}–${config.timeEnd}${suffix} 内`,
      };
    }
  }

  if (config.weekdays !== null && config.weekdays.length > 0) {
    if (!config.weekdays.includes(weekday)) {
      return {
        passed: false,
        reason: `今天是${WEEKDAY_LABELS[weekday]}，不在允许执行的星期（${describeWeekdays(
          config.weekdays,
        )}）内`,
      };
    }
  }

  const parts: string[] = [`今天${WEEKDAY_LABELS[weekday]} ${clock}`];
  if (config.timeStart !== null && config.timeEnd !== null) {
    parts.push(`时段 ${config.timeStart}–${config.timeEnd}`);
  }
  if (config.weekdays !== null && config.weekdays.length > 0) {
    parts.push(`允许 ${describeWeekdays(config.weekdays)}`);
  }
  if (parts.length === 1) {
    return { passed: true, reason: "未设置本地条件（任何时间都执行）" };
  }
  return { passed: true, reason: `本地条件满足（${parts.join("，")}）` };
}
