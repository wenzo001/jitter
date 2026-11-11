import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDb,
  createTask,
  getTask,
  initDb,
  listLogs,
  updateTaskNextRun,
} from "./db";
import {
  pauseTask,
  resumeTask,
  startScheduler,
  stopAll,
  stopTask,
} from "./scheduler";
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
    const bootAt = Date.now();
    startScheduler();

    const log = await waitForLog(task.id, (entry) => entry.kind === "missed");
    expect(log.error).toContain("错过执行窗口");
    // The write time, not the stale plan time: retention filters on this column
    // and must not immediately delete a freshly recorded miss.
    expect(log.executed_at).toBeGreaterThanOrEqual(bootAt);
    expect(okHits).toBe(hitsBefore);

    const latest = await waitForFuturePlan(task.id);
    expect(latest.status).toBe("active");
  });

  test("regression: pausing 'from tomorrow' at noon keeps today's afternoon run", async () => {
    const task = makeTask("afternoon run", urlOf("/ok"), currentWindow());
    const planned = Date.now() + 400;
    updateTaskNextRun(task.id, planned);

    const paused = pauseTask(task.id, { days: 1, startsToday: false });
    expect(paused?.paused_from).not.toBeNull();
    expect(paused?.paused_from).toBeGreaterThan(Date.now());
    expect(paused?.paused_until).toBeGreaterThan(Date.now());
    expect(paused?.next_run_at).toBe(planned);

    // A restart must not discard the plan either (this used to push it to the
    // resume day and silently skip today's window).
    startScheduler();
    expect(getTask(task.id)?.next_run_at).toBe(planned);

    const log = await waitForLog(task.id, (entry) => entry.kind === "task");
    expect(log.response_status).toBe(200);
    expect(okHits).toBe(1);
  });

  test("after today's run, the next plan skips the paused days", async () => {
    const task = makeTask("replan after run", urlOf("/ok"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 400);
    const paused = pauseTask(task.id, { days: 1, startsToday: false });

    startScheduler();
    await waitForLog(task.id, (entry) => entry.kind === "task");
    const latest = await waitForFuturePlan(task.id);
    expect(latest.next_run_at!).toBeGreaterThanOrEqual(paused!.paused_until!);
  });

  test("pausing 'from today' cancels the whole remaining day and resumes after N days", async () => {
    const task = makeTask("skip today", urlOf("/ok"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 400);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resume = new Date(today.getTime());
    resume.setDate(resume.getDate() + 2);

    const paused = pauseTask(task.id, { days: 2, startsToday: true });
    expect(paused?.paused_from).toBe(today.getTime());
    expect(paused?.paused_until).toBe(resume.getTime());
    expect(paused?.next_run_at).toBeGreaterThanOrEqual(resume.getTime());

    startScheduler();
    await Bun.sleep(800);
    expect(okHits).toBe(0);
    expect(getTask(task.id)?.next_run_at).toBeGreaterThanOrEqual(resume.getTime());
  });

  test("shortening a pause replaces the far-future plan left by a longer one", () => {
    const task = makeTask("re-pause", urlOf("/ok"), currentWindow());

    const long = pauseTask(task.id, { days: 15, startsToday: true });
    const farPlan = long!.next_run_at!;
    expect(farPlan).toBeGreaterThan(Date.now() + 10 * 86_400_000);

    const shorter = pauseTask(task.id, { days: 1, startsToday: true });
    expect(shorter!.paused_until).toBeLessThan(farPlan);
    expect(shorter!.next_run_at).toBeGreaterThanOrEqual(shorter!.paused_until!);
    expect(shorter!.next_run_at).toBeLessThan(farPlan);

    // A restart must honour the shortened interval as well.
    startScheduler();
    expect(getTask(task.id)?.next_run_at).toBeLessThan(farPlan);
  });

  test("a paused task does not fire until the pause ends", async () => {
    const task = makeTask("paused run", urlOf("/ok"), currentWindow());
    const paused = pauseTask(task.id, { days: 1, startsToday: true });
    expect(paused?.paused_until).not.toBeNull();
    expect(paused?.paused_until).toBeGreaterThan(Date.now());

    startScheduler();
    await Bun.sleep(300);
    expect(okHits).toBe(0);

    const latest = getTask(task.id)!;
    expect(latest.next_run_at).not.toBeNull();
    expect(latest.next_run_at!).toBeGreaterThanOrEqual(latest.paused_until!);
  });

  test("pausing while a request is in flight never re-runs the same window", async () => {
    const task = makeTask("in-flight pause", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 80);
    startScheduler();

    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2000) await Bun.sleep(10);
    expect(slowHits).toBe(1);

    const paused = pauseTask(task.id, { days: 1, startsToday: false });
    expect(paused?.paused_from).toBeGreaterThan(Date.now());
    // The consumed target must stay. A fresh plan inside the current window
    // would fire a second time (or strand the task if its timer wins).
    expect(paused!.next_run_at).toBeLessThanOrEqual(Date.now());

    await Bun.sleep(700); // /slow takes 400ms; give the finally time to replan
    expect(slowHits).toBe(1);
    const latest = getTask(task.id)!;
    expect(latest.next_run_at).toBeGreaterThanOrEqual(latest.paused_until!);
  });

  test("cancelling a pause while a request is in flight never re-runs the window", async () => {
    const task = makeTask("in-flight resume", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 80);
    pauseTask(task.id, { days: 1, startsToday: false }); // keeps today's plan
    startScheduler();

    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2000) await Bun.sleep(10);
    expect(slowHits).toBe(1);

    const resumed = resumeTask(task.id);
    expect(resumed?.paused_until).toBeNull();
    expect(resumed!.next_run_at).toBeLessThanOrEqual(Date.now());

    await Bun.sleep(700);
    expect(slowHits).toBe(1);
    expect(getTask(task.id)!.next_run_at).toBeGreaterThan(Date.now());
  });

  test("cancelling a pause clears the deadline and resumes scheduling", () => {
    const task = makeTask("cancel pause", urlOf("/ok"), currentWindow());
    pauseTask(task.id, { days: 2 });
    const paused = getTask(task.id)!;
    expect(paused.paused_until).not.toBeNull();

    const resumed = resumeTask(task.id);
    expect(resumed?.paused_until).toBeNull();
    expect(resumed?.next_run_at).not.toBeNull();
  });
});
