import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, setActiveConfig } from "./config";
import { closeDb, createTask, initDb, listLogs } from "./db";
import { executeTaskRun } from "./executor";
import { runTestBench } from "./testbench";
import type { NewTaskInput, TaskRow } from "./types";

let server: ReturnType<typeof Bun.serve>;
let mainHits = 0;
let notifyHits = 0;
let guardHits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/main") {
        mainHits += 1;
        return new Response("main-ok");
      }
      if (url.pathname === "/guard-ok") {
        guardHits += 1;
        return Response.json({ allow: true });
      }
      if (url.pathname === "/guard-no") {
        guardHits += 1;
        return Response.json({ allow: false });
      }
      if (url.pathname === "/guard-500") {
        guardHits += 1;
        return new Response("boom", { status: 500 });
      }
      if (url.pathname === "/notify") {
        notifyHits += 1;
        return new Response("notified");
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  setActiveConfig({ ...DEFAULT_CONFIG });
  closeDb();
  initDb(":memory:");
  mainHits = 0;
  notifyHits = 0;
  guardHits = 0;
});

afterEach(() => {
  closeDb();
});

function urlOf(path: string): string {
  return new URL(path, server.url).toString();
}

function makeTask(overrides: Partial<NewTaskInput> = {}): TaskRow {
  const input: NewTaskInput = {
    name: "guarded task",
    curl_command: null,
    request: { url: urlOf("/main"), method: "GET", headers: {}, body: null },
    window_start: "00:00",
    window_end: "23:59",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
    ...overrides,
  };
  return createTask(input);
}

function guard(path: string) {
  return { url: urlOf(path), method: "GET", headers: {}, body: null };
}

describe("pre-run guard (executeTaskRun)", () => {
  test("sends the main request when the guard passes", async () => {
    const task = makeTask({
      precheck_enabled: true,
      precheck_request: guard("/guard-ok"),
      precheck_expr: "allow=true",
    });

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(false);
    expect(outcome.matched).toBe(true);
    expect(mainHits).toBe(1);

    const logs = listLogs(task.id, 10, null);
    expect(logs[0]!.kind).toBe("task");
  });

  test("skips the main request when the guard expression is false", async () => {
    const task = makeTask({
      precheck_enabled: true,
      precheck_curl_command: `curl '${urlOf("/guard-no")}'`,
      precheck_request: guard("/guard-no"),
      precheck_expr: "allow=true",
    });

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(true);
    expect(outcome.matched).toBe(false);
    expect(mainHits).toBe(0);

    const logs = listLogs(task.id, 10, null);
    expect(logs.length).toBe(1);
    expect(logs[0]!.kind).toBe("skipped");
    expect(logs[0]!.error).toContain("前置条件不满足");
    expect(logs[0]!.error).toContain("已跳过主请求");
    // The skipped row documents the GUARD exchange, which is what happened.
    expect(logs[0]!.request_url).toBe(urlOf("/guard-no"));
    expect(logs[0]!.response_body).toContain("false");
  });

  test("a guard returning a non-2xx status skips the run", async () => {
    const task = makeTask({
      precheck_enabled: true,
      precheck_request: guard("/guard-500"),
    });

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(true);
    expect(mainHits).toBe(0);
    const logs = listLogs(task.id, 10, null);
    expect(logs[0]!.error).toContain("HTTP 500");
  });

  test("an unreachable guard skips the run instead of sending the main request", async () => {
    const task = makeTask({
      precheck_enabled: true,
      precheck_request: { url: "http://127.0.0.1:1/never", method: "GET", headers: {}, body: null },
    });

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("前置判断请求失败");
    expect(mainHits).toBe(0);
  });

  test("tasks without a guard behave exactly as before", async () => {
    const task = makeTask();
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(false);
    expect(mainHits).toBe(1);
    expect(listLogs(task.id, 10, null)[0]!.kind).toBe("task");
  });

  test("local weekday condition skips without sending ANY request", async () => {
    const today = new Date().getDay();
    const otherDay = (today + 3) % 7;
    const task = makeTask({
      precheck_enabled: true,
      precheck_weekdays: [otherDay],
      precheck_request: guard("/guard-ok"),
    });

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("不在允许执行的星期");
    expect(mainHits).toBe(0);
    // The guard curl must not even be attempted when the local guard fails.
    expect(guardHits).toBe(0);

    const logs = listLogs(task.id, 10, null);
    expect(logs.length).toBe(1);
    expect(logs[0]!.kind).toBe("skipped");
    expect(logs[0]!.request_url).toBeNull();
    expect(logs[0]!.response_status).toBeNull();
  });

  test("local conditions alone can gate a run (no guard curl)", async () => {
    const today = new Date().getDay();
    const task = makeTask({
      precheck_enabled: true,
      precheck_weekdays: [today],
    });
    expect(task.precheck_enabled).toBe(1);
    expect(task.precheck_url).toBeNull();

    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(false);
    expect(mainHits).toBe(1);
  });

  test("local conditions and the guard curl both have to pass", async () => {
    const today = new Date().getDay();
    const task = makeTask({
      precheck_enabled: true,
      precheck_weekdays: [today],
      precheck_request: guard("/guard-no"),
      precheck_expr: "allow=true",
    });
    const outcome = await executeTaskRun(task, new AbortController().signal);
    expect(outcome.skipped).toBe(true);
    expect(outcome.error).toContain("前置条件不满足");
    expect(guardHits).toBe(1);
    expect(mainHits).toBe(0);
  });
});

