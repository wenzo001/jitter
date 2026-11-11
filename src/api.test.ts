import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "./api";
import { DEFAULT_CONFIG, setActiveConfig } from "./config";
import { closeDb, getTask, initDb, insertLog, listTasks } from "./db";
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

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function futureWindow() {
  const start = new Date(Date.now() + 2 * 60 * 60_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 10 * 60_000);
  return { window_start: hhmm(start), window_end: hhmm(end) };
}

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
    executed_at: 1_000 + index,
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
    });
  });

  test("creates a task and returns its future plan", async () => {
    const response = await post("/api/tasks", payload({ name: "created" }));
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
      }),
    );
    expect(response.status).toBe(201);
    expect(response.body.task.notify_enabled).toBe(1);
    expect(response.body.task.notify_url).toBe("https://notify.example/hook");
    expect(response.body.task.notify_method).toBe("POST");
    expect(response.body.task.expect_status).toBe(200);
    expect(response.body.task.expect_body).toBe("ok");
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
      payload({ window_start: "10:00", window_end: "10:00" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("不能相同");
    expect(listTasks().length).toBe(before);
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

    const next = await call(`/api/tasks/${taskId}/logs?limit=2&before=${ids[1]}`);
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

    const missingLog = await call("/api/logs/999999");
    expect(missingLog.status).toBe(404);

    const missingTask = await call("/api/tasks/missing/logs");
    expect(missingTask.status).toBe(404);
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
