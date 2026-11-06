import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDb,
  createTask,
  getTask,
  initDb,
  listLogs,
  updateTaskNextRun,
} from "./db";
import { startScheduler, stopAll, stopTask } from "./scheduler";
import type { LogRow, NewTaskInput, TaskRow } from "./types";

let target: ReturnType<typeof Bun.serve>;
let okHits = 0;
let slowHits = 0;

beforeAll(() => {
  target = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/slow") {
        slowHits += 1;
        await Bun.sleep(400);
        return new Response("late");
      }
      okHits += 1;
      return new Response("ok");
    },
  });
});

afterAll(() => {
  target.stop(true);
});

beforeEach(() => {
  stopAll();
  closeDb();
  initDb(":memory:");
  okHits = 0;
  slowHits = 0;
});

afterEach(() => {
  stopAll();
});

function urlOf(path: string): string {
  return new URL(path, target.url).toString();
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function currentWindow() {
  const now = new Date();
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 2 * 60_000);
  return { window_start: hhmm(start), window_end: hhmm(end) };
}

function endedWindow() {
  const now = new Date();
  const start = new Date(now.getTime() - 2 * 60_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 60_000);
  return { window_start: hhmm(start), window_end: hhmm(end) };
}

function makeTask(
  name: string,
  url: string,
  window: { window_start: string; window_end: string },
): TaskRow {
  const input: NewTaskInput = {
    name,
    curl_command: null,
    request: { url, method: "GET", headers: {}, body: null },
    ...window,
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
  };
  return createTask(input);
}

async function waitForLog(
  taskId: string,
  predicate: (log: LogRow) => boolean,
  timeout = 3_000,
): Promise<LogRow> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = listLogs(taskId, 20, null).find(predicate);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for a log");
}

async function waitForFuturePlan(taskId: string, timeout = 2_000): Promise<TaskRow> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const task = getTask(taskId);
    if (task !== null && task.next_run_at !== null && task.next_run_at > Date.now()) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error("task was not replanned");
}

describe("scheduler runtime", () => {
  test("fires a plan inside the current window and replans", async () => {
    const task = makeTask("normal run", urlOf("/ok"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 100);

    startScheduler();
    const log = await waitForLog(task.id, (entry) => entry.kind === "task");
    expect(log.response_status).toBe(200);
    expect(log.response_body).toBe("ok");
    expect(log.matched).toBe(1);
    expect(log.aborted).toBe(0);
    expect(okHits).toBe(1);

    const latest = await waitForFuturePlan(task.id);
    expect(latest.status).toBe("active");
  });

  test("stop aborts an in-flight request and leaves no plan", async () => {
    const task = makeTask("slow run", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 100);

    startScheduler();
    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2_000) {
      await Bun.sleep(10);
    }
    expect(slowHits).toBe(1);

    const stopped = stopTask(task.id);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.next_run_at).toBeNull();

    const log = await waitForLog(task.id, (entry) => entry.kind === "task");
    expect(log.aborted).toBe(1);
    expect(log.error).toContain("中断");

    await Bun.sleep(700);
    expect(slowHits).toBe(1);
  });

  test("startup records a missed window without sending the request", async () => {
    const task = makeTask("missed run", urlOf("/ok"), endedWindow());
    const stalePlan = Date.now() - 90_000;
    updateTaskNextRun(task.id, stalePlan);

    const hitsBefore = okHits;
    startScheduler();

    const log = await waitForLog(task.id, (entry) => entry.kind === "missed");
    expect(log.error).toContain("错过执行窗口");
    expect(log.executed_at).toBe(stalePlan);
    expect(okHits).toBe(hitsBefore);

    const latest = await waitForFuturePlan(task.id);
    expect(latest.status).toBe("active");
  });
});
