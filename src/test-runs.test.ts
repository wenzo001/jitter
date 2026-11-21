import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { app } from "./api";
import { DEFAULT_CONFIG, setActiveConfig } from "./config";
import {
  closeDb,
  createTask,
  deleteTask,
  getTestRun,
  initDb,
  insertTestRun,
  listTestRuns,
  TEST_RUN_KEEP,
} from "./db";
import type { NewTaskInput } from "./types";

beforeEach(() => {
  setActiveConfig({ ...DEFAULT_CONFIG });
  closeDb();
  initDb(":memory:");
});

afterAll(() => {
  closeDb();
});

function input(name: string): NewTaskInput {
  return {
    name,
    curl_command: null,
    request: { url: "https://example.com/api", method: "GET", headers: {}, body: null },
    window_start: "10:00",
    window_end: "10:10",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
  };
}

function summaryOf(index: number): string {
  return JSON.stringify({ matched: index % 2 === 0, index });
}

describe("test-bench history", () => {
  test(`keeps only the newest ${TEST_RUN_KEEP} runs per task`, () => {
    const task = createTask(input("history"));
    for (let index = 0; index < TEST_RUN_KEEP + 3; index += 1) {
      insertTestRun({
        task_id: task.id,
        ok: index % 2 === 0,
        summary: summaryOf(index),
        steps: JSON.stringify([{ key: "main", index }]),
      });
    }

    const runs = listTestRuns(task.id);
    expect(runs.length).toBe(TEST_RUN_KEEP);
    // Newest first, and the three oldest were pruned.
    expect((JSON.parse(runs[0]!.summary) as { index: number }).index).toBe(TEST_RUN_KEEP + 2);
    expect((JSON.parse(runs[runs.length - 1]!.summary) as { index: number }).index).toBe(3);
  });

  test("pruning one task never touches another task's history", () => {
    const busy = createTask(input("busy"));
    const quiet = createTask(input("quiet"));
    insertTestRun({
      task_id: quiet.id,
      ok: true,
      summary: summaryOf(0),
      steps: "[]",
    });
    for (let index = 0; index < TEST_RUN_KEEP + 2; index += 1) {
      insertTestRun({ task_id: busy.id, ok: true, summary: summaryOf(index), steps: "[]" });
    }
    expect(listTestRuns(quiet.id).length).toBe(1);
    expect(listTestRuns(busy.id).length).toBe(TEST_RUN_KEEP);
  });

  test("stores the full step timeline for one run", () => {
    const task = createTask(input("detail"));
    const id = insertTestRun({
      task_id: task.id,
      ok: true,
      summary: summaryOf(1),
      steps: JSON.stringify([{ key: "parse", status: "ok" }]),
    });
    const run = getTestRun(id);
    expect(run?.task_id).toBe(task.id);
    expect(JSON.parse(run!.steps)).toEqual([{ key: "parse", status: "ok" }]);
    expect(JSON.parse(run!.summary)).toEqual({ matched: false, index: 1 });
  });

  test("deleting a task removes its history", () => {
    const task = createTask(input("doomed"));
    insertTestRun({ task_id: task.id, ok: true, summary: summaryOf(0), steps: "[]" });
    insertTestRun({ task_id: task.id, ok: false, summary: summaryOf(1), steps: "[]" });

    const outcome = deleteTask(task.id);
    expect(outcome.deleted).toBe(true);
    expect(outcome.deleted_test_runs).toBe(2);
    expect(listTestRuns(task.id).length).toBe(0);
  });
});

describe("test history API", () => {
  test("persists a task-scoped test run and serves it back", async () => {
    const task = createTask(input("api history"));

    const response = await app.handle(
      new Request("http://localhost/api/test/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Unreachable on purpose: the run fails fast and still gets stored.
          curl: "curl http://127.0.0.1:1/never",
          task_id: task.id,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: unknown; test_run_id: number | null };
    expect(typeof body.test_run_id).toBe("number");

    const listResponse = await app.handle(
      new Request(`http://localhost/api/tasks/${task.id}/test-runs`),
    );
    const list = (await listResponse.json()) as {
      runs: Array<{ id: number; ok: number; summary: { matched: boolean } }>;
    };
    expect(list.runs.length).toBe(1);
    expect(list.runs[0]!.id).toBe(body.test_run_id!);
    expect(list.runs[0]!.ok).toBe(0);
    expect(list.runs[0]!.summary.matched).toBe(false);

    const detailResponse = await app.handle(
      new Request(`http://localhost/api/test-runs/${body.test_run_id}`),
    );
    const detail = (await detailResponse.json()) as {
      run: { task_id: string; steps: Array<{ key: string }> };
    };
    expect(detail.run.task_id).toBe(task.id);
    expect(detail.run.steps[0]!.key).toBe("parse");
  });

  test("a test without task_id is not persisted", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/test/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ curl: "curl http://127.0.0.1:1/never" }),
      }),
    );
    const body = (await response.json()) as { test_run_id: number | null };
    expect(body.test_run_id).toBeNull();

    const task = createTask(input("untouched"));
    const listResponse = await app.handle(
      new Request(`http://localhost/api/tasks/${task.id}/test-runs`),
    );
    const list = (await listResponse.json()) as { runs: unknown[] };
    expect(list.runs.length).toBe(0);
  });

  test("returns 404 for an unknown task or run", async () => {
    const missingTask = await app.handle(
      new Request("http://localhost/api/tasks/nope/test-runs"),
    );
    expect(missingTask.status).toBe(404);

    const missingRun = await app.handle(new Request("http://localhost/api/test-runs/999"));
    expect(missingRun.status).toBe(404);
  });
});
