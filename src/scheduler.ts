import {
  deleteTask as deleteTaskRecord,
  getEffectiveRetentionDays,
  getTask,
  incrementalVacuum,
  insertLog,
  listTasks,
  pruneLogs,
  setTaskPause,
  updateTaskConfig,
  updateTaskNextRun,
  updateTaskStatus,
} from "./db";
import { executeTaskRun } from "./executor";
import { getActiveConfig } from "./config";
import {
  MAX_PAUSE_DAYS,
  classifyTimerFire,
  pauseInterval,
  windowInstanceAt,
  type PauseInterval,
  type WindowSpec,
} from "./window";
import {
  buildSchedule,
  describeSchedule,
  isMissedNonDaily,
  planScheduleAfter,
  planScheduleNew,
  planScheduleRecovery,
  sameSchedule,
  scheduleOf,
  schedulePlanPaused,
  type ScheduleSpec,
} from "./schedule";
import type { NewTaskInput, TaskRow } from "./types";
import type { RunOutcome } from "./executor";

export class PauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PauseError";
  }
}

export class RunNowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNowError";
  }
}

export interface PauseOptions {
  days: number;
  startsToday?: boolean;
}

export interface SchedulerRuntime {
  generation: number;
  timeout: ReturnType<typeof setTimeout> | null;
  timeoutTarget: number | null;
  abortController: AbortController | null;
  running: boolean;
  /** When the in-flight run started (epoch ms); null while idle. */
  runningSince: number | null;
  /** Resolves when an in-flight executeTaskRun finishes (including its log write). */
  activeRun: Promise<unknown> | null;
  /** Schedule in force when the in-flight run started; changed mid-run by editTask. */
  runScheduleKey: string | null;
  /** Set when editTask changes the schedule during that run. */
  scheduleChangedInFlight: boolean;
}

export interface StartSummary {
  active: number;
  recovered: number;
  missed: number;
}

const runtimes = new Map<string, SchedulerRuntime>();

/** Manual "run now" calls in flight, so deletion can abort and await them. */
interface ManualRun {
  controller: AbortController;
  promise: Promise<RunOutcome>;
  startedAt: number;
}
const manualRuns = new Map<string, ManualRun>();

/** setTimeout overflows above ~24.8 days; re-arm in slices for long gaps. */
const MAX_TIMER_DELAY_MS = 6 * 60 * 60 * 1000;

function ensureRuntime(taskId: string): SchedulerRuntime {
  let runtime = runtimes.get(taskId);
  if (!runtime) {
    runtime = {
      generation: 0,
      timeout: null,
      timeoutTarget: null,
      abortController: null,
      running: false,
      runningSince: null,
      activeRun: null,
      runScheduleKey: null,
      scheduleChangedInFlight: false,
    };
    runtimes.set(taskId, runtime);
  }
  return runtime;
}

/**
 * Tasks that are executing right now: task id → when the run started.
 *
 * The scheduler knows this, but the database does not: a request that hangs
 * would keep the task "running" forever with no visible sign. The API merges
 * this into the task list so the UI can show "执行中 · 已 x 分 y 秒".
 */
export function runningTasks(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [taskId, runtime] of runtimes) {
    if (runtime.running && runtime.runningSince !== null) {
      result[taskId] = runtime.runningSince;
    }
  }
  for (const [taskId, manual] of manualRuns) {
    if (!(taskId in result)) result[taskId] = manual.startedAt;
  }
  return result;
}

/**
 * The pause interval while it still matters, otherwise null.
 *
 * `from` may be in the FUTURE (a pause configured "starting tomorrow"): the
 * interval is still live, it just does not cover today's windows — `planPaused`
 * decides that per window day. Judging `paused_until > now` alone was the old
 * bug: configuring a pause at noon immediately swallowed that afternoon's run.
 */
