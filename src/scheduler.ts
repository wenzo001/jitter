import {
  deleteTask as deleteTaskRecord,
  getTask,
  insertLog,
  listTasks,
  setTaskPause,
  updateTaskConfig,
  updateTaskNextRun,
  updateTaskStatus,
} from "./db";
import { executeTaskRun } from "./executor";
import {
  MAX_PAUSE_DAYS,
  classifyTimerFire,
  parseWindow,
  pauseInterval,
  planAfterRunWithPause,
  planNewTask,
  planPaused,
  planRecovery,
  planWithPause,
  windowInstanceAt,
  type PauseInterval,
  type WindowSpec,
} from "./window";
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
  cron: Bun.CronJob | null;
  timeout: ReturnType<typeof setTimeout> | null;
  timeoutTarget: number | null;
  abortController: AbortController | null;
  running: boolean;
  /** Resolves when an in-flight executeTaskRun finishes (including its log write). */
  activeRun: Promise<unknown> | null;
  /** Window in force when the in-flight run started; changed mid-run by editTask. */
  runWindowKey: string | null;
  /** Set when editTask changes the window during that run. */
  windowChangedInFlight: boolean;
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
}
const manualRuns = new Map<string, ManualRun>();

function ensureRuntime(taskId: string): SchedulerRuntime {
  let runtime = runtimes.get(taskId);
  if (!runtime) {
    runtime = {
      generation: 0,
      cron: null,
      timeout: null,
      timeoutTarget: null,
      abortController: null,
      running: false,
      activeRun: null,
      runWindowKey: null,
      windowChangedInFlight: false,
    };
    runtimes.set(taskId, runtime);
  }
  return runtime;
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
function preferredPlan(
  task: TaskRow,
  now: number,
  spec: WindowSpec,
  pause: PauseInterval | null,
): number {
  const candidate = planWithPause(now, spec, pause);
  const pending = task.next_run_at;
  if (pending === null || pending <= now || planPaused(pending, spec, pause)) {
    return candidate;
  }
  const pendingWindow = windowInstanceAt(pending, spec);
  const candidateWindow = windowInstanceAt(candidate, spec);
  if (
    pendingWindow === null ||
    candidateWindow === null ||
    pendingWindow.start !== candidateWindow.start
  ) {
    return candidate;
  }
  return pending;
}

export function cronExpressionFor(spec: WindowSpec): string {
  const [hour, minute] = spec.start.split(":").map(Number);
  return `${minute} ${hour} * * *`;
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
function recordMiss(task: TaskRow, plannedAt: number, now: number = Date.now()): void {
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
    error: `错过执行窗口（计划 ${formatLocal(plannedAt)}，窗口 ${task.window_start}–${task.window_end}），未补跑`,
    aborted: 0,
    kind: "missed",
    parent_log_id: null,
    matched: null,
  });
  console.warn(
    `[jitter] 任务「${task.name}」错过了 ${formatLocal(plannedAt)} 的执行窗口，已记录且不补跑`,
  );
}

function registerCron(task: TaskRow, spec: WindowSpec): void {
  const runtime = ensureRuntime(task.id);
  runtime.cron?.stop();
  try {
    runtime.cron = Bun.cron(cronExpressionFor(spec), () => {
      try {
        onCron(task.id);
      } catch (error) {
        console.error(`[jitter] 任务 ${task.id} 的每日触发器失败`, error);
      }
    });
  } catch (error) {
    runtime.cron = null;
    throw error;
  }
}

