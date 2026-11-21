/**
 * Schedule model shared by the scheduler, the API and the UI.
 *
 * Two kinds, both stored on the same task row so existing databases keep
 * working unchanged (`schedule_kind` defaults to `daily`):
 *
 *  - `daily`    – 定时执行：每天在 HH:mm–HH:mm 窗口内随机挑一个时刻执行一次。
 *                 这是 Jitter 最早的行为。
 *  - `interval` – 循环执行：每隔 N 秒 / 分钟 / 小时 / 天执行一次，可加抖动。
 *
 * 不支持 Cron 表达式：普通用户不需要看懂五段式语法，
 * 「每天一次」和「每隔 N 时间」已经覆盖实际用法。
 *
 * Pauses stay "whole local calendar days" for every kind: a run whose local
 * day falls inside `[paused_from, paused_until)` is skipped.
 */

import {
  parseWindow,
  planAfterRunWithPause,
  planPaused,
  planRecovery,
  planWithPause,
  nextWindowStartAfter,
  startOfLocalDay,
  windowInstanceAt,
  type PauseInterval,
  type WindowSpec,
} from "./window";

export type ScheduleKind = "daily" | "interval";

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ["daily", "interval"];

export const INTERVAL_MIN_SECONDS = 1;
/** 30 days; longer cycles are better expressed as a daily window. */
export const INTERVAL_MAX_SECONDS = 30 * 24 * 60 * 60;
/** Widest ± jitter around an exact time. */
export const MAX_DAILY_JITTER_MINUTES = 60;

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export interface ScheduleSpec {
  kind: ScheduleKind;
  /**
   * Effective window. For an exact-time task this is `[T-N, T+N]`
   * (jitter 0 → a zero-length "instant" window at T).
   */
  window: WindowSpec | null;
  /** `HH:mm` when the daily mode is "exact time"; null for a time range. */
  exactTime: string | null;
  /** ± minutes of jitter around `exactTime`; 0 means "exactly at that time". */
  jitterMinutes: number;
  /** Only for `interval`. */
  intervalSeconds: number | null;
  intervalJitterSeconds: number;
  /**
   * Optional first-run anchor for `interval`: the cycle is aligned to this
   * moment (e.g. "start at 09:00, every 2 hours" → 09:00, 11:00, 13:00).
   * `null` means "start counting from whenever it was created".
   */
  startAt: number | null;
}

export interface ScheduleFields {
  schedule_kind?: unknown;
  window_start?: unknown;
  window_end?: unknown;
  daily_jitter_minutes?: unknown;
  interval_seconds?: unknown;
  interval_jitter_seconds?: unknown;
  interval_start_at?: unknown;
}

export function normalizeScheduleKind(value: unknown): ScheduleKind {
  if (value === undefined || value === null || value === "") return "daily";
  if (value === "daily" || value === "interval") return value;
  throw new ScheduleError("调度方式必须是 daily（定时执行）或 interval（循环执行）");
}

function toInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ScheduleError(`${label}必须是整数`);
  }
  return parsed;
}