function currentPause(task: TaskRow, now: number): PauseInterval | null {
  if (task.paused_until === null || task.paused_until <= now) return null;
  if (task.paused_from === null || task.paused_until <= task.paused_from) return null;
  return { from: task.paused_from, until: task.paused_until };
}

/** Return the live interval and clear stale pause columns once it has expired. */
function livePause(task: TaskRow, now: number): PauseInterval | null {
  const pause = currentPause(task, now);
  if (pause === null && task.paused_until !== null) {
    setTaskPause(task.id, null, task.next_run_at, now);
  }
  return pause;
}

/**
 * Pick the next run for a paused task. An existing plan is reused ONLY when it
 * belongs to the same window instance a fresh plan would choose. That keeps
 * "start tomorrow" from re-randomising today's afternoon moment, while also
 * preventing a shorter pause from inheriting a far-future plan left over by a
 * previous longer pause (which would silently skip the resume day).
 */
/**
 * Is `timestamp` a tick of an anchored interval grid? Jitter is applied on top
 * of the tick, so anything from the tick up to tick+jitter counts as on-grid.
 */
function isOnIntervalGrid(timestamp: number, spec: ScheduleSpec): boolean {
  if (spec.startAt === null) return true;
  if (timestamp < spec.startAt) return false;
  const interval = (spec.intervalSeconds ?? 1) * 1000;
  const jitter = spec.intervalJitterSeconds * 1000;
  const remainder = (timestamp - spec.startAt) % interval;
  return remainder === 0 || (jitter > 0 && remainder <= jitter);
}

function preferredPlan(
  task: TaskRow,
  now: number,
  spec: ScheduleSpec,
  pause: PauseInterval | null,
): number {
  const candidate = planScheduleNew(now, spec, pause);
  const pending = task.next_run_at;
  if (pending === null || pending <= now || schedulePlanPaused(pending, spec, pause)) {
    return candidate;
  }
  // Interval plans are absolute moments; keep a FUTURE, non-paused plan
  // only when it is earlier than what a fresh plan would pick. Keeping an
  // arbitrarily later plan is the non-daily version of the "shortened pause"
  // bug: a 10-day pause leaves next_run_at 10 days out, and re-pausing for one
  // day must pull it back instead of silently waiting 9 extra days.
  if (spec.kind !== "daily" || !spec.window) {
    // An anchored task owns a grid: a pending moment that is not on it (e.g.
    // left over from before the anchor was set) must be replaced even when it
    // is earlier than the next tick, otherwise "start at 09:00" would only
    // take effect after the old plan fired once.
    if (!isOnIntervalGrid(pending, spec)) return candidate;
    return pending < candidate ? pending : candidate;
  }

  const pendingWindow = windowInstanceAt(pending, spec.window);
  const candidateWindow = windowInstanceAt(candidate, spec.window);
  if (
    pendingWindow === null ||
    candidateWindow === null ||
    pendingWindow.start !== candidateWindow.start
  ) {
    return candidate;
  }
  return pending;
}

function formatLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `executed_at` is the write time; the missed plan is kept in the message so
 * retention (which filters on executed_at) never deletes a fresh miss. */
function recordMiss(
  task: TaskRow,
  plannedAt: number,
  spec?: ScheduleSpec,
  now: number = Date.now(),
): void {
  // Daily keeps the original wording (users and older logs already know it);
  // Interval schedules say WHICH schedule was missed instead of a window.
  const detail =
    !spec || spec.kind === "daily"
      ? `错过执行窗口（计划 ${formatLocal(plannedAt)}，窗口 ${task.window_start}–${task.window_end}），未补跑`
      : `错过计划执行（计划 ${formatLocal(plannedAt)}，调度 ${describeSchedule(spec)}），未补跑`;
  insertLog({
    task_id: task.id,
    executed_at: now,
    request_url: task.request_url,
    request_method: task.request_method,
    request_headers: task.request_headers,
    request_body: task.request_body,
    response_status: null,
    response_headers: null,
    response_body: null,
    duration_ms: null,
    error: detail,
    aborted: 0,
    kind: "missed",
    parent_log_id: null,
    matched: null,
  });
  console.warn(
    `[jitter] 任务「${task.name}」错过了 ${formatLocal(plannedAt)} 的计划执行，已记录且不补跑`,
  );
}