function armTimer(taskId: string, target: number, generation: number): void {
  const runtime = ensureRuntime(taskId);
  if (runtime.timeout !== null) {
    clearTimeout(runtime.timeout);
  }
  runtime.timeoutTarget = target;
  const delay = Math.max(0, target - Date.now());
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

function onCron(taskId: string): void {
  const runtime = runtimes.get(taskId);
  if (!runtime || runtime.running) return;
  const task = getTask(taskId);
  if (!task || task.status !== "active") return;

  const spec = parseWindow(task.window_start, task.window_end);
  const now = Date.now();
  const pause = livePause(task, now);
  const current = windowInstanceAt(now, spec);
  const pending = task.next_run_at;

  // A restart may already have planned a moment inside the window that just
  // opened. Keep it instead of re-randomizing, but only if that window's day
  // is not paused.
  if (
    pending !== null &&
    pending > now &&
    current !== null &&
    pending >= current.start &&
    pending < current.end &&
    !planPaused(pending, spec, pause)
  ) {
    if (runtime.timeout === null || runtime.timeoutTarget !== pending) {
      armTimer(taskId, pending, runtime.generation);
    }
    return;
  }

  replan(taskId, planWithPause(now, spec, pause));
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

  let spec: WindowSpec;
  try {
    spec = parseWindow(task.window_start, task.window_end);
  } catch (error) {
    console.error(`[jitter] 任务 ${taskId} 的窗口配置无效，跳过本次执行`, error);
    return;
  }

  const pause = livePause(task, now);
  if (planPaused(target, spec, pause)) {
    try {
      replan(taskId, planWithPause(now, spec, pause));
    } catch (error) {
      console.error(`[jitter] 任务 ${taskId} 规划暂停后的执行失败`, error);
    }
    return;
  }

  if (classifyTimerFire(now, target, spec) === "miss") {
    recordMiss(task, target);
    try {
      replan(taskId, planWithPause(now, spec, pause));
    } catch (error) {
      console.error(`[jitter] 任务 ${taskId} 规划下一次执行失败`, error);
    }
    return;
  }

  runtime.running = true;
  runtime.runWindowKey = `${task.window_start}\u0000${task.window_end}`;
  runtime.windowChangedInFlight = false;
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
    runtime.abortController = null;
    runtime.activeRun = null;
    if (runtime.generation !== generation) return;

    const latest = getTask(taskId);
    if (latest && latest.status === "active") {
      try {
        const latestSpec = parseWindow(latest.window_start, latest.window_end);
        const now = Date.now();
        const pause = livePause(latest, now);
        // The run consumed the OLD window. If editTask changed the window while
        // it was in flight, the new window has not run yet today: plan inside
        // it rather than jumping to tomorrow's instance.
        const target = runtime.windowChangedInFlight
          ? planWithPause(now, latestSpec, pause)
          : planAfterRunWithPause(now, latestSpec, pause);
        runtime.windowChangedInFlight = false;
        runtime.runWindowKey = null;
        replan(taskId, target);
      } catch (error) {
        console.error(`[jitter] 任务 ${taskId} 规划下一次执行失败`, error);
      }
    }
  }
}

export function scheduleNewTask(task: TaskRow): TaskRow {
  if (task.status !== "active") return task;
  const spec = parseWindow(task.window_start, task.window_end);
  const runtime = ensureRuntime(task.id);
  runtime.generation += 1;
  const now = Date.now();
  const pause = livePause(task, now);
  const target = planWithPause(now, spec, pause);
  if (pause !== null) {
    setTaskPause(task.id, pause, target, now);
  } else if (task.paused_until !== null) {
    setTaskPause(task.id, null, target, now);
  } else {
    updateTaskNextRun(task.id, target);
  }
  registerCron(task, spec);
  armTimer(task.id, target, runtime.generation);
  return getTask(task.id) ?? task;
}

/**
 * Replace an existing task's configuration and keep it scheduled.
 *
 * The new window is validated before anything is written. An existing future
 * plan is kept ONLY when the window did not change: it is a concrete moment
 * owned by an armed timer, and re-planning could schedule a SECOND run in the
 * already-consumed window. When the window DID change, that plan belongs to the
 * old spec: keeping it would make onTimer judge it "missed" against the new
 * window (no request, spurious missed log), so we replan into the new window.
 * A stopped task is only updated — resuming later schedules from the new config.
 *
 * While a request is in flight we deliberately do NOT bump the generation or
 * touch the timer (same rule as pause/resume): that request's `finally` owns
 * the next plan and reads the just-written config. A window change is recorded
 * on the runtime so that `finally` plans a fresh point in the new window
 * instead of treating it as already consumed.
 */
