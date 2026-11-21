import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createTask, initDb, insertLog } from "./db";
import { getMetricsReport, getOverview, getTaskMetrics } from "./metrics";
import type { NewTaskInput } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function sampleTask(overrides: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    name: "metrics task",
    curl_command: "curl https://example.com/api",
    request: {
      url: "https://example.com/api",
      method: "GET",
      headers: {},
      body: null,
    },
    window_start: "10:10",
    window_end: "10:20",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
    ...overrides,
  };
}

function insertRun(
  taskId: string,
  executedAt: number,
  options: { status?: number | null; error?: string | null; duration?: number | null } = {},
) {
  insertLog({
    task_id: taskId,
    executed_at: executedAt,
    request_url: "https://example.com/api",
    request_method: "GET",
    request_headers: null,
    request_body: null,
    response_status: options.status === undefined ? 200 : options.status,
    response_headers: null,
    response_body: "body",
    duration_ms: options.duration === undefined ? 100 : options.duration,
    error: options.error ?? null,
    aborted: 0,
    kind: "task",
    parent_log_id: null,
    matched: 1,
  });
}

beforeEach(() => {
  // A fresh database per test: the metrics aggregate over ALL logs, so a
  // shared database would mix the tests' rows together.
  initDb(":memory:");
});

afterEach(() => {
  closeDb();
});

describe("task metrics", () => {
  test("counts successes, failures and the average duration", () => {
    const task = createTask(sampleTask({ name: "stats" }));
    const now = Date.now();
    insertRun(task.id, now - 1000, { status: 200, duration: 100 });
    insertRun(task.id, now - 2000, { status: 200, duration: 200 });
    insertRun(task.id, now - 3000, { status: 500, duration: 300, error: "HTTP 500" });

    const metrics = getTaskMetrics().find((entry) => entry.task_id === task.id)!;
    expect(metrics.runs).toBe(3);
    expect(metrics.ok).toBe(2);
    expect(metrics.success_rate).toBeCloseTo(2 / 3, 2);
    expect(metrics.avg_duration_ms).toBe(200);
    expect(metrics.last_executed_at).toBe(now - 1000);
    expect(metrics.last_status).toBe(200);
  });

  test("only counts the newest runs inside the window", () => {
    const task = createTask(sampleTask({ name: "windowed" }));
    const now = Date.now();
    for (let index = 0; index < 5; index += 1) {
      insertRun(task.id, now - index * 1000, { status: 200 });
    }
    const metrics = getTaskMetrics(2).find((entry) => entry.task_id === task.id)!;
    expect(metrics.runs).toBe(2);
    expect(metrics.success_rate).toBe(1);
  });

  test("a task without runs reports no rate instead of zero", () => {
    const task = createTask(sampleTask({ name: "idle" }));
    const metrics = getTaskMetrics().find((entry) => entry.task_id === task.id)!;
    expect(metrics.runs).toBe(0);
    expect(metrics.success_rate).toBeNull();
    expect(metrics.avg_duration_ms).toBeNull();
    expect(metrics.last_executed_at).toBeNull();
  });
});

describe("overview", () => {
  test("separates today's runs from the last seven days", () => {
    const task = createTask(sampleTask({ name: "overview" }));
    const now = Date.now();
    insertRun(task.id, now - 60_000, { status: 200 });
    insertRun(task.id, now - 3 * DAY_MS, { status: 500, error: "boom" });
    insertRun(task.id, now - 20 * DAY_MS, { status: 200 });

    const overview = getOverview(now);
    expect(overview.today_runs).toBe(1);
    expect(overview.today_ok).toBe(1);
    expect(overview.week_runs).toBe(2);
    expect(overview.week_ok).toBe(1);
    expect(overview.success_rate_7d).toBeCloseTo(0.5, 2);
  });

  test("the report carries both the overview and the per-task rows", () => {
    const report = getMetricsReport();
    expect(report.overview).toBeDefined();
    expect(Array.isArray(report.tasks)).toBe(true);
    expect(report.window).toBeGreaterThan(0);
  });
});