/**
 * Safety net: every task is driven by its own timer, and a timer can be lost
 * if a replan throws (e.g. a hand-edited row) or a timer callback is dropped.
 * A cheap sweep re-arms anything whose stored plan is not backed by a live
 * timer. This replaces the old per-task daily trigger and works for both
 * scheduling kinds.
 */
const SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function sweepSchedules(): void {
  const now = Date.now();
  for (const task of listTasks()) {
    if (task.status !== "active") continue;
    const runtime = runtimes.get(task.id);
    if (!runtime || runtime.running) continue;
    if (task.next_run_at === null) {
      try {
        replan(task.id, planScheduleNew(now, scheduleOf(task), livePause(task, now)));
      } catch (error) {
        console.error(`[jitter] 任务 ${task.id} 缺少计划且无法重排`, error);
      }
      continue;
    }
    if (runtime.timeout === null || runtime.timeoutTarget !== task.next_run_at) {
      armTimer(task.id, task.next_run_at, runtime.generation);
    }
  }
}

function startSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    try {
      sweepSchedules();
      sweepRetention();
    } catch (error) {
      console.error("[jitter] 调度巡检失败", error);
    }
  }, SWEEP_INTERVAL_MS);
}

/**
 * Automatic log retention. Runs with the sweep, but only every few minutes:
 * deleting rows is cheap, reclaiming their space is not, so the space is given
 * back in small chunks instead of one long VACUUM that would freeze the UI.
 */
let lastRetentionPass = 0;
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;

function sweepRetention(now: number = Date.now()): void {
  const retentionDays = getEffectiveRetentionDays();
  const maxRows = getActiveConfig().logMaxRowsPerTask;
  if (retentionDays <= 0 && maxRows <= 0) return;
  if (now - lastRetentionPass < RETENTION_INTERVAL_MS) return;
  lastRetentionPass = now;

  try {
    const outcome = pruneLogs(now, retentionDays, maxRows);
    if (outcome.deleted > 0) {
      console.log(`[jitter] 日志保留策略：清理了 ${outcome.deleted} 条旧日志`);
    }
    // Give the freed pages back in bounded chunks (4 KiB pages).
    incrementalVacuum(64);
  } catch (error) {
    console.error("[jitter] 日志保留策略执行失败", error);
  }
}

function stopSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function armTimer(taskId: string, target: number, generation: number): void {
  const runtime = ensureRuntime(taskId);
  if (runtime.timeout !== null) {
    clearTimeout(runtime.timeout);
  }
  runtime.timeoutTarget = target;
  const delay = Math.max(0, target - Date.now());
  if (delay > MAX_TIMER_DELAY_MS) {
    // Long gap (e.g. a daily window tomorrow): wake up later just to re-arm,
    // keeping the same target and generation.
    runtime.timeout = setTimeout(() => {
      const current = runtimes.get(taskId);
      if (!current || current.generation !== generation) return;
      armTimer(taskId, target, generation);
    }, MAX_TIMER_DELAY_MS);
    return;
  }
  runtime.timeout = setTimeout(() => {
    void onTimer(taskId, generation, target).catch((error) => {
      console.error(`[jitter] 任务 ${taskId} 的定时执行失败`, error);
    });
  }, delay);
}

/** Persist a new plan and replace the pending timer under a fresh generation. */
function replan(taskId: string, target: number): void {
  const runtime = ensureRuntime(taskId);
  runtime.generation += 1;
  updateTaskNextRun(taskId, target);
  armTimer(taskId, target, runtime.generation);
}

