import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, createTask, initDb, listLogs } from "./db";
import {
  RESPONSE_BODY_LIMIT,
  evaluateSuccess,
  executeTaskRun,
  readBodyCapped,
} from "./executor";
import type { NewTaskInput, TaskRow } from "./types";

let server: ReturnType<typeof Bun.serve>;
let notifyHits = 0;

beforeAll(() => {
  initDb(":memory:");
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/notify") {
        notifyHits += 1;
        return new Response("notified");
      }
      if (url.pathname === "/ok") return new Response("ok");
      if (url.pathname === "/no") return new Response("no");
      if (url.pathname === "/slow") {
        await Bun.sleep(5_000);
        return new Response("late");
      }
      if (url.pathname === "/echo") {
        return new Response(await request.text(), {
          status: 201,
          headers: { "X-Echo": "yes" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  closeDb();
});

function urlOf(path: string): string {
  return new URL(path, server.url).toString();
}

function makeTask(overrides: Partial<NewTaskInput> = {}): TaskRow {
  const input: NewTaskInput = {
    name: "executor test",
    curl_command: null,
    request: {
      url: urlOf("/ok"),
      method: "GET",
      headers: {},
      body: null,
    },
    window_start: "10:00",
    window_end: "10:10",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    ...overrides,
  };
  return createTask(input);
}

function withNotify(overrides: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    name: "notify test",
    curl_command: null,
    request: { url: urlOf("/ok"), method: "GET", headers: {}, body: null },
    window_start: "10:00",
    window_end: "10:10",
    notify_enabled: true,
    notify_curl_command: "curl -X POST https://notify.example/ping",
    notify_request: {
      url: urlOf("/notify"),
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "ping",
    },
    expect_status: 200,
    expect_body: "ok",
    ...overrides,
  };
}

describe("evaluateSuccess", () => {
  const base = {
    status: 200,
    body: "ok",
    truncated: false,
    aborted: false,
    error: null,
    expectStatus: null,
    expectBody: null,
  };

  test("defaults to any 2xx", () => {
    expect(evaluateSuccess(base)).toBe(true);
    expect(evaluateSuccess({ ...base, status: 204, body: "" })).toBe(true);
    expect(evaluateSuccess({ ...base, status: 404 })).toBe(false);
  });

  test("honors an expected status", () => {
    expect(evaluateSuccess({ ...base, expectStatus: 200 })).toBe(true);
    expect(evaluateSuccess({ ...base, expectStatus: 201 })).toBe(false);
    expect(evaluateSuccess({ ...base, status: 500, expectStatus: 500 })).toBe(true);
  });

  test("honors an exact expected body", () => {
    expect(evaluateSuccess({ ...base, expectBody: "ok" })).toBe(true);
    expect(evaluateSuccess({ ...base, expectBody: "OK" })).toBe(false);
    expect(evaluateSuccess({ ...base, expectBody: "" })).toBe(false);
  });

  test("requires both expectations to match", () => {
    expect(evaluateSuccess({ ...base, expectStatus: 200, expectBody: "ok" })).toBe(true);
    expect(evaluateSuccess({ ...base, expectStatus: 200, expectBody: "no" })).toBe(false);
  });

  test("fails on truncated bodies when a body is expected", () => {
    expect(evaluateSuccess({ ...base, expectBody: "ok", truncated: true })).toBe(false);
  });

  test("fails on errors and aborts", () => {
    expect(evaluateSuccess({ ...base, error: "boom" })).toBe(false);
    expect(evaluateSuccess({ ...base, aborted: true })).toBe(false);
    expect(evaluateSuccess({ ...base, status: null })).toBe(false);
  });
});

describe("readBodyCapped", () => {
  test("keeps a small body intact", async () => {
    expect(await readBodyCapped(new Response("hello"))).toEqual({ text: "hello", truncated: false });
  });

  test("caps a large body", async () => {
    const result = await readBodyCapped(new Response("x".repeat(RESPONSE_BODY_LIMIT + 5_000)));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(RESPONSE_BODY_LIMIT);
  });

  test("does not mark an exact-limit body as truncated", async () => {
    const result = await readBodyCapped(new Response("a".repeat(RESPONSE_BODY_LIMIT)));
    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(RESPONSE_BODY_LIMIT);
  });

  test("handles an empty body", async () => {
    expect(await readBodyCapped(new Response(""))).toEqual({ text: "", truncated: false });
  });
});

describe("executeTaskRun", () => {
  test("writes a full task log", async () => {
    const task = makeTask();
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.matched).toBe(true);
    expect(outcome.notifyLogId).toBeNull();

    const logs = listLogs(task.id, 10);
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.kind).toBe("task");
    expect(log.request_method).toBe("GET");
    expect(log.response_status).toBe(200);
    expect(log.response_body).toBe("ok");
    expect(log.aborted).toBe(0);
    expect(log.matched).toBe(1);
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("sends the notification curl only when the response matches", async () => {
    const hitsBefore = notifyHits;
    const task = makeTask(withNotify());
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.matched).toBe(true);
    expect(outcome.notifyLogId).not.toBeNull();

    const logs = listLogs(task.id, 10);
    expect(logs.map((log) => log.kind)).toEqual(["notify", "task"]);
    const notify = logs[0]!;
    expect(notify.parent_log_id).toBe(logs[1]!.id);
    expect(notify.response_status).toBe(200);
    expect(notify.request_body).toBe("ping");
    expect(notifyHits).toBe(hitsBefore + 1);
  });

  test("skips the notification when the body differs", async () => {
    const hitsBefore = notifyHits;
    const task = makeTask(
      withNotify({
        request: { url: urlOf("/no"), method: "GET", headers: {}, body: null },
      }),
    );
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.matched).toBe(false);
    expect(outcome.notifyLogId).toBeNull();
    expect(notifyHits).toBe(hitsBefore);
    expect(listLogs(task.id, 10)).toHaveLength(1);
  });

  test("records aborted=1 when the request is interrupted", async () => {
    const task = makeTask({
      request: { url: urlOf("/slow"), method: "GET", headers: {}, body: null },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const outcome = await executeTaskRun(task, controller.signal);
    clearTimeout(timer);

    expect(outcome.aborted).toBe(true);
    expect(outcome.matched).toBe(false);
    const log = listLogs(task.id, 10)[0]!;
    expect(log.aborted).toBe(1);
    expect(log.error).toContain("中断");
  });

  test("captures a non-2xx status without treating it as a transport error", async () => {
    const task = makeTask({
      request: { url: urlOf("/missing"), method: "GET", headers: {}, body: null },
    });
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.status).toBe(404);
    expect(outcome.error).toBeNull();
    expect(outcome.matched).toBe(false);
  });
});
