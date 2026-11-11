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

/** Longest pause exposed to the UI, in days. */
export const MAX_PAUSE_DAYS = 15;

/**
 * A pause is a half-open interval of whole LOCAL calendar days:
 * `[from, until)` = `[start day 00:00, start day + N days 00:00)`.
 * It is deliberately not "N × 24h from now" — starting a 2-day pause at noon
 * on Monday pauses Monday and Tuesday, not "48 hours".
 */
export interface PauseInterval {
  from: number;
  until: number;
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

/** Local midnight of `now`, optionally shifted by whole calendar days. */
export function startOfLocalDay(now: number, offsetDays: number = 0): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (offsetDays !== 0) date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

/**
 * Build the pause interval from the user's two choices.
 *
 * - `startsToday: true`  → `[today 00:00, today + N days 00:00)`.
 *   Today is a FULL paused day regardless of the current clock, so every
 *   remaining window today (including an afternoon one) is skipped.
 * - `startsToday: false` → `[tomorrow 00:00, tomorrow + N days 00:00)`.
 *   Today is untouched: windows later today still fire normally.
 *
 * In both cases exactly N whole calendar days are paused. Monday noon +
 * 2 days starting today = Monday + Tuesday, resume Wednesday 00:00.
 */
export function pauseInterval(now: number, days: number, startsToday: boolean): PauseInterval {
  const startOffset = startsToday ? 0 : 1;
  return {
    from: startOfLocalDay(now, startOffset),
    until: startOfLocalDay(now, startOffset + days),
  };
}

/** First moment a paused task may run again; kept for callers using the old API. */
export function pauseResumeAt(now: number, days: number, startsToday: boolean): number {
  return pauseInterval(now, days, startsToday).until;
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

/**
 * Whether a planned run belongs to a paused calendar day.
 *
 * The decision uses the day the WINDOW INSTANCE STARTED ON (see
 * `windowInstanceAt`), never the wall-clock instant of the run and never the
 * instant the pause was configured. This keeps cross-midnight windows correct:
 * the 23:50–00:10 window belongs to start day D, so a run at D+1 00:05 is
 * still D's run. A pause "starting tomorrow" must not swallow that tail, and
 * a pause "starting today" must swallow it.
 */
export function planPaused(
  target: number,
  spec: WindowSpec,
  pause: PauseInterval | null,
): boolean {
  if (!pause || pause.until <= pause.from) return false;
  const instance = windowInstanceAt(target, spec);
  if (!instance) return false;
  const day = startOfLocalDay(instance.start);
  return day >= pause.from && day < pause.until;
}

/**
 * A random point inside the RESUME DAY'S OWN window instance. `until` is local
 * midnight, so `localAt(until, ...)` picks that day's window start. Using
 * `planNewTask(until, ...)` would be wrong for cross-midnight windows:
 * midnight sits in the PREVIOUS day's 23:50–00:10 instance, which is still
 * inside the pause.
 */
export function planResumeWindow(
  until: number,
  spec: WindowSpec,
  rng: () => number = Math.random,
): number {
  const start = localAt(until, spec.startMinutes);
  return randomPoint(start, endOf(start, spec), rng);
}

/**
 * Plan the next run from `from`. When the nearest window's day is paused, jump
 * to the resume day's window. When `from` is before the interval (e.g. pausing
 * "from tomorrow" while it is still Monday noon), Monday's plan is kept.
 */
export function planWithPause(
  from: number,
  spec: WindowSpec,
  pause: PauseInterval | null,
  rng: () => number = Math.random,
): number {
  if (!pause || from >= pause.until) return planNewTask(from, spec, rng);
  const candidate = planNewTask(from, spec, rng);
  if (!planPaused(candidate, spec, pause)) return candidate;
  return planResumeWindow(pause.until, spec, rng);
}

/** Plan the window AFTER a completed run, skipping paused days. */
export function planAfterRunWithPause(
  now: number,
  spec: WindowSpec,
  pause: PauseInterval | null,
  rng: () => number = Math.random,
): number {
  const candidate = planNextWindowAfter(now, spec, rng);
  if (!pause || !planPaused(candidate, spec, pause)) return candidate;
  return planResumeWindow(pause.until, spec, rng);
}