async function onTimer(taskId: string, generation: number, target: number): Promise<void> {
  const runtime = runtimes.get(taskId);
  if (!runtime || runtime.generation !== generation) return;
  runtime.timeout = null;
  runtime.timeoutTarget = null;
  if (runtime.running) return;

  const task = getTask(taskId);
  if (!task || task.status !== "active") return;
  if (task.next_run_at !== target) return;

  const now = Date.now();
  if (target > now) {
    armTimer(taskId, target, generation);
    return;
  }

  let spec: ScheduleSpec;
  try {
    spec = scheduleOf(task);
  } catch (error) {
    console.error(`[jitter] 任务 ${taskId} 的调度配置无效，跳过本次执行`, error);
    return;
  }

  const pause = livePause(task, now);
  if (schedulePlanPaused(target, spec, pause)) {
    try {
      replan(taskId, planScheduleNew(now, spec, pause));
    } catch (error) {
      console.error(`[jitter] 任务 ${taskId} 规划暂停后的执行失败`, error);
    }
    return;
  }

  const missed =
    spec.kind === "daily"
      ? spec.window !== null && classifyTimerFire(now, target, spec.window) === "miss"
      : isMissedNonDaily(now, target, spec);

  if (missed) {
    recordMiss(task, target, spec);
    try {
      replan(taskId, planScheduleNew(now, spec, pause));
    } catch (error) {
      console.error(`[jitter] 任务 ${taskId} 规划下一次执行失败`, error);
    }
    return;
  }

  runtime.running = true;
  runtime.runningSince = Date.now();
  runtime.runScheduleKey = describeSchedule(spec);
  runtime.scheduleChangedInFlight = false;
  const controller = new AbortController();
  runtime.abortController = controller;
  const activeRun = executeTaskRun(task, controller.signal);
  runtime.activeRun = activeRun;

  try {
    await activeRun;
  } catch (error) {
    console.error(`[jitter] 任务 ${taskId} 执行异常`, error);
  } finally {
    const current = runtimes.get(taskId);
    if (current !== runtime) return;
    runtime.running = false;
    runtime.runningSince = null;
    runtime.abortController = null;
    runtime.activeRun = null;
    if (runtime.generation !== generation) return;

    const latest = getTask(taskId);
    if (latest && latest.status === "active") {
      try {
        const latestSpec = scheduleOf(latest);
        const now = Date.now();
        const pause = livePause(latest, now);
        // The run consumed the OLD plan. If editTask changed the schedule while
        // it was in flight, the new one has not run yet: plan freshly inside it
        // instead of treating the new schedule as already consumed.
        const nextTarget = runtime.scheduleChangedInFlight
          ? planScheduleNew(now, latestSpec, pause)
          : planScheduleAfter(now, latestSpec, target, pause);
        runtime.scheduleChangedInFlight = false;
        runtime.runScheduleKey = null;
        replan(taskId, nextTarget);
      } catch (error) {
        console.error(`[jitter] 任务 ${taskId} 规划下一次执行失败`, error);
      }
    }
  }
}

export function scheduleNewTask(task: TaskRow): TaskRow {
  if (task.status !== "active") return task;
  const spec = scheduleOf(task);
  const runtime = ensureRuntime(task.id);
  runtime.generation += 1;
  const now = Date.now();
  const pause = livePause(task, now);
  const target = planScheduleNew(now, spec, pause);
  if (pause !== null) {
    setTaskPause(task.id, pause, target, now);
  } else if (task.paused_until !== null) {
    setTaskPause(task.id, null, target, now);
  } else {
    updateTaskNextRun(task.id, target);
  }
  armTimer(task.id, target, runtime.generation);
  return getTask(task.id) ?? task;
}

/** Build the spec a payload describes, using the same rules the API enforces. */
function specFromInput(input: NewTaskInput): ScheduleSpec {
  return buildSchedule({
    schedule_kind: input.schedule_kind ?? "daily",
    window_start: input.window_start,
    window_end: input.window_end,
    daily_jitter_minutes: input.daily_jitter_minutes ?? 0,
    interval_seconds: input.interval_seconds ?? null,
    interval_jitter_seconds: input.interval_jitter_seconds ?? 0,
    interval_start_at: input.interval_start_at ?? null,
  });
}

