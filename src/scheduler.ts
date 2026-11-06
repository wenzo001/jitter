import { getTask, insertLog, listTasks, updateTaskNextRun, updateTaskStatus } from "./db";
import { executeTaskRun } from "./executor";
import {
  classifyTimerFire,
  parseWindow,
  planNewTask,
  planNextWindowAfter,
  planRecovery,
  windowInstanceAt,
  type WindowSpec,
} from "./window";
import type { TaskRow } from "./types";

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
  const current = windowInstanceAt(now, spec);
  const pending = task.next_run_at;

  // A restart may already have planned a moment inside the window that just
  // opened. Keep that plan instead of re-randomizing it.
  if (
    pending !== null &&
    pending > now &&
    current !== null &&
    pending >= current.start &&
    pending < current.end
  ) {
    if (runtime.timeout === null || runtime.timeoutTarget !== pending) {
      armTimer(taskId, pending, runtime.generation);
    }
    return;
  }

  replan(taskId, planNewTask(now, spec));
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

  if (classifyTimerFire(now, target, spec) === "miss") {
    recordMiss(task, target);
    try {
      replan(taskId, planNewTask(now, spec));
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
    if (current !== runtime || runtime.generation !== generation) {
      return;
    }
    runtime.running = false;
    runtime.abortController = null;

    const latest = getTask(taskId);
    if (latest && latest.status === "active") {
      try {
        const spec = parseWindow(latest.window_start, latest.window_end);
        replan(taskId, planNextWindowAfter(Date.now(), spec));
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
  const target = planNewTask(Date.now(), spec);
  updateTaskNextRun(task.id, target);
  registerCron(task, spec);
  armTimer(task.id, target, runtime.generation);
  return getTask(task.id) ?? task;
}

export function startScheduler(): StartSummary {
  const active = listTasks().filter((task) => task.status === "active");
  let recovered = 0;
  let missed = 0;

  for (const task of active) {
    try {
      const spec = parseWindow(task.window_start, task.window_end);
      const plan = planRecovery(Date.now(), task.next_run_at, spec);
      if (plan.missed) {
        recordMiss(task, plan.missed.plannedAt);
        missed += 1;
      }
      const runtime = ensureRuntime(task.id);
      runtime.generation += 1;
      updateTaskNextRun(task.id, plan.target);
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
  return getTask(taskId);
}

export function resumeTask(taskId: string): TaskRow | null {
  const task = getTask(taskId);
  if (!task) return null;
  if (task.status === "active") {
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
