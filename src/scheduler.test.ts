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
  RunNowError,
  deleteTask,
  editTask,
  pauseTask,
  resumeTask,
  runTaskNow,
  runningTasks,
  runtimeCount,
  scheduleNewTask,
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
  extra: Partial<NewTaskInput> = {},
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
    expect_expr: null,
    ...extra,
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

  test("reports a task as running while its request is in flight", async () => {
    const task = makeTask("running state", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 100);

    startScheduler();
    const start = Date.now();
    let snapshot = runningTasks();
    while (snapshot[task.id] === undefined && Date.now() - start < 2_000) {
      await Bun.sleep(10);
      snapshot = runningTasks();
    }
    // The UI shows this badge so a hanging request is visible.
    expect(snapshot[task.id]).toBeGreaterThan(0);

    await waitForLog(task.id, (entry) => entry.kind === "task");
    expect(runningTasks()[task.id]).toBeUndefined();
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

  test("delete tears down an in-flight task and leaves no row or log behind", async () => {
    const task = makeTask("delete in flight", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 100);

    startScheduler();
    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2_000) {
      await Bun.sleep(10);
    }
    expect(slowHits).toBe(1);
    expect(runtimeCount()).toBe(1);

    const outcome = await deleteTask(task.id);
    expect(outcome?.task.id).toBe(task.id);

    // The runtime is gone, the task row is gone, and the aborted run's log was
    // written before the transaction and therefore removed with everything.
    expect(runtimeCount()).toBe(0);
    expect(getTask(task.id)).toBeNull();
    expect(listLogs(task.id, 100)).toHaveLength(0);

    await Bun.sleep(700);
    expect(slowHits).toBe(1);
    expect(listLogs(task.id, 100)).toHaveLength(0);
  });

  test("run now executes once, logs it, and leaves the schedule untouched", async () => {
    const task = makeTask("run now", urlOf("/ok"), currentWindow());
    const plannedAt = Date.now() + 3 * 60 * 60_000;
    updateTaskNextRun(task.id, plannedAt);

    const result = await runTaskNow(task.id);
    expect(result?.outcome.status).toBe(200);
    expect(result?.outcome.matched).toBe(true);
    expect(listLogs(task.id, 100)).toHaveLength(1);
    expect(listLogs(task.id, 100)[0]?.kind).toBe("task");

    // The manual run must not consume or shift the planned window.
    expect(getTask(task.id)?.next_run_at).toBe(plannedAt);
    expect(runtimeCount()).toBe(0);
  });

  test("run now on a missing task returns null", async () => {
    expect(await runTaskNow("does-not-exist")).toBeNull();
  });

  test("run now rejects while the task is already executing", async () => {
    const task = makeTask("run now busy", urlOf("/slow"), currentWindow());
    const first = runTaskNow(task.id);
    // Let the first run reach the in-flight state before attempting a second.
    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2_000) {
      await Bun.sleep(10);
    }
    expect(slowHits).toBe(1);
    await expect(runTaskNow(task.id)).rejects.toBeInstanceOf(RunNowError);
    await first;
  });

  test("deleting a task mid manual run aborts it without an orphan log", async () => {
    const task = makeTask("delete during manual", urlOf("/slow"), currentWindow());
    const running = runTaskNow(task.id);
    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2_000) {
      await Bun.sleep(10);
    }
    await deleteTask(task.id);
    const outcome = await running;
    expect(outcome?.outcome.aborted).toBe(true);
    expect(listLogs(task.id, 100)).toHaveLength(0);
    expect(getTask(task.id)).toBeNull();
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

  test("shortening a pause replaces a far-future interval plan too", () => {
    const task = makeTask(
      "interval re-pause",
      urlOf("/ok"),
      { window_start: "", window_end: "" },
      { schedule_kind: "interval", interval_seconds: 3600 },
    );
    scheduleNewTask(task);

    const long = pauseTask(task.id, { days: 10, startsToday: true });
    const farPlan = long!.next_run_at!;
    expect(farPlan).toBeGreaterThan(Date.now() + 9 * 86_400_000);

    const shorter = pauseTask(task.id, { days: 1, startsToday: true });
    expect(shorter!.next_run_at).toBeLessThan(farPlan);
    expect(shorter!.next_run_at).toBeLessThanOrEqual(Date.now() + 25 * 3600_000);

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

function editInput(task: TaskRow, overrides: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    name: task.name,
    curl_command: task.curl_command,
    request: {
      url: task.request_url,
      method: task.request_method,
      headers: task.request_headers ? JSON.parse(task.request_headers) : {},
      body: task.request_body,
    },
    window_start: task.window_start,
    window_end: task.window_end,
    notify_enabled: task.notify_enabled === 1,
    notify_curl_command: task.notify_curl_command,
    notify_request: task.notify_url
      ? {
          url: task.notify_url,
          method: task.notify_method ?? "GET",
          headers: task.notify_headers ? JSON.parse(task.notify_headers) : {},
          body: task.notify_body,
        }
      : null,
    expect_status: task.expect_status,
    expect_body: task.expect_body,
    expect_expr: task.expect_expr,
    ...overrides,
  };
}

describe("editTask", () => {
  test("editing an active task persists config and keeps it scheduled", () => {
    const task = makeTask("before edit", urlOf("/ok"), currentWindow());
    const updated = editTask(task.id, editInput(task, { name: "after edit", window_end: "23:59" }));
    expect(updated?.name).toBe("after edit");
    expect(updated?.status).toBe("active");
    expect(updated?.next_run_at).not.toBeNull();
    expect(getTask(task.id)?.window_end).toBe("23:59");
  });

  test("editing an unchanged window keeps the already-randomised pending plan", () => {
    const task = makeTask("keep plan", urlOf("/ok"), currentWindow());
    const target = Date.now() + 30_000;
    updateTaskNextRun(task.id, target);
    const updated = editTask(task.id, editInput(task, { name: "renamed" }))!;
    expect(updated.next_run_at).toBe(target);
  });

  test("editing a stopped task updates config without starting the scheduler", () => {
    const task = makeTask("stopped", urlOf("/ok"), currentWindow());
    stopTask(task.id);
    const updated = editTask(task.id, editInput(task, { name: "stopped edited" }))!;
    expect(updated.name).toBe("stopped edited");
    expect(updated.status).toBe("stopped");
    expect(updated.next_run_at).toBeNull();
  });

  test("editing while a request is in flight never re-runs the consumed window", async () => {
    const task = makeTask("in-flight edit", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 80);
    startScheduler();

    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2000) await Bun.sleep(10);
    expect(slowHits).toBe(1);

    const edited = editTask(task.id, editInput(task, { name: "edited mid-flight" }))!;
    expect(edited.name).toBe("edited mid-flight");

    await Bun.sleep(700);
    expect(slowHits).toBe(1);
    expect(getTask(task.id)!.next_run_at).toBeGreaterThan(Date.now());
  });

  test("changing the window while a plan is pending replans into the new window", async () => {
    const task = makeTask("window change", urlOf("/ok"), endedWindow());
    const future = new Date(Date.now() + 60 * 60_000);
    future.setSeconds(0, 0);
    const target = future.getTime();
    updateTaskNextRun(task.id, target);

    const edited = editTask(
      task.id,
      editInput(task, { window_start: "23:00", window_end: "23:10" }),
    )!;
    expect(edited.next_run_at).not.toBe(target);
    expect(edited.next_run_at).toBeGreaterThan(Date.now());

    startScheduler();
    await Bun.sleep(120);
    expect(listLogs(task.id, 20, null).filter((log) => log.kind === "missed")).toHaveLength(0);
  });

  test("editing the window in flight still runs once in the new window today", async () => {
    const task = makeTask("in-flight window", urlOf("/slow"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 60);
    startScheduler();
    const start = Date.now();
    while (slowHits === 0 && Date.now() - start < 2000) await Bun.sleep(10);
    expect(slowHits).toBe(1);

    // A DIFFERENT window covering "now" that has not run yet today. Its random
    // point can be anywhere up to `end`, so keep the window short (2 minutes).
    const other = (() => {
      const now = new Date();
      const s = new Date(now.getTime() - 60_000);
      s.setSeconds(0, 0);
      const e = new Date(s.getTime() + 2 * 60_000);
      return { window_start: hhmm(s), window_end: hhmm(e) };
    })();
    expect(other.window_start).not.toBe(currentWindow().window_start);
    // Pin the random point to "now". The in-flight `finally` does the actual
    // planning, so keep it pinned until that second run has fired.
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      editTask(task.id, editInput(task, other));
      // The wait limit only guards against a hang; the assertion below is
      // what matters. A loaded machine (the whole suite in parallel) can
      // need more than three seconds for the second run to fire.
      const deadline = Date.now() + 10_000;
      while (slowHits < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(slowHits).toBe(2);
    } finally {
      Math.random = originalRandom;
    }
    expect(listLogs(task.id, 20, null).filter((log) => log.kind === "missed")).toHaveLength(0);
  });

  test("editing keeps an active pause in place", () => {
    const task = makeTask("paused edit", urlOf("/ok"), currentWindow());
    pauseTask(task.id, { days: 2 });
    const paused = getTask(task.id)!;
    const updated = editTask(task.id, editInput(task, { name: "paused edited" }))!;
    expect(updated.paused_from).toBe(paused.paused_from);
    expect(updated.paused_until).toBe(paused.paused_until);
    expect(updated.next_run_at).not.toBeNull();
  });

  test("editing a pending task makes the next run use the new config", async () => {
    const task = makeTask("new url", urlOf("/ok"), currentWindow());
    const pending = Date.now() + 120;
    updateTaskNextRun(task.id, pending);
    const edited = editTask(
      task.id,
      editInput(task, {
        request: { url: urlOf("/slow"), method: "GET", headers: {}, body: null },
        expect_status: null,
      }),
    )!;

    // A live plan is preserved, so the run still happens at the original moment.
    expect(edited.next_run_at).toBe(pending);
    startScheduler();
    const log = await waitForLog(
      task.id,
      (entry) => entry.request_url === urlOf("/slow") && entry.response_body === "late",
    );
    expect(log.request_url).toBe(urlOf("/slow"));
  });

  test("editing only the first-run anchor re-plans onto the new grid", () => {
    const task = makeTask(
      "anchor edit",
      urlOf("/ok"),
      { window_start: "", window_end: "" },
      { schedule_kind: "interval", interval_seconds: 3600 },
    );
    scheduleNewTask(task);
    expect(getTask(task.id)!.next_run_at).not.toBeNull();

    const anchor = Date.now() + 3 * 3600_000;
    const edited = editTask(
      task.id,
      editInput(task, {
        schedule_kind: "interval",
        interval_seconds: 3600,
        interval_start_at: anchor,
      }),
    )!;
    expect(edited.interval_start_at).toBe(anchor);
    // The old "one hour from creation" plan must be replaced by the anchor.
    expect(edited.next_run_at).toBe(anchor);
  });

  test("editing never schedules a second run in an already-consumed window", async () => {
    const task = makeTask("no double run", urlOf("/ok"), currentWindow());
    updateTaskNextRun(task.id, Date.now() + 60);
    startScheduler();
    await waitForLog(task.id, (log) => log.kind === "task" && log.response_body === "ok");
    await Bun.sleep(120);

    const after = getTask(task.id)!;
    const edited = editTask(task.id, editInput(task, { name: "edited after run" }))!;
    expect(edited.next_run_at).toBe(after.next_run_at);
    expect(edited.next_run_at).toBeGreaterThan(Date.now());

    await Bun.sleep(400);
    expect(listLogs(task.id, 20, null).filter((log) => log.kind === "task")).toHaveLength(1);
  });
});