/**
 * Replace an existing task's configuration and keep it scheduled.
 *
 * The new schedule is validated before anything is written. An existing future
 * plan is kept ONLY when the schedule did not change: it is a concrete moment
 * owned by an armed timer, and re-planning could schedule a SECOND run in the
 * already-consumed window. When the schedule DID change, that plan belongs to
 * the old spec: keeping it would make onTimer judge it "missed" against the new
 * one (no request, spurious missed log), so we replan.
 * A stopped task is only updated — resuming later schedules from the new config.
 *
 * While a request is in flight we deliberately do NOT bump the generation or
 * touch the timer (same rule as pause/resume): that request's `finally` owns
 * the next plan and reads the just-written config. A schedule change is
 * recorded on the runtime so that `finally` plans freshly instead of treating
 * the new schedule as already consumed.
 */
export function editTask(taskId: string, input: NewTaskInput): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;

  const spec = specFromInput(input);
  let changed = true;
  try {
    changed = !sameSchedule(scheduleOf(task), spec);
  } catch {
    // An unreadable old schedule is replaced wholesale.
    changed = true;
  }

  const updated = updateTaskConfig(taskId, input);
  if (!updated) return null;
  if (updated.status !== "active") return updated;

  const runtime = ensureRuntime(taskId);
  if (runtime.running) {
    if (changed) runtime.scheduleChangedInFlight = true;
    return updated;
  }

  const now = Date.now();
  // Keep a live plan only when the schedule is unchanged: its armed timer still
  // matches the spec. A changed schedule makes the old plan meaningless.
  if (!changed && updated.next_run_at !== null && updated.next_run_at > now) {
    return updated;
  }
  const pause = livePause(updated, now);
  const target = planScheduleNew(now, spec, pause);

  runtime.generation += 1;
  if (runtime.timeout !== null) {
    clearTimeout(runtime.timeout);
  }
  runtime.timeout = null;
  runtime.timeoutTarget = null;

  if (pause !== null) {
    setTaskPause(taskId, pause, target, now);
  } else if (updated.paused_until !== null) {
    setTaskPause(taskId, null, target, now);
  } else {
    updateTaskNextRun(taskId, target);
  }
  armTimer(taskId, target, runtime.generation);
  return getTask(taskId) ?? updated;
}

/**
 * Pause an active task for 1–15 WHOLE CALENDAR DAYS starting today or tomorrow
 * (tomorrow by default). A plan outside the interval is kept, so "start
 * tomorrow" configured at noon still runs this afternoon.
 * A request already in flight is allowed to finish.
 */
export function pauseTask(
  taskId: string,
  options: PauseOptions,
  now: number = Date.now(),
): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;
  if (task.status !== "active") {
    throw new PauseError("任务已停止，无法暂停；请先恢复任务");
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > MAX_PAUSE_DAYS) {
    throw new PauseError(`暂停天数必须是 1–${MAX_PAUSE_DAYS} 的整数`);
  }

  const spec = scheduleOf(task);
  const pause = pauseInterval(now, options.days, options.startsToday === true);
  const runtime = ensureRuntime(taskId);

  // A request is in flight: its own onTimer finally owns the next plan and
  // reads the latest pause state from the DB. Bumping the generation here
  // would suppress that finally, and arming a timer in the ALREADY CONSUMED
  // schedule would either run it twice or strand the task with no timer.
  if (runtime.running) {
    setTaskPause(taskId, pause, task.next_run_at, now);
    return getTask(taskId);
  }

  // Keep today's already-randomised plan when the pause starts tomorrow, but
  // never keep a plan that belongs to a different (e.g. far-future) window.
  const target = preferredPlan(task, now, spec, pause);

  runtime.generation += 1;
  if (runtime.timeout !== null) {
    clearTimeout(runtime.timeout);
  }
  runtime.timeout = null;
  runtime.timeoutTarget = null;

  setTaskPause(taskId, pause, target, now);
  armTimer(taskId, target, runtime.generation);
  return getTask(taskId);
}