export function editTask(taskId: string, input: NewTaskInput): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;

  const spec = parseWindow(input.window_start, input.window_end);
  const windowChanged =
    task.window_start !== input.window_start || task.window_end !== input.window_end;
  const updated = updateTaskConfig(taskId, input);
  if (!updated) return null;
  if (updated.status !== "active") return updated;

  registerCron(updated, spec);

  const runtime = ensureRuntime(taskId);
  if (runtime.running) {
    if (windowChanged) runtime.windowChangedInFlight = true;
    return updated;
  }

  const now = Date.now();
  // Keep a live plan only when the window is unchanged: its armed timer still
  // matches the spec. A changed window makes the old plan meaningless (onTimer
  // would judge it "missed"), so fall through to a fresh plan in the new window.
  if (!windowChanged && updated.next_run_at !== null && updated.next_run_at > now) {
    return updated;
  }
  const pause = livePause(updated, now);
  const target = planWithPause(now, spec, pause);

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
 * (tomorrow by default). A plan whose window day is outside the interval is
 * kept, so "start tomorrow" configured at noon still runs this afternoon.
 * The first run after the pause lands in the resume day's own window.
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

  const spec = parseWindow(task.window_start, task.window_end);
  const pause = pauseInterval(now, options.days, options.startsToday === true);
  const runtime = ensureRuntime(taskId);

  // A request is in flight: its own onTimer finally owns the next plan and
  // reads the latest pause state from the DB. Bumping the generation here
  // would suppress that finally, and arming a timer in the ALREADY CONSUMED
  // window would either run the window twice or strand the task with no timer
  // (if the request outlives the new timer). Persist the interval only.
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
  registerCron(task, spec);
  armTimer(taskId, target, runtime.generation);
  return getTask(taskId);
}

export function startScheduler(): StartSummary {
  const active = listTasks().filter((task) => task.status === "active");
  let recovered = 0;
  let missed = 0;

  for (const task of active) {
    try {
      const spec = parseWindow(task.window_start, task.window_end);
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
        registerCron(task, spec);
        armTimer(task.id, target, runtime.generation);
        recovered += 1;
        continue;
      }

      const plan = planRecovery(now, task.next_run_at, spec);
      if (plan.missed) {
        recordMiss(task, plan.missed.plannedAt);
        missed += 1;
      }
      if (task.paused_until !== null) {
        // The pause expired (or predates paused_from); clear it on the way.
        setTaskPause(task.id, null, plan.target, now);
      } else {
        updateTaskNextRun(task.id, plan.target);
      }
      registerCron(task, spec);
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
    runtime.cron?.stop();
    runtime.cron = null;
    if (runtime.timeout !== null) {
      clearTimeout(runtime.timeout);
    }
    runtime.timeout = null;
    runtime.timeoutTarget = null;
    runtime.abortController?.abort();
    runtime.abortController = null;
    runtime.runWindowKey = null;
    runtime.windowChangedInFlight = false;
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
 * Run a task once, immediately, without touching its schedule: next_run_at,
 * cron and timer are left exactly as they are, so the next planned window is
 * unaffected. The full executeTaskRun path is reused, so the run is logged and
 * can fire notifications just like a scheduled run.
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
  const promise = executeTaskRun(task, controller.signal);
  manualRuns.set(taskId, { controller, promise });
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
}

/**
 * Delete a task and everything under it.
 *
 * The runtime is torn down and removed from the map FIRST: an in-flight
 * onTimer finally then sees `current !== runtime` and skips replanning, and a
 * late cron tick finds no runtime and returns. The abort signal is raised so
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
    runtime.cron?.stop();
    runtime.cron = null;
    if (runtime.timeout !== null) clearTimeout(runtime.timeout);
    runtime.timeout = null;
    runtime.timeoutTarget = null;
    runtime.abortController?.abort();
    runtime.abortController = null;
    runtime.runWindowKey = null;
    runtime.windowChangedInFlight = false;
    if (runtime.activeRun) pending.push(runtime.activeRun);
    // Remove before awaiting so onTimer's finally skips replanning and any
    // cron/timer callback that slips in finds no runtime.
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
  return { task, deleted_logs: outcome.deleted_logs };
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
      // running request's finally plan the next window. Planning here would
      // target the already-consumed window and cause a double run / stall.
      if (runtime.running) {
        setTaskPause(taskId, null, task.next_run_at, now);
        return getTask(taskId);
      }
      // Cancelling a pause resumes scheduling immediately, even mid-window.
      const spec = parseWindow(task.window_start, task.window_end);
      runtime.generation += 1;
      if (runtime.timeout !== null) {
        clearTimeout(runtime.timeout);
      }
      runtime.timeout = null;
      runtime.timeoutTarget = null;
      const target = planNewTask(now, spec);
      setTaskPause(taskId, null, target, now);
      registerCron(task, spec);
      armTimer(taskId, target, runtime.generation);
      return getTask(taskId);
    }
    // Repair an active task that lost its plan (e.g. crash between insert and schedule).
    return task.next_run_at === null ? scheduleNewTask(task) : task;
  }

  const runtime = runtimes.get(taskId);
  if (runtime) {
    runtime.generation += 1;
    runtime.cron?.stop();
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
  for (const runtime of runtimes.values()) {
    runtime.generation += 1;
    runtime.cron?.stop();
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