describe("test bench", () => {
  test("runs parse → main → verdict and reports each step", async () => {
    const result = await runTestBench({ curl: `curl -X GET '${urlOf("/main")}'` });
    expect(result.steps.map((step) => step.key)).toEqual(["parse", "main", "assert"]);
    expect(result.steps[1]!.status).toBe("ok");
    expect(result.steps[1]!.response?.status).toBe(200);
    expect(result.summary.matched).toBe(true);
  });

  test("shows a parse failure as a step instead of throwing", async () => {
    const result = await runTestBench({ curl: "curl --form file=@x https://example.com" });
    expect(result.steps[0]!.key).toBe("parse");
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.summary.error).toBeTruthy();
  });

  test("stops at the guard and marks the main request as skipped", async () => {
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      precheck_enabled: true,
      precheck_curl: `curl '${urlOf("/guard-no")}'`,
      precheck_expr: "allow=true",
    });
    expect(result.steps.map((step) => step.key)).toEqual(["parse", "precheck", "main"]);
    expect(result.steps[1]!.status).toBe("fail");
    expect(result.steps[2]!.status).toBe("skip");
    expect(result.summary.skipped).toBe(true);
    expect(mainHits).toBe(0);
  });

  test("reports a failed local condition before touching the network", async () => {
    const otherDay = (new Date().getDay() + 3) % 7;
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      precheck_enabled: true,
      precheck_weekdays: [otherDay],
      precheck_curl: `curl '${urlOf("/guard-ok")}'`,
    });
    expect(result.steps.map((step) => step.key)).toEqual(["parse", "local", "main"]);
    expect(result.steps[1]!.status).toBe("fail");
    expect(result.steps[1]!.detail).toContain("不在允许执行的星期");
    expect(result.steps[2]!.status).toBe("skip");
    expect(result.summary.skipped).toBe(true);
    expect(guardHits).toBe(0);
    expect(mainHits).toBe(0);
  });

  test("rejects a guard that has no condition at all", async () => {
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      precheck_enabled: true,
    });
    expect(result.steps.at(-1)!.key).toBe("precheck");
    expect(result.steps.at(-1)!.status).toBe("fail");
    expect(mainHits).toBe(0);
  });

  test("dry-run notification is reported but never sent", async () => {
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      notify_enabled: true,
      notify_curl: `curl '${urlOf("/notify")}'`,
    });
    const notifyStep = result.steps[result.steps.length - 1]!;
    expect(notifyStep.key).toBe("notify");
    expect(notifyStep.status).toBe("skip");
    expect(notifyStep.detail).toContain("演练");
    expect(notifyHits).toBe(0);
  });

  test("sends the notification only when explicitly requested", async () => {
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      notify_enabled: true,
      notify_curl: `curl '${urlOf("/notify")}'`,
      send_notify: true,
    });
    const notifyStep = result.steps[result.steps.length - 1]!;
    expect(notifyStep.status).toBe("ok");
    expect(notifyHits).toBe(1);
    expect(result.summary.notifySent).toBe(true);
  });

  test("does not send a notification when the verdict misses", async () => {
    const result = await runTestBench({
      curl: `curl '${urlOf("/main")}'`,
      expect_status: 201,
      notify_enabled: true,
      notify_curl: `curl '${urlOf("/notify")}'`,
      send_notify: true,
    });
    expect(result.summary.matched).toBe(false);
    const notifyStep = result.steps[result.steps.length - 1]!;
    expect(notifyStep.status).toBe("skip");
    expect(notifyHits).toBe(0);
  });
});
