import {
  getTask,
  insertLog,
  listTasks,
  setTaskPause,
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
import type { TaskRow } from "./types";

export class PauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PauseError";
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
}

export interface StartSummary {
  active: number;
  recovered: number;
  missed: number;
}

const runtimes = new Map<string, SchedulerRuntime>();

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

function recordMiss(task: TaskRow, plannedAt: number): void {
  insertLog({
    task_id: task.id,
    executed_at: plannedAt,
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
  const controller = new AbortController();
  runtime.abortController = controller;

  try {
    await executeTaskRun(task, controller.signal);
  } catch (error) {
    console.error(`[jitter] 任务 ${taskId} 执行异常`, error);
  } finally {
    const current = runtimes.get(taskId);
    if (current !== runtime) return;
    runtime.running = false;
    runtime.abortController = null;
    if (runtime.generation !== generation) return;

    const latest = getTask(taskId);
    if (latest && latest.status === "active") {
      try {
        const latestSpec = parseWindow(latest.window_start, latest.window_end);
        const now = Date.now();
        const pause = livePause(latest, now);
        replan(taskId, planAfterRunWithPause(now, latestSpec, pause));
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

  // Keep today's already-randomised plan when the pause starts tomorrow, but
  // never keep a plan that belongs to a different (e.g. far-future) window.
  const target = preferredPlan(task, now, spec, pause);

  const runtime = ensureRuntime(taskId);
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
    runtimes.delete(taskId);
  }

  updateTaskStatus(taskId, "stopped", null);
  if (task.paused_until !== null) {
    setTaskPause(taskId, null, null);
  }
  return getTask(taskId);
}

export function resumeTask(taskId: string): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;

  if (task.status === "active") {
    const now = Date.now();
    const pause = livePause(task, now);
    if (pause !== null || task.paused_until !== null) {
      // Cancelling a pause resumes scheduling immediately, even mid-window.
      const spec = parseWindow(task.window_start, task.window_end);
      const runtime = ensureRuntime(taskId);
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
}

export function runtimeCount(): number {
  return runtimes.size;
}