export function startScheduler(): StartSummary {
  const active = listTasks().filter((task) => task.status === "active");
  let recovered = 0;
  let missed = 0;
  startSweep();
  // Apply the retention policy once at startup so a restart also reclaims
  // space from logs that aged out while the service was down.
  sweepRetention();

  for (const task of active) {
    try {
      const spec = scheduleOf(task);
      const now = Date.now();
      const runtime = ensureRuntime(task.id);
      runtime.generation += 1;

      const pause = livePause(task, now);
      if (pause !== null) {
        // "Start tomorrow" must survive a restart without losing today's
        // afternoon run, but a stale far-future plan must not outlive a
        // shortened pause.
        const target = preferredPlan(task, now, spec, pause);
        updateTaskNextRun(task.id, target);
        armTimer(task.id, target, runtime.generation);
        recovered += 1;
        continue;
      }

      const plan = planScheduleRecovery(now, spec, task.next_run_at, pause);
      if (plan.missedPlannedAt !== null) {
        recordMiss(task, plan.missedPlannedAt, spec);
        missed += 1;
      }
      if (task.paused_until !== null) {
        // The pause expired (or predates paused_from); clear it on the way.
        setTaskPause(task.id, null, plan.target, now);
      } else {
        updateTaskNextRun(task.id, plan.target);
      }
      armTimer(task.id, plan.target, runtime.generation);
      recovered += 1;
    } catch (error) {
      console.error(`[jitter] 恢复任务 ${task.id}（${task.name}）失败`, error);
    }
  }

  return { active: active.length, recovered, missed };
}

export function stopTask(taskId: string): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;

  const runtime = runtimes.get(taskId);
  if (runtime) {
    runtime.generation += 1;
    if (runtime.timeout !== null) {
      clearTimeout(runtime.timeout);
    }
    runtime.timeout = null;
    runtime.timeoutTarget = null;
    runtime.abortController?.abort();
    runtime.abortController = null;
    runtime.runScheduleKey = null;
    runtime.scheduleChangedInFlight = false;
    runtimes.delete(taskId);
  }

  updateTaskStatus(taskId, "stopped", null);
  if (task.paused_until !== null) {
    setTaskPause(taskId, null, null);
  }
  return getTask(taskId);
}

export interface RunNowOutcome {
  task: TaskRow;
  outcome: RunOutcome;
}

/**
 * Run a task once, immediately, without touching its schedule: next_run_at
 * and the pending timer are left exactly as they are, so the next planned run
 * is unaffected. The full executeTaskRun path is reused, so the run is logged,
 * goes through the pre-run guard and can fire notifications.
 *
 * Concurrency: a task already executing (scheduled or manual) cannot be run
 * again — that would duplicate side effects such as a check-in POST.
 */
