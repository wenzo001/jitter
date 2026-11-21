import { countRunsSince, listRecentTaskLogs, listTasks } from "./db";

/** How many recent runs each task's success rate is computed from. */
export const METRICS_WINDOW = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskMetrics {
  task_id: string;
  /** Runs inside the window (at most METRICS_WINDOW). */
  runs: number;
  /** Successful runs inside the window (no error and a 2xx status). */
  ok: number;
  /** 0–1, or null when there is no run to judge. */
  success_rate: number | null;
  avg_duration_ms: number | null;
  last_executed_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_kind: string | null;
}

export interface MetricsOverview {
  tasks: number;
  active: number;
  running: number;
  today_runs: number;
  today_ok: number;
  week_runs: number;
  week_ok: number;
  /** 0–1 over the last 7 days, or null when there was no run. */
  success_rate_7d: number | null;
  avg_duration_ms_7d: number | null;
}

export interface MetricsReport {
  overview: MetricsOverview;
  tasks: TaskMetrics[];
  window: number;
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function rate(ok: number, runs: number): number | null {
  if (runs <= 0) return null;
  return Math.round((ok / runs) * 1000) / 1000;
}

/**
 * Per-task health over the last few runs.
 *
 * Every task is a bounded index scan (the newest N rows), so the panel stays
 * cheap even with a large log table.
 */
export function getTaskMetrics(window: number = METRICS_WINDOW): TaskMetrics[] {
  const limit = Math.max(1, Math.min(Math.trunc(window) || METRICS_WINDOW, 200));
  const metrics: TaskMetrics[] = [];
  for (const task of listTasks()) {
    const rows = listRecentTaskLogs(task.id, limit);
    let ok = 0;
    let durationTotal = 0;
    let durationCount = 0;
    for (const row of rows) {
      const success =
        row.error === null && row.response_status !== null && row.response_status >= 200 && row.response_status < 300;
      if (success) ok += 1;
      if (row.duration_ms !== null) {
        durationTotal += row.duration_ms;
        durationCount += 1;
      }
    }
    const last = rows[0] ?? null;
    metrics.push({
      task_id: task.id,
      runs: rows.length,
      ok,
      success_rate: rate(ok, rows.length),
      avg_duration_ms: durationCount > 0 ? Math.round(durationTotal / durationCount) : null,
      last_executed_at: last?.executed_at ?? null,
      last_status: last?.response_status ?? null,
      last_error: last?.error ?? null,
      last_kind: last?.kind ?? null,
    });
  }
  return metrics;
}

/**
 * The headline numbers: how much ran today, how often it worked over the last
 * week, and how much is in flight right now.
 */
export function getOverview(now: number = Date.now(), running: number = 0): MetricsOverview {
  const tasks = listTasks();
  const today = countRunsSince(startOfLocalDay(now));
  const week = countRunsSince(now - 7 * DAY_MS);
  return {
    tasks: tasks.length,
    active: tasks.filter((task) => task.status === "active").length,
    running,
    today_runs: today.runs,
    today_ok: today.ok,
    week_runs: week.runs,
    week_ok: week.ok,
    success_rate_7d: rate(week.ok, week.runs),
    avg_duration_ms_7d: week.avg_duration_ms === null ? null : Math.round(week.avg_duration_ms),
  };
}

export function getMetricsReport(
  now: number = Date.now(),
  running: number = 0,
  window: number = METRICS_WINDOW,
): MetricsReport {
  return {
    overview: getOverview(now, running),
    tasks: getTaskMetrics(window),
    window: Math.max(1, Math.min(Math.trunc(window) || METRICS_WINDOW, 200)),
  };
}
