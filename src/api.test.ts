import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "./api";
import { DEFAULT_CONFIG, setActiveConfig } from "./config";
import {
  closeDb,
  getDatabase,
  getLogCleanupPreview,
  getTask,
  initDb,
  insertLog,
  listTasks,
} from "./db";
import { stopAll } from "./scheduler";
import type { NewLogInput } from "./types";

beforeEach(() => {
  setActiveConfig({ ...DEFAULT_CONFIG });
  stopAll();
  closeDb();
  initDb(":memory:");
});

afterAll(() => {
  setActiveConfig({ ...DEFAULT_CONFIG });
  stopAll();
  closeDb();
});

async function call(path: string, init?: RequestInit) {
  const response = await app.handle(new Request(`http://localhost${path}`, init));
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function post(path: string, body: unknown) {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown) {
  return call(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function futureWindow() {
  const start = new Date(Date.now() + 2 * 60 * 60_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 10 * 60_000);
  return { window_start: hhmm(start), window_end: hhmm(end) };
}

/** Base timestamp for the test logs: recent enough for the retention window. */
const LOG_BASE = Date.now() - 60_000;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    name: "api task",
    mode: "curl",
    curl: "curl https://example.com/ok",
    ...futureWindow(),
    ...overrides,
  };
}

function logInput(taskId: string, index: number): NewLogInput {
  return {
    task_id: taskId,
    // Recent on purpose: the log list only answers inside the retention
    // window (default 30 days), so ancient timestamps would be filtered out.
    executed_at: LOG_BASE + index * 1000,
    request_url: "https://example.com/ok",
    request_method: "GET",
    request_headers: "{}",
    request_body: null,
    response_status: 200,
    response_headers: "{}",
    response_body: "ok",
    duration_ms: 1,
    error: null,
    aborted: 0,
    kind: "task",
    parent_log_id: null,
    matched: 1,
  };
}

describe("api", () => {
  test("health", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test("tests a curl: parses, sends, returns result, writes no log", async () => {
    const original = globalThis.fetch;
    const captured: { sent: { url: string; init: RequestInit } | null } = { sent: null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.sent = { url: String(input), init: init ?? {} };
      return new Response("probe-ok", {
        status: 201,
        headers: { "X-Probe": "yes" },
      });
    }) as unknown as typeof fetch;

    const logsBefore = getLogCleanupPreview().total_count;
    try {
      const response = await post("/api/curl/test", {
        curl: "curl -X POST 'https://example.com/test' -H 'X-A: 1' -d 'body=1'",
      });
      expect(response.status).toBe(200);
      expect(response.body.result.status).toBe(201);
      expect(response.body.result.body).toBe("probe-ok");
      expect(response.body.result.error).toBeNull();
      expect(response.body.result.headers["x-probe"]).toBe("yes");
      expect(captured.sent?.url).toBe("https://example.com/test");
      expect(captured.sent?.init.method).toBe("POST");
      // No task row was created and nothing was written to the log table.
      expect(listTasks()).toHaveLength(0);
      expect(getLogCleanupPreview().total_count).toBe(logsBefore);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("curl test reports transport errors without failing the endpoint", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const response = await post("/api/curl/test", { curl: "curl https://example.com/x" });
      expect(response.status).toBe(200);
      expect(response.body.result.status).toBeNull();
      expect(response.body.result.error).toContain("fetch failed");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("curl test rejects a bad curl with 400", async () => {
    const empty = await post("/api/curl/test", { curl: "   " });
    expect(empty.status).toBe(400);

    const notJson = await post("/api/curl/test", { curl: 42 });
    expect(notJson.status).toBe(400);
  });

  test("runs a task immediately, logs it, and keeps its plan", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("run-now-ok", { status: 200 })) as unknown as typeof fetch;
    try {
      const created = await post("/api/tasks", payload());
      const id = created.body.task.id;
      const plannedAt = created.body.task.next_run_at;

      const response = await post(`/api/tasks/${id}/run`, {});
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, status: 200, matched: true });
      expect(response.body.notifySent).toBe(false);

      const list = await call(`/api/tasks/${id}/logs`);
      expect(list.body.logs).toHaveLength(1);
      // The list carries the summary only; the body is fetched on demand.
      expect(list.body.logs[0].response_body).toBeUndefined();
      expect(list.body.logs[0].response_status).toBe(200);
      const detail = await call(`/api/logs/${list.body.logs[0].id}`);
      expect(detail.body.log.response_body).toBe("run-now-ok");

      const task = getTask(id)!;
      expect(task.next_run_at).toBe(plannedAt);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("run now returns 404 for a missing task", async () => {
    const missing = await post("/api/tasks/missing/run", {});
    expect(missing.status).toBe(404);
  });

  test("exposes the client-side configuration", async () => {
    setActiveConfig({
      ...DEFAULT_CONFIG,
      logsPageSize: 25,
      defaultWindowMinutes: 7,
      pollIntervalMs: 2500,
      logBodyLimitBytes: 2048,
    });
    const response = await call("/api/config");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      logsPageSize: 25,
      defaultWindowMinutes: 7,
      pollIntervalMs: 2500,
      logBodyLimitBytes: 2048,
      requestTimeoutMs: DEFAULT_CONFIG.requestTimeoutMs,
      logRetentionDays: DEFAULT_CONFIG.logRetentionDays,
    });
  });

  test("changes the retention window at runtime", async () => {
    const updated = await post("/api/settings", { logRetentionDays: 180 });
    expect(updated.status).toBe(200);
    expect(updated.body.logRetentionDays).toBe(180);

    const config = await call("/api/config");
    expect(config.body.logRetentionDays).toBe(180);

    const invalid = await post("/api/settings", { logRetentionDays: -1 });
    expect(invalid.status).toBe(400);

    // Back to the default so the other tests keep their window.
    await post("/api/settings", { logRetentionDays: DEFAULT_CONFIG.logRetentionDays });
  });

  test("lists tasks without the heavy payloads and serves the full one on demand", async () => {
    const created = await post("/api/tasks", payload({ name: "slim" }));
    const id = created.body.task.id;

    const list = await call("/api/tasks");
    const summary = list.body.tasks.find((entry: any) => entry.id === id);
    // The card does not need the bodies, so the list leaves them out.
    expect(summary.curl_command).toBeUndefined();
    expect(summary.request_headers).toBeUndefined();
    expect(summary.name).toBe("slim");
    expect(summary.next_run_at).toBeGreaterThan(Date.now());

    const full = await call(`/api/tasks/${id}`);
    expect(full.status).toBe(200);
    expect(full.body.task.curl_command).toBeTruthy();

    const missing = await call("/api/tasks/does-not-exist");
    expect(missing.status).toBe(404);
  });

  test("stores a new task order and keeps it after a reload", async () => {
    const first = await post("/api/tasks", payload({ name: "order-a" }));
    const second = await post("/api/tasks", payload({ name: "order-b" }));
    const third = await post("/api/tasks", payload({ name: "order-c" }));
    const ids = [first.body.task.id, second.body.task.id, third.body.task.id];

    const before = await call("/api/tasks");
    const beforeIds = before.body.tasks.map((task: any) => task.id);
    // New tasks go to the top.
    expect(beforeIds[0]).toBe(third.body.task.id);

    const reordered = await post("/api/tasks/reorder", { ids: [ids[0], ids[1], ids[2]] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.tasks.map((task: any) => task.id)).toEqual(ids);

    const after = await call("/api/tasks");
    expect(after.body.tasks.map((task: any) => task.id)).toEqual(ids);

    // A partial list would drop tasks from the order: it must be refused.
    const partial = await post("/api/tasks/reorder", { ids: [ids[0]] });
    expect(partial.status).toBe(409);

    const unknown = await post("/api/tasks/reorder", { ids: [...ids, "nope"] });
    expect(unknown.status).toBe(409);

    const invalid = await post("/api/tasks/reorder", { ids: "not-an-array" });
    expect(invalid.status).toBe(400);
  });

  test("serves the run statistics", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    try {
      const created = await post("/api/tasks", payload({ name: "metrics" }));
      await call(`/api/tasks/${created.body.task.id}/run`, { method: "POST" });

      const response = await call("/api/metrics");
      expect(response.status).toBe(200);
      expect(response.body.overview).toBeDefined();
      expect(response.body.overview.tasks).toBeGreaterThan(0);
      expect(Array.isArray(response.body.tasks)).toBe(true);
      const entry = response.body.tasks.find((row: any) => row.task_id === created.body.task.id);
      expect(entry.runs).toBeGreaterThan(0);
      expect(entry.success_rate).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("hides logs older than the retention window", async () => {
    const created = await post("/api/tasks", payload({ name: "window" }));
    const taskId = created.body.task.id;
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    insertLog({ ...logInput(taskId, 0), executed_at: now - 60_000 });
    insertLog({ ...logInput(taskId, 1), executed_at: now - 40 * day });

    const list = await call(`/api/tasks/${taskId}/logs`);
    expect(list.body.retention_days).toBe(DEFAULT_CONFIG.logRetentionDays);
    expect(list.body.logs).toHaveLength(1);

    // Widening the window makes the old log visible again.
    await post("/api/settings", { logRetentionDays: 180 });
    const wide = await call(`/api/tasks/${taskId}/logs`);
    expect(wide.body.logs).toHaveLength(2);
    await post("/api/settings", { logRetentionDays: DEFAULT_CONFIG.logRetentionDays });
  });

  test("reports runtime state and schedule health for every task", async () => {
    const created = await post("/api/tasks", payload({ name: "health" }));
    expect(created.body.task.running).toBe(false);
    expect(created.body.task.running_since).toBeNull();
    expect(created.body.task.schedule_error).toBeNull();

    const list = await call("/api/tasks");
    const task = list.body.tasks.find((entry: any) => entry.id === created.body.task.id);
    expect(task.running).toBe(false);
    expect(task.schedule_error).toBeNull();
  });

  test("flags a task whose schedule can no longer be parsed", async () => {
    const created = await post("/api/tasks", payload({ name: "broken" }));
    const id = created.body.task.id;
    // Simulate a hand-edited / legacy row: the scheduler would throw on it.
    getDatabase().run("UPDATE tasks SET window_start = '99:99' WHERE id = ?", [id]);

    const list = await call("/api/tasks");
    const task = list.body.tasks.find((entry: any) => entry.id === id);
    expect(task.schedule_error).toContain("HH:mm");
  });

  test("creates a task and returns its future plan", async () => {    const response = await post("/api/tasks", payload({ name: "created" }));
    expect(response.status).toBe(201);
    expect(response.body.task.name).toBe("created");
    expect(response.body.task.status).toBe("active");
    expect(response.body.task.next_run_at).toBeGreaterThan(Date.now());
    expect(getTask(response.body.task.id)?.request_url).toBe("https://example.com/ok");

    const list = await call("/api/tasks");
    expect(list.body.tasks).toHaveLength(1);
  });

  test("creates a task from a browser-style curl with -b cookies", async () => {
    const response = await post(
      "/api/tasks",
      payload({
        curl: `curl 'https://example.com/api' -H 'User-Agent: Mozilla/5.0' --compressed -b 'session=abc; theme=dark'`,
      }),
    );
    expect(response.status).toBe(201);
    const headers = JSON.parse(response.body.task.request_headers);
    expect(headers["User-Agent"]).toBe("Mozilla/5.0");
    expect(headers.Cookie).toBe("session=abc; theme=dark");
  });

  test("persists notification configuration", async () => {
    const response = await post(
      "/api/tasks",
      payload({
        notify_enabled: true,
        notify_curl: "curl -X POST https://notify.example/hook -d done",
        expect_status: 200,
        expect_body: "ok",
        expect_expr: "data.result.remindtype=0",
      }),
    );
    expect(response.status).toBe(201);
    expect(response.body.task.notify_enabled).toBe(1);
    expect(response.body.task.notify_url).toBe("https://notify.example/hook");
    expect(response.body.task.notify_method).toBe("POST");
    expect(response.body.task.expect_status).toBe(200);
    expect(response.body.task.expect_body).toBe("ok");
    expect(response.body.task.expect_expr).toBe("data.result.remindtype=0");
  });

  test("rejects an invalid condition expression before inserting", async () => {
    const before = listTasks().length;
    const response = await post(
      "/api/tasks",
      payload({
        notify_enabled: true,
        notify_curl: "curl -X POST https://notify.example/hook -d done",
        expect_expr: "data.result ==",
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("条件表达式无效");
    expect(listTasks().length).toBe(before);
  });

  test("keeps success conditions even when notifications are disabled", async () => {
    // Conditions decide the "命中" flag recorded with every run, so they are
    // independent of whether a notification is configured.
    const response = await post(
      "/api/tasks",
      payload({
        notify_enabled: false,
        expect_expr: "data.result.remindtype=0",
        expect_status: 200,
      }),
    );
    expect(response.status).toBe(201);
    expect(response.body.task.notify_enabled).toBe(0);
    expect(response.body.task.expect_expr).toBe("data.result.remindtype=0");
    expect(response.body.task.expect_status).toBe(200);
  });

  test("updates an existing task via PUT and keeps it scheduled", async () => {
    const created = await post("/api/tasks", payload({ name: "before edit" }));
    const id = created.body.task.id as string;

    const response = await put(
      `/api/tasks/${id}`,
      payload({
        name: "after edit",
        curl: "curl https://example.com/updated",
        window_end: "23:58",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.task.name).toBe("after edit");
    expect(response.body.task.request_url).toBe("https://example.com/updated");
    expect(response.body.task.window_end).toBe("23:58");
    expect(response.body.task.next_run_at).toBeGreaterThan(Date.now());
    expect(getTask(id)?.name).toBe("after edit");
  });

  test("PUT returns 404 for a missing task", async () => {
    const response = await put("/api/tasks/does-not-exist", payload());
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("任务不存在");
  });

  test("PUT validates input before changing the stored task", async () => {
    const created = await post("/api/tasks", payload({ name: "keep me" }));
    const id = created.body.task.id as string;

    const invalid = await put(
      `/api/tasks/${id}`,
      payload({ curl: "curl -F 'file=@a' https://example.com" }),
    );
    expect(invalid.status).toBe(400);
    expect(getTask(id)?.name).toBe("keep me");
    expect(getTask(id)?.request_url).toBe("https://example.com/ok");
  });

  test("PUT rejects an invalid condition expression without touching the task", async () => {
    const created = await post("/api/tasks", payload({ name: "expr guard" }));
    const id = created.body.task.id as string;
    const before = getTask(id)!;

    const invalid = await put(
      `/api/tasks/${id}`,
      payload({
        notify_enabled: true,
        notify_curl: "curl -X POST https://notify.example/hook",
        expect_expr: "data.result ==",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("条件表达式无效");
    expect(getTask(id)?.expect_expr).toBe(before.expect_expr);
  });

  test("rejects an invalid task curl before inserting", async () => {
    const before = listTasks().length;
    const response = await post(
      "/api/tasks",
      payload({ curl: "curl -F 'file=@a' https://example.com" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("-F");
    expect(listTasks().length).toBe(before);
  });

  test("rejects an invalid notification curl before inserting", async () => {
    const before = listTasks().length;
    const response = await post(
      "/api/tasks",
      payload({
        notify_enabled: true,
        notify_curl: "curl --resolve example.com:443:127.0.0.1 https://notify.example",
      }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("--resolve");
    expect(listTasks().length).toBe(before);
  });

  test("persists curl request options such as --insecure and --max-time", async () => {
    const response = await post(
      "/api/tasks",
      payload({
        curl: "curl -k --max-time 2 -x http://127.0.0.1:3128 https://example.com",
      }),
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(response.body.task.request_options)).toEqual({
      insecure: true,
      timeoutMs: 2000,
      proxy: "http://127.0.0.1:3128/",
    });
  });

  test("rejects an invalid window before inserting", async () => {
    const before = listTasks().length;
    const response = await post(
      "/api/tasks",
      payload({ window_start: "25:00", window_end: "10:00" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("HH:mm");
    expect(listTasks().length).toBe(before);
  });

  test("accepts an exact time and stores the ± jitter", async () => {
    const exact = await post(
      "/api/tasks",
      payload({ name: "exact", window_start: "10:00", window_end: "10:00" }),
    );
    expect(exact.status).toBe(201);
    expect(exact.body.task.daily_jitter_minutes).toBe(0);

    const jittered = await post(
      "/api/tasks",
      payload({
        name: "jittered",
        window_start: "10:00",
        window_end: "10:00",
        daily_jitter_minutes: 5,
      }),
    );
    expect(jittered.status).toBe(201);
    expect(jittered.body.task.daily_jitter_minutes).toBe(5);
    expect(jittered.body.task.window_start).toBe("10:00");

    const bad = await post(
      "/api/tasks",
      payload({ name: "bad", window_start: "09:00", window_end: "10:00", daily_jitter_minutes: 5 }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("精确时间");
  });

  test("stops and resumes a task", async () => {
    const created = await post("/api/tasks", payload());
    const id = created.body.task.id;

    const stopped = await post(`/api/tasks/${id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.task.status).toBe("stopped");
    expect(stopped.body.task.next_run_at).toBeNull();

    const resumed = await post(`/api/tasks/${id}/resume`, {});
    expect(resumed.status).toBe(200);
    expect(resumed.body.task.status).toBe("active");
    expect(resumed.body.task.next_run_at).toBeGreaterThan(Date.now());

    const missing = await post("/api/tasks/missing/stop", {});
    expect(missing.status).toBe(404);
  });

  test("deletes a task with all its logs and reports 404 afterwards", async () => {
    const created = await post("/api/tasks", payload());
    const id = created.body.task.id;
    const other = await post("/api/tasks", payload({ name: "other" }));
    const otherId = other.body.task.id;

    // One task log + one notify-kind log (same task_id) for the doomed task,
    // plus a log for the task we keep.
    insertLog(logInput(id, 1));
    insertLog({ ...logInput(id, 2), kind: "notify" });
    insertLog(logInput(otherId, 3));

    const deleted = await call(`/api/tasks/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true, id, deleted_logs: 2, deleted_test_runs: 0 });

    expect(getTask(id)).toBeNull();
    expect((await call(`/api/tasks/${id}/logs`)).status).toBe(404);
    expect(getTask(otherId)?.name).toBe("other");

    const again = await call(`/api/tasks/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("pauses a task for 1-15 days and clears the pause on resume", async () => {
    const created = await post("/api/tasks", payload());
    const id = created.body.task.id;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const paused = await post(`/api/tasks/${id}/pause`, { days: 3, starts_today: true });
    expect(paused.status).toBe(200);
    expect(paused.body.task.status).toBe("active");
    expect(paused.body.task.paused_from).toBe(todayStart.getTime());
    expect(paused.body.task.paused_until).toBeGreaterThan(Date.now());
    expect(paused.body.task.next_run_at).toBeGreaterThanOrEqual(paused.body.task.paused_until);

    const defaulted = await post(`/api/tasks/${id}/pause`, { days: 1 });
    expect(defaulted.status).toBe(200);
    const tomorrowStart = new Date(todayStart.getTime());
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const defaultStart = new Date(todayStart.getTime());
    defaultStart.setDate(defaultStart.getDate() + 1 + 1);
    expect(defaulted.body.task.paused_from).toBe(tomorrowStart.getTime());
    expect(defaulted.body.task.paused_until).toBe(defaultStart.getTime());
    expect(defaulted.body.task.next_run_at).toBeGreaterThan(Date.now());

    for (const days of [0, 16, 1.5, "3"]) {
      const invalid = await post(`/api/tasks/${id}/pause`, { days });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("暂停天数");
    }

    const resumed = await post(`/api/tasks/${id}/resume`, {});
    expect(resumed.status).toBe(200);
    expect(resumed.body.task.paused_until).toBeNull();
    expect(resumed.body.task.next_run_at).toBeGreaterThan(Date.now());

    await post(`/api/tasks/${id}/stop`, {});
    const stopPause = await post(`/api/tasks/${id}/pause`, { days: 2 });
    expect(stopPause.status).toBe(400);
    expect(stopPause.body.error).toContain("已停止");

    const missing = await post("/api/tasks/missing/pause", { days: 2 });
    expect(missing.status).toBe(404);

    const badBody = await post(`/api/tasks/${id}/pause`, null);
    expect(badBody.status).toBe(400);
  });

  test("paginates logs, defaults an empty limit, and returns log detail", async () => {
    const created = await post("/api/tasks", payload());
    const taskId = created.body.task.id;
    const ids = [0, 1, 2].map((index) => insertLog(logInput(taskId, index)));

    const first = await call(`/api/tasks/${taskId}/logs?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.logs.map((log: { id: number }) => log.id)).toEqual([ids[2]!, ids[1]!]);
    expect(first.body.has_more).toBe(true);

    const next = await call(`/api/tasks/${taskId}/logs?limit=2&before=${LOG_BASE + 1000}:${ids[1]}`);
    expect(next.body.logs.map((log: { id: number }) => log.id)).toEqual([ids[0]!]);
    expect(next.body.has_more).toBe(false);

    const emptyLimit = await call(`/api/tasks/${taskId}/logs?limit=`);
    expect(emptyLimit.body.logs).toHaveLength(3);
    expect(emptyLimit.body.has_more).toBe(false);

    const detail = await call(`/api/logs/${ids[0]}`);
    expect(detail.status).toBe(200);
    expect(detail.body.log.id).toBe(ids[0]);

    const badBefore = await call(`/api/tasks/${taskId}/logs?before=abc`);
    expect(badBefore.status).toBe(400);

    const partialBefore = await call(`/api/tasks/${taskId}/logs?before=1001`);
    expect(partialBefore.status).toBe(400);

    const badCursor = await call(`/api/tasks/${taskId}/logs?before=1001:abc`);
    expect(badCursor.status).toBe(400);

    const missingLog = await call("/api/logs/999999");
    expect(missingLog.status).toBe(404);

    const missingTask = await call("/api/tasks/missing/logs");
    expect(missingTask.status).toBe(404);
  });

  test("returns logs ordered by execution time desc", async () => {
    const created = await post("/api/tasks", payload());
    const taskId = created.body.task.id;
    const newest = insertLog({ ...logInput(taskId, 0), executed_at: LOG_BASE + 5_000 });
    // Inserted later but executed earlier: the API must sort by execution time.
    const oldest = insertLog({ ...logInput(taskId, 1), executed_at: LOG_BASE + 1_000 });
    const middle = insertLog({ ...logInput(taskId, 2), executed_at: LOG_BASE + 3_000 });

    const response = await call(`/api/tasks/${taskId}/logs`);
    expect(response.status).toBe(200);
    expect(response.body.logs.map((log: { id: number }) => log.id)).toEqual([
      newest,
      middle,
      oldest,
    ]);
  });

  test("uses configured log page sizes", async () => {
    setActiveConfig({ ...DEFAULT_CONFIG, logsPageSize: 2, logsMaxPageSize: 2 });
    const created = await post("/api/tasks", payload());
    const taskId = created.body.task.id;
    for (let index = 0; index < 3; index += 1) {
      insertLog(logInput(taskId, index));
    }

    const defaulted = await call(`/api/tasks/${taskId}/logs?limit=`);
    expect(defaulted.body.logs).toHaveLength(2);
    expect(defaulted.body.has_more).toBe(true);

    const clamped = await call(`/api/tasks/${taskId}/logs?limit=999`);
    expect(clamped.body.logs).toHaveLength(2);
    expect(clamped.body.has_more).toBe(true);
  });

  test("previews and executes log cleanup with confirmation", async () => {
    const created = await post("/api/tasks", payload());
    const taskId = created.body.task.id;
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const stale = [0, 1, 2].map((index) =>
      insertLog({ ...logInput(taskId, index), executed_at: now - 40 * day + index }),
    );
    insertLog({ ...logInput(taskId, 10), executed_at: now - day });

    const preview = await call("/api/logs/cleanup/preview");
    expect(preview.status).toBe(200);
    expect(preview.body.total_count).toBe(4);
    expect(preview.body.options.map((option: { days: number }) => option.days)).toEqual([
      10, 30, 180, 365,
    ]);
    const thirty = preview.body.options.find((option: { days: number }) => option.days === 30);
    expect(thirty.count).toBe(3);
    expect(preview.body.all).toEqual({ count: 4, bytes: preview.body.total_bytes });

    const missingConfirm = await post("/api/logs/cleanup", { days: 30 });
    expect(missingConfirm.status).toBe(400);

    const badDays = await post("/api/logs/cleanup", { days: 7, confirm: true });
    expect(badDays.status).toBe(400);

    const stringDays = await post("/api/logs/cleanup", { days: "30", confirm: true });
    expect(stringDays.status).toBe(400);

    const arrayDays = await post("/api/logs/cleanup", { days: [30], confirm: true });
    expect(arrayDays.status).toBe(400);

    const negativeDays = await post("/api/logs/cleanup", { days: -30, confirm: true });
    expect(negativeDays.status).toBe(400);

    const stringConfirm = await post("/api/logs/cleanup", { days: 30, confirm: "true" });
    expect(stringConfirm.status).toBe(400);

    const stringAll = await post("/api/logs/cleanup", { all: "true", confirm: "DELETE_ALL" });
    expect(stringAll.status).toBe(400);

    const missingDays = await post("/api/logs/cleanup", { confirm: true });
    expect(missingDays.status).toBe(400);

    const both = await post("/api/logs/cleanup", { days: 30, all: true, confirm: "DELETE_ALL" });
    expect(both.status).toBe(400);

    const wrongAllConfirm = await post("/api/logs/cleanup", { all: true, confirm: true });
    expect(wrongAllConfirm.status).toBe(400);

    const badCutoff = await post("/api/logs/cleanup", {
      days: 30,
      confirm: true,
      cutoff: "30d",
    });
    expect(badCutoff.status).toBe(400);

    const futureCutoff = await post("/api/logs/cleanup", {
      days: 30,
      confirm: true,
      cutoff: Date.now() + day,
    });
    expect(futureCutoff.status).toBe(400);

    // A cutoff must stay bound to this tier's preview; otherwise a plain
    // confirm: true could wipe everything and bypass "delete all".
    const widenedCutoff = await post("/api/logs/cleanup", {
      days: 30,
      confirm: true,
      cutoff: Date.now(),
    });
    expect(widenedCutoff.status).toBe(400);

    const staleCutoff = await post("/api/logs/cleanup", {
      days: 30,
      confirm: true,
      cutoff: now - 400 * day,
    });
    expect(staleCutoff.status).toBe(400);

    const cleaned = await post("/api/logs/cleanup", {
      days: 30,
      confirm: true,
      cutoff: thirty.cutoff,
    });
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.cutoff).toBe(thirty.cutoff);
    expect(cleaned.body.deleted).toBe(3);
    expect(cleaned.body.remaining).toBe(1);
    expect(cleaned.body.vacuum_error).toBeNull();

    const remaining = await call(`/api/tasks/${taskId}/logs`);
    expect(remaining.body.logs.map((log: { id: number }) => log.id)).not.toContain(stale[0]!);

    const clearedAll = await post("/api/logs/cleanup", { all: true, confirm: "DELETE_ALL" });
    expect(clearedAll.status).toBe(200);
    expect(clearedAll.body.deleted).toBe(1);
    expect(clearedAll.body.remaining).toBe(0);
  });

  test("rejects malformed JSON", async () => {
    const response = await call("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
  });

  test("returns a JSON 404 for unknown routes", async () => {
    const response = await call("/api/nope");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("接口不存在");
  });
});
