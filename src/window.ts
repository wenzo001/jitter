export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

export interface WindowSpec {
  start: string;
  end: string;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
  crossMidnight: boolean;
}

export interface WindowInstance {
  start: number;
  end: number;
}

export interface RecoveryPlan {
  target: number;
  missed: { plannedAt: number } | null;
  reason: "future" | "in-window" | "missed" | "next-window";
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value: string, label: string): number {
  const match = HHMM.exec(value);
  if (!match) {
    throw new WindowError(`${label}必须是 HH:mm 格式（00:00–23:59）`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseWindow(start: string, end: string): WindowSpec {
  const startMinutes = parseHHMM(start, "开始时间");
  const endMinutes = parseHHMM(end, "结束时间");
  const durationMinutes = (endMinutes - startMinutes + 24 * 60) % (24 * 60);
  if (durationMinutes === 0) {
    throw new WindowError("窗口起止时间不能相同");
  }
  return {
    start,
    end,
    startMinutes,
    endMinutes,
    durationMinutes,
    crossMidnight: endMinutes < startMinutes,
  };
}

export function validateWindow(start: string, end: string): string | null {
  try {
    parseWindow(start, end);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function localAt(now: number, minutes: number): number {
  const date = new Date(now);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function addMinutes(timestamp: number, minutes: number): number {
  const date = new Date(timestamp);
  date.setMinutes(date.getMinutes() + minutes);
  return date.getTime();
}

function endOf(start: number, spec: WindowSpec): number {
  return addMinutes(start, spec.durationMinutes);
}

/**
 * Returns the window instance containing `now`. The instance is identified by
 * the day its START falls on, so 23:50–00:10 belongs to the start day and may
 * still be active after midnight.
 */
export function windowInstanceAt(now: number, spec: WindowSpec): WindowInstance | null {
  const startToday = localAt(now, spec.startMinutes);
  const endToday = endOf(startToday, spec);
  if (now >= startToday && now < endToday) {
    return { start: startToday, end: endToday };
  }
  const startYesterday = addDays(startToday, -1);
  const endYesterday = endOf(startYesterday, spec);
  if (now >= startYesterday && now < endYesterday) {
    return { start: startYesterday, end: endYesterday };
  }
  return null;
}

export function nextWindowStartAfter(now: number, spec: WindowSpec): number {
  const startToday = localAt(now, spec.startMinutes);
  return startToday > now ? startToday : addDays(startToday, 1);
}

export type TimerFireVerdict = "run" | "miss";

/**
 * A timer is only allowed to run while the window instance that contains its
 * target is still open. If the process slept past the window (or the clock
 * jumped), the target must be treated as missed instead of being replayed.
 */
export function classifyTimerFire(
  now: number,
  target: number,
  spec: WindowSpec,
): TimerFireVerdict {
  const instance = windowInstanceAt(now, spec);
  if (instance && target >= instance.start && target < instance.end) {
    return "run";
  }
  return "miss";
}

export function randomPoint(from: number, to: number, rng: () => number): number {
  const span = to - from;
  if (span <= 0) return from;
  const ratio = Math.min(Math.max(rng(), 0), 0.999999999);
  return from + Math.floor(ratio * span);
}

export function planNewTask(now: number, spec: WindowSpec, rng: () => number = Math.random): number {
  const current = windowInstanceAt(now, spec);
  if (current) {
    return randomPoint(Math.max(now, current.start), current.end, rng);
  }
  const start = nextWindowStartAfter(now, spec);
  return randomPoint(start, endOf(start, spec), rng);
}

/** Used after a run; the instance containing `now` has already been consumed. */
export function planNextWindowAfter(
  now: number,
  spec: WindowSpec,
  rng: () => number = Math.random,
): number {
  const start = nextWindowStartAfter(now, spec);
  return randomPoint(start, endOf(start, spec), rng);
}

/**
 * Boot-time recovery. A future plan is kept as-is. A stale plan inside the
 * current window is re-randomized in the remaining window. A plan whose window
 * has fully closed is recorded as missed and the next window is planned.
 */
export function planRecovery(
  now: number,
  nextRunAt: number | null,
  spec: WindowSpec,
  rng: () => number = Math.random,
): RecoveryPlan {
  if (nextRunAt !== null && nextRunAt > now) {
    return { target: nextRunAt, missed: null, reason: "future" };
  }

  const current = windowInstanceAt(now, spec);
  if (current) {
    const missed =
      nextRunAt !== null && nextRunAt < current.start ? { plannedAt: nextRunAt } : null;
    return {
      target: randomPoint(Math.max(now, current.start), current.end, rng),
      missed,
      reason: "in-window",
    };
  }

  const missed = nextRunAt !== null && nextRunAt <= now ? { plannedAt: nextRunAt } : null;
  const start = nextWindowStartAfter(now, spec);
  return {
    target: randomPoint(start, endOf(start, spec), rng),
    missed,
    reason: missed ? "missed" : "next-window",
  };
}