function minutesToHHMM(minutes: number): string {
  const clamped = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(
    2,
    "0",
  )}`;
}

/**
 * Effective window of an exact-time task: `[T-N, T+N]`, clamped to the same
 * calendar day so a run can never leak into a neighbouring day (that would
 * change pause attribution). `N = 0` yields an instant window at T.
 */
function exactTimeWindow(time: string, jitterMinutes: number): WindowSpec {
  if (jitterMinutes <= 0) return parseWindow(time, time);
  const [hours, minutes] = time.split(":").map(Number);
  const center = hours * 60 + minutes;
  return parseWindow(
    minutesToHHMM(center - jitterMinutes),
    minutesToHHMM(center + jitterMinutes),
  );
}

/**
 * Validate the scheduling part of a task payload. Three daily shapes share the
 * same two time fields:
 *
 *  - time range: `start < end` (end < start still means crossing midnight);
 *  - exact time: `start === end`;
 *  - exact time + jitter: `start === end` plus `daily_jitter_minutes`.
 */
export function buildSchedule(input: ScheduleFields): ScheduleSpec {
  const kind = normalizeScheduleKind(input.schedule_kind);

  if (kind === "daily") {
    const start = typeof input.window_start === "string" ? input.window_start.trim() : "";
    const end = typeof input.window_end === "string" ? input.window_end.trim() : "";
    const jitter = toInteger(input.daily_jitter_minutes, "抖动分钟") ?? 0;
    if (jitter < 0) throw new ScheduleError("抖动分钟不能是负数");
    if (jitter > MAX_DAILY_JITTER_MINUTES) {
      throw new ScheduleError(`抖动最多 ${MAX_DAILY_JITTER_MINUTES} 分钟`);
    }
    const exact = start !== "" && start === end;
    if (jitter > 0 && !exact) {
      throw new ScheduleError("只有「精确时间」才能设置抖动，请把开始和结束设为同一个时刻");
    }
    const window = exact ? exactTimeWindow(start, jitter) : parseWindow(start, end);
    return {
      kind,
      window,
      exactTime: exact ? start : null,
      jitterMinutes: jitter,
      intervalSeconds: null,
      intervalJitterSeconds: 0,
      startAt: null,
    };
  }

  const seconds = toInteger(input.interval_seconds, "执行间隔");
  if (seconds === null) throw new ScheduleError("请填写执行间隔");
  if (seconds < INTERVAL_MIN_SECONDS || seconds > INTERVAL_MAX_SECONDS) {
    throw new ScheduleError(
      `执行间隔必须在 ${INTERVAL_MIN_SECONDS} 秒到 ${INTERVAL_MAX_SECONDS / 86400} 天之间`,
    );
  }
  const jitter = toInteger(input.interval_jitter_seconds, "随机抖动") ?? 0;
  if (jitter < 0) throw new ScheduleError("随机抖动不能是负数");
  if (jitter > seconds) throw new ScheduleError("随机抖动不能大于执行间隔");

  const startAt = toInteger(input.interval_start_at, "首次执行时间");
  if (startAt !== null && startAt <= 0) {
    throw new ScheduleError("首次执行时间必须是有效的日期时间");
  }
  return {
    kind,
    window: null,
    exactTime: null,
    jitterMinutes: 0,
    intervalSeconds: seconds,
    intervalJitterSeconds: jitter,
    startAt,
  };
}

/** Rebuild the spec from a stored task row. */
export function scheduleOf(task: {
  schedule_kind?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  daily_jitter_minutes?: number | null;
  interval_seconds?: number | null;
  interval_jitter_seconds?: number | null;
  interval_start_at?: number | null;
}): ScheduleSpec {
  // Stored rows are read leniently: a hand-edited/bogus anchor must degrade to
  // "start from now" instead of making the whole task unschedulable.
  const rawStart = task.interval_start_at;
  const startAt =
    typeof rawStart === "number" && Number.isInteger(rawStart) && rawStart > 0 ? rawStart : null;
  const rawJitter = task.daily_jitter_minutes;
  const jitter =
    typeof rawJitter === "number" && Number.isInteger(rawJitter) && rawJitter >= 0
      ? Math.min(rawJitter, MAX_DAILY_JITTER_MINUTES)
      : 0;
  return buildSchedule({
    schedule_kind: task.schedule_kind ?? "daily",
    window_start: task.window_start ?? "",
    window_end: task.window_end ?? "",
    daily_jitter_minutes: jitter,
    interval_seconds: task.interval_seconds ?? null,
    interval_jitter_seconds: task.interval_jitter_seconds ?? 0,
    interval_start_at: startAt,
  });
}

export function formatSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.kind === "daily") {
    if (spec.exactTime !== null) {
      return spec.jitterMinutes > 0
        ? `每天 ${spec.exactTime}（±${spec.jitterMinutes} 分钟内随机）`
        : `每天 ${spec.exactTime}`;
    }
    const window = spec.window;
    if (!window) return "定时执行";
    const across = window.crossMidnight ? "（跨午夜）" : "";
    return `每天 ${window.start}–${window.end}${across} 随机一次`;
  }
  const base = `每 ${formatSeconds(spec.intervalSeconds ?? 0)}`;
  const anchor =
    spec.startAt !== null ? `（从 ${formatAnchor(spec.startAt)} 起算）` : "";
  const jitter =
    spec.intervalJitterSeconds > 0
      ? `，另加随机 0–${spec.intervalJitterSeconds} 秒抖动`
      : "";
  return `${base}${anchor}${jitter}`;
}

/** True when two specs would schedule differently (used to keep pending plans). */
export function sameSchedule(a: ScheduleSpec, b: ScheduleSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "daily") {
    return (
      a.window?.start === b.window?.start &&
      a.window?.end === b.window?.end &&
      a.jitterMinutes === b.jitterMinutes
    );
  }
  return (
    a.intervalSeconds === b.intervalSeconds &&
    a.intervalJitterSeconds === b.intervalJitterSeconds &&
    // The anchor defines the grid: moving it must re-plan, otherwise the new
    // "start at 09:00" would only take effect after the old plan fired once.
    a.startAt === b.startAt
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local label for the anchor; keeps the year only when it is not this year. */
function formatAnchor(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}-`;
  return `${year}${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;
}

/**
 * Smallest `anchor + k × interval` strictly after `from` (k ≥ 0).
 * Keeps "start at 09:00, every 2 hours" on 09:00 / 11:00 / 13:00 even if the
 * task was created, restarted or paused in between.
 */
function nextTickAfter(from: number, anchor: number, interval: number): number {
  if (from < anchor) return anchor;
  const steps = Math.floor((from - anchor) / interval) + 1;
  return anchor + steps * interval;
}

function pauseCovers(timestamp: number, pause: PauseInterval | null): boolean {
  if (!pause || pause.until <= pause.from) return false;
  const day = startOfLocalDay(timestamp);
  return day >= pause.from && day < pause.until;
}

function jitterMilliseconds(spec: ScheduleSpec, rng: () => number): number {
  if (spec.intervalJitterSeconds <= 0) return 0;
  return Math.floor(rng() * (spec.intervalJitterSeconds * 1000 + 1));
}

/** Next occurrence strictly after `from`, for interval schedules. */
function nextOccurrence(from: number, spec: ScheduleSpec, rng: () => number): number {
  const interval = (spec.intervalSeconds ?? 1) * 1000;
  const base =
    spec.startAt !== null ? nextTickAfter(from, spec.startAt, interval) : from + interval;
  return base + jitterMilliseconds(spec, rng);
}

/** Skip the paused whole days without stepping one occurrence at a time. */
function skipPausedDays(
  from: number,
  spec: ScheduleSpec,
  pause: PauseInterval | null,
  rng: () => number,
): number {
  let candidate = nextOccurrence(from, spec, rng);
  for (let attempt = 0; attempt < 8 && pauseCovers(candidate, pause); attempt += 1) {
    const resumeFrom = Math.max(from, pause!.until - 1);
    candidate = nextOccurrence(resumeFrom, spec, rng);
  }
  return candidate;
}

export interface PlanResult {
  target: number;
  /** A previous plan that was skipped without running (startup recovery only). */
  missedPlannedAt: number | null;
}

/** First run for a brand-new / resumed task. */
export function planScheduleNew(
  now: number,
  spec: ScheduleSpec,
  pause: PauseInterval | null = null,
  rng: () => number = Math.random,
): number {
  if (spec.kind === "daily") {
    if (!spec.window) throw new ScheduleError("窗口配置缺失");
    return planWithPause(now, spec.window, pause, rng);
  }
  return skipPausedDays(now, spec, pause, rng);
}

/** The run that just finished was `firedAt`; when is the next one? */
export function planScheduleAfter(
  now: number,
  spec: ScheduleSpec,
  firedAt: number,
  pause: PauseInterval | null = null,
  rng: () => number = Math.random,
): number {
  if (spec.kind === "daily") {
    if (!spec.window) throw new ScheduleError("窗口配置缺失");
    return planAfterRunWithPause(now, spec.window, pause, rng);
  }
  // Drift-free: keep the grid anchored on the moment that was scheduled so a
  // 2-second request every minute does not creep later and later. Only when
  // the request overran the next tick do we restart the grid from now.
  const interval = (spec.intervalSeconds ?? 1) * 1000;
  if (spec.startAt !== null) {
    // A user-defined anchor wins over "anchor on the previous run": the next
    // grid tick after the run, and never one that is already in the past.
    return skipPausedDays(Math.max(firedAt, now), spec, pause, rng);
  }
  const base = firedAt + interval <= now ? now : firedAt;
  return skipPausedDays(base, spec, pause, rng);
}

/**
 * How late a target may be before it counts as "missed" instead of "run now".
 * A suspended machine must not silently replay days of every-minute jobs.
 */
export function scheduleLatenessTolerance(spec: ScheduleSpec): number {
  if (spec.kind === "daily") return 0;
  const period = (spec.intervalSeconds ?? 60) * 1000;
  return Math.min(60_000, Math.max(5_000, period));
}

export function isMissedNonDaily(now: number, target: number, spec: ScheduleSpec): boolean {
  return now - target > scheduleLatenessTolerance(spec);
}

/** Startup recovery for interval tasks (daily keeps `planRecovery`). */
export function planScheduleRecovery(
  now: number,
  spec: ScheduleSpec,
  nextRunAt: number | null,
  pause: PauseInterval | null = null,
  rng: () => number = Math.random,
): PlanResult {
  if (spec.kind === "daily") {
    if (!spec.window) throw new ScheduleError("窗口配置缺失");
    const plan = planRecovery(now, nextRunAt, spec.window, rng);
    return { target: plan.target, missedPlannedAt: plan.missed?.plannedAt ?? null };
  }

  if (nextRunAt !== null && nextRunAt > now) {
    return { target: nextRunAt, missedPlannedAt: null };
  }
  if (nextRunAt !== null && !isMissedNonDaily(now, nextRunAt, spec)) {
    // Still inside the tolerance window: run it as soon as possible instead of
    // dropping a tick that is only milliseconds/seconds late.
    return { target: Math.max(now, nextRunAt), missedPlannedAt: null };
  }
  const missed = nextRunAt;
  return { target: skipPausedDays(now, spec, pause, rng), missedPlannedAt: missed };
}

/** True when the stored plan belongs to a paused day (non-daily kinds). */
export function schedulePlanPaused(
  target: number,
  spec: ScheduleSpec,
  pause: PauseInterval | null,
): boolean {
  if (spec.kind === "daily") {
    return spec.window ? planPaused(target, spec.window, pause) : false;
  }
  return pauseCovers(target, pause);
}

export interface SchedulePreview {
  description: string;
  /** Next few planned moments. */
  next: number[];
}

/** Deterministic preview for the form ("when will this actually run?"). */
export function previewSchedule(
  spec: ScheduleSpec,
  now: number = Date.now(),
  count: number = 5,
): SchedulePreview {
  const next: number[] = [];
  if (spec.kind === "daily") {
    if (spec.window) {
      // A still-open window WILL run today, so it must be the first entry:
      // using nextWindowStartAfter() alone would silently skip to tomorrow.
      const current = windowInstanceAt(now, spec.window);
      let start = current ? current.start : nextWindowStartAfter(now, spec.window);
      for (let index = 0; index < count; index += 1) {
        next.push(start);
        start = nextWindowStartAfter(start + 1000, spec.window);
      }
    }
    return { description: describeSchedule(spec), next };
  }

  const step = (spec.intervalSeconds ?? 0) * 1000;
  let cursor = now;
  for (let index = 0; index < count; index += 1) {
    cursor =
      spec.startAt !== null ? nextTickAfter(cursor, spec.startAt, step) : cursor + step;
    next.push(cursor);
  }
  return { description: describeSchedule(spec), next };
}