export async function runTaskNow(taskId: string): Promise<RunNowOutcome | null> {
  const task = getTask(taskId);
  if (!task) return null;

  const runtime = runtimes.get(taskId);
  if (runtime?.running || manualRuns.has(taskId)) {
    throw new RunNowError("任务正在执行中，请等待本次完成后再试");
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const promise = executeTaskRun(task, controller.signal);
  manualRuns.set(taskId, { controller, promise, startedAt });
  try {
    const outcome = await promise;
    return { task, outcome };
  } finally {
    manualRuns.delete(taskId);
  }
}

export interface DeleteTaskOutcome {
  task: TaskRow;
  deleted_logs: number;
  deleted_test_runs: number;
}

/**
 * Delete a task and everything under it.
 *
 * The runtime is torn down and removed from the map FIRST: an in-flight
 * onTimer finally then sees `current !== runtime` and skips replanning, and a
 * late sweep tick finds no runtime and returns. The abort signal is raised so
 * executeTaskRun settles quickly, and we await it before touching the DB —
 * its aborted-request log must be written while the task row still exists,
 * otherwise `logs.task_id -> tasks.id` would reject the insert (or leave an
 * orphan). Only after that does a single transaction remove the task + logs.
 */
export async function deleteTask(taskId: string): Promise<DeleteTaskOutcome | null> {
  const task = getTask(taskId);
  if (!task) return null;

  const runtime = runtimes.get(taskId);
  const pending: Promise<unknown>[] = [];
  if (runtime) {
    runtime.generation += 1;
    if (runtime.timeout !== null) clearTimeout(runtime.timeout);
    runtime.timeout = null;
    runtime.timeoutTarget = null;
    runtime.abortController?.abort();
    runtime.abortController = null;
    runtime.runScheduleKey = null;
    runtime.scheduleChangedInFlight = false;
    if (runtime.activeRun) pending.push(runtime.activeRun);
    // Remove before awaiting so onTimer's finally skips replanning and any
    // sweep/timer callback that slips in finds no runtime.
    runtimes.delete(taskId);
  }

  // A manual "run now" is independent of runtime: abort it too and let it
  // write its log while the task row still exists, before we delete the row.
  const manual = manualRuns.get(taskId);
  if (manual) {
    manual.controller.abort();
    pending.push(manual.promise);
  }

  for (const task of pending) {
    try {
      await task;
    } catch (error) {
      console.error(`[jitter] 任务 ${taskId} 删除前收尾失败`, error);
    }
  }

  const outcome = deleteTaskRecord(taskId);
  return {
    task,
    deleted_logs: outcome.deleted_logs,
    deleted_test_runs: outcome.deleted_test_runs,
  };
}

export function resumeTask(taskId: string): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;

  if (task.status === "active") {
    const now = Date.now();
    const pause = livePause(task, now);
    if (pause !== null || task.paused_until !== null) {
      const runtime = ensureRuntime(taskId);
      // Same in-flight rule as pauseTask: only clear the pause, let the
      // running request's finally plan the next run. Planning here would
      // target the already-consumed schedule and cause a double run / stall.
      if (runtime.running) {
        setTaskPause(taskId, null, task.next_run_at, now);
        return getTask(taskId);
      }
      // Cancelling a pause resumes scheduling immediately, even mid-window.
      const spec = scheduleOf(task);
      runtime.generation += 1;
      if (runtime.timeout !== null) {
        clearTimeout(runtime.timeout);
      }
      runtime.timeout = null;
      runtime.timeoutTarget = null;
      const target = planScheduleNew(now, spec, null);
      setTaskPause(taskId, null, target, now);
      armTimer(taskId, target, runtime.generation);
      return getTask(taskId);
    }
    // Repair an active task that lost its plan (e.g. crash between insert and schedule).
    return task.next_run_at === null ? scheduleNewTask(task) : task;
  }

  const runtime = runtimes.get(taskId);
  if (runtime) {
    runtime.generation += 1;
    if (runtime.timeout !== null) {
      clearTimeout(runtime.timeout);
    }
    runtime.abortController?.abort();
    runtimes.delete(taskId);
  }

  updateTaskStatus(taskId, "active", null);
  if (task.paused_until !== null) {
    setTaskPause(taskId, null, null);
  }
  const active = getTask(taskId);
  return active ? scheduleNewTask(active) : null;
}

export function stopAll(): void {
  stopSweep();
  for (const runtime of runtimes.values()) {
    runtime.generation += 1;
    if (runtime.timeout !== null) {
      clearTimeout(runtime.timeout);
    }
    runtime.abortController?.abort();
  }
  runtimes.clear();
  for (const manual of manualRuns.values()) {
    manual.controller.abort();
  }
  manualRuns.clear();
}

export function runtimeCount(): number {
  return runtimes.size;
}
