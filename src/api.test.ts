import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "./api";
import { closeDb, getTask, initDb, insertLog, listTasks } from "./db";
import { stopAll } from "./scheduler";
import type { NewLogInput } from "./types";

beforeEach(() => {
  stopAll();
  closeDb();
  initDb(":memory:");
});

afterAll(() => {
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
      payload({ curl: "curl -u user:pass https://example.com" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("-u");
    expect(listTasks().length).toBe(before);
  });

  test("rejects an invalid notification curl before inserting", async () => {
    const before = listTasks().length;
    const response = await post(
      "/api/tasks",
      payload({ notify_enabled: true, notify_curl: "curl -k https://notify.example" }),
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("-k");
    expect(listTasks().length).toBe(before);
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
