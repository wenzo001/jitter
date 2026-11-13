import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createTask,
  getJournalMode,
  getLog,
  getTask,
  initDb,
  insertLog,
  listLogs,
  listTasks,
  resolveDbPath,
  setTaskPause,
  updateTaskNextRun,
  updateTaskStatus,
} from "./db";
import type { NewTaskInput } from "./types";

const tempDir = mkdtempSync(join(tmpdir(), "jitter-db-"));
const dbPath = join(tempDir, "test.db");

beforeAll(() => {
  initDb(dbPath);
});

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function sampleTask(overrides: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    name: "daily check",
    curl_command: "curl https://example.com/api",
    request: {
      url: "https://example.com/api",
      method: "GET",
      headers: { "X-Test": "1" },
      body: null,
    },
    window_start: "10:10",
    window_end: "10:20",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    ...overrides,
  };
}

describe("db", () => {
  test("enables WAL on a file database", () => {
    expect(getJournalMode()).toBe("wal");
  });

  test("falls back to the default path for a blank path or env", () => {
    const previous = process.env.JITTER_DB_PATH;
    try {
      process.env.JITTER_DB_PATH = "   ";
      expect(resolveDbPath()).toMatch(/app\.db$/);
      expect(resolveDbPath("")).toMatch(/app\.db$/);
    } finally {
      if (previous === undefined) delete process.env.JITTER_DB_PATH;
      else process.env.JITTER_DB_PATH = previous;
    }
  });

  test("creates and reads a task with notification config", () => {
    const task = createTask(
      sampleTask({
        name: "notify me",
        notify_enabled: true,
        notify_curl_command: "curl -X POST https://notify.example/ping",
        notify_request: {
          url: "https://notify.example/ping",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"text":"done"}',
        },
        expect_status: 200,
        expect_body: '{"ok":true}',
      }),
    );

    expect(task.name).toBe("notify me");
    expect(task.window_start).toBe("10:10");
    expect(task.window_end).toBe("10:20");
    expect(task.status).toBe("active");
    expect(task.next_run_at).toBeNull();
    expect(task.notify_enabled).toBe(1);
    expect(task.notify_url).toBe("https://notify.example/ping");
    expect(task.notify_method).toBe("POST");
    expect(JSON.parse(task.notify_headers!)).toEqual({ "Content-Type": "application/json" });
    expect(task.expect_status).toBe(200);
    expect(task.expect_body).toBe('{"ok":true}');

    expect(getTask(task.id)?.id).toBe(task.id);
    expect(listTasks().some((row) => row.id === task.id)).toBe(true);
  });

  test("stores per-request curl options", () => {
    const task = createTask(
      sampleTask({
        name: "request options",
        request: {
          url: "https://example.com/options",
          method: "GET",
          headers: {},
          body: null,
          options: {
            insecure: true,
            redirect: "manual",
            timeoutMs: 1500,
            proxy: "http://127.0.0.1:3128",
          },
        },
      }),
    );
    expect(JSON.parse(task.request_options!)).toEqual({
      insecure: true,
      redirect: "manual",
      timeoutMs: 1500,
      proxy: "http://127.0.0.1:3128",
    });
    expect(task.notify_options).toBe("{}");
  });

  test("updates status and next run", () => {
    const task = createTask(sampleTask({ name: "lifecycle" }));
    const planned = Date.now() + 30_000;
    updateTaskNextRun(task.id, planned, Date.now());
    expect(getTask(task.id)?.next_run_at).toBe(planned);

    updateTaskStatus(task.id, "stopped", null, Date.now());
    const stopped = getTask(task.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.next_run_at).toBeNull();

    updateTaskStatus(task.id, "active", planned, Date.now());
    expect(getTask(task.id)?.status).toBe("active");
  });

  test("stores and clears a pause interval", () => {
    const task = createTask(sampleTask({ name: "pause lifecycle" }));
    expect(task.paused_until).toBeNull();
    expect(task.paused_from).toBeNull();

    const from = Date.now() - 24 * 60 * 60 * 1000;
    const resumeAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const planned = resumeAt + 30_000;
    setTaskPause(task.id, { from, until: resumeAt }, planned, Date.now());
    const paused = getTask(task.id)!;
    expect(paused.paused_from).toBe(from);
    expect(paused.paused_until).toBe(resumeAt);
    expect(paused.next_run_at).toBe(planned);

    setTaskPause(task.id, null, planned, Date.now());
    expect(getTask(task.id)?.paused_until).toBeNull();
    expect(getTask(task.id)?.paused_from).toBeNull();
  });

  test("paginates logs newest first and isolates tasks", () => {
    const task = createTask(sampleTask({ name: "paginate" }));
    const other = createTask(sampleTask({ name: "other" }));
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        insertLog({
          task_id: task.id,
          executed_at: 1_000 + i,
          request_url: "https://example.com",
          request_method: "GET",
          request_headers: "{}",
          request_body: null,
          response_status: 200,
          response_headers: "{}",
          response_body: `body-${i}`,
          duration_ms: 10,
          error: null,
          aborted: 0,
          kind: "task",
          parent_log_id: null,
          matched: 1,
        }),
      );
    }
    insertLog({
      task_id: other.id,
      executed_at: 9_999,
      request_url: "https://other.example",
      request_method: "GET",
      request_headers: null,
      request_body: null,
      response_status: 200,
      response_headers: null,
      response_body: "other",
      duration_ms: 1,
      error: null,
      aborted: 0,
      kind: "task",
      parent_log_id: null,
      matched: 1,
    });

    const first = listLogs(task.id, 2, null);
    expect(first.map((row) => row.id)).toEqual([ids[4]!, ids[3]!]);
    const second = listLogs(task.id, 2, { executedAt: 1003, id: ids[3]! });
    expect(second.map((row) => row.id)).toEqual([ids[2]!, ids[1]!]);
    expect(getLog(ids[4]!)?.response_body).toBe("body-4");
    expect(listLogs(other.id, 10, null)).toHaveLength(1);
  });

  test("orders logs by execution time desc and pages with a time cursor", () => {
    const task = createTask(sampleTask({ name: "log order" }));
    const insert = (executedAt: number): number =>
      insertLog({
        task_id: task.id,
        executed_at: executedAt,
        request_url: "https://example.com",
        request_method: "GET",
        request_headers: "{}",
        request_body: null,
        response_status: 200,
        response_headers: "{}",
        response_body: `at-${executedAt}`,
        duration_ms: 1,
        error: null,
        aborted: 0,
        kind: "task",
        parent_log_id: null,
        matched: 1,
      });

    const newer = insert(2_000);
    // Inserted last but executed earlier: it must sort by time, not by id.
    const older = insert(1_000);
    const middle = insert(1_500);

    expect(listLogs(task.id, 10, null).map((row) => row.id)).toEqual([newer, middle, older]);
    expect(listLogs(task.id, 2, null).map((row) => row.id)).toEqual([newer, middle]);
    expect(listLogs(task.id, 2, { executedAt: 1_500, id: middle }).map((row) => row.id)).toEqual([
      older,
    ]);
  });

  test("stores notify, missed and aborted log rows", () => {
    const task = createTask(sampleTask({ name: "log kinds" }));
    const mainId = insertLog({
      task_id: task.id,
      executed_at: 2_000,
      request_url: "https://example.com",
      request_method: "POST",
      request_headers: "{}",
      request_body: "x",
      response_status: 200,
      response_headers: "{}",
      response_body: "ok",
      duration_ms: 12,
      error: null,
      aborted: 0,
      kind: "task",
      parent_log_id: null,
      matched: 1,
    });
    const notifyId = insertLog({
      task_id: task.id,
      executed_at: 2_001,
      request_url: "https://notify.example",
      request_method: "POST",
      request_headers: null,
      request_body: "done",
      response_status: 204,
      response_headers: null,
      response_body: "",
      duration_ms: 5,
      error: null,
      aborted: 0,
      kind: "notify",
      parent_log_id: mainId,
      matched: null,
    });
    const missedId = insertLog({
      task_id: task.id,
      executed_at: 2_002,
      request_url: "https://example.com",
      request_method: "GET",
      request_headers: null,
      request_body: null,
      response_status: null,
      response_headers: null,
      response_body: null,
      duration_ms: null,
      error: "错过执行窗口",
      aborted: 0,
      kind: "missed",
      parent_log_id: null,
      matched: null,
    });

    const notify = getLog(notifyId)!;
    expect(notify.kind).toBe("notify");
    expect(notify.parent_log_id).toBe(mainId);
    expect(getLog(missedId)?.kind).toBe("missed");
  });

  test("migrates an existing tasks table by adding request option columns", () => {
    const legacyPath = join(tempDir, "legacy.db");
    initDb(legacyPath);
    const existing = createTask(sampleTask({ name: "before migration" }));
    closeDb();

    const raw = new Database(legacyPath);
    raw.exec("ALTER TABLE tasks DROP COLUMN request_options");
    raw.exec("ALTER TABLE tasks DROP COLUMN notify_options");
    raw.close();

    const migrated = initDb(legacyPath);
    const columns = (migrated.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
      (entry) => entry.name,
    );
    expect(columns).toContain("request_options");
    expect(columns).toContain("notify_options");
    expect(columns).toContain("paused_until");
    expect(columns).toContain("paused_from");
    expect(getTask(existing.id)?.request_options).toBe("{}");
    expect(getTask(existing.id)?.notify_options).toBe("{}");
    expect(getTask(existing.id)?.paused_until).toBeNull();

    const task = createTask(sampleTask({ name: "after migration" }));
    expect(task.request_options).toBe("{}");
    expect(task.notify_options).toBe("{}");

    initDb(dbPath);
  });

  test("backfills paused_from deterministically even when updated_at was rewritten", () => {
    const legacyPath = join(tempDir, "legacy-pause.db");
    initDb(legacyPath);
    const live = createTask(sampleTask({ name: "legacy live pause" }));
    const expired = createTask(sampleTask({ name: "legacy expired pause" }));
    closeDb();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const resumeAt = new Date(today.getTime());
    resumeAt.setDate(resumeAt.getDate() + 2);

    const raw = new Database(legacyPath);
    raw.exec("ALTER TABLE tasks DROP COLUMN paused_from");
    // A cron/timer replan after the pause rewrites updated_at; the migration
    // must NOT use it to guess the original start day.
    raw.query(
      "UPDATE tasks SET paused_until = ?, updated_at = ?, next_run_at = ? WHERE id = ?",
    ).run(
      resumeAt.getTime(),
      today.getTime() + 23 * 3600_000,
      resumeAt.getTime() + 60_000, // legacy builds pushed the plan to the resume day
      live.id,
    );
    raw.query("UPDATE tasks SET paused_until = ? WHERE id = ?").run(
      Date.now() - 86_400_000,
      expired.id,
    );
    raw.close();

    initDb(legacyPath);
    const migrated = getTask(live.id)!;
    expect(migrated.paused_until).toBe(resumeAt.getTime());
    expect(migrated.paused_from).toBe(today.getTime());
    expect(migrated.next_run_at).toBeNull();
    expect(getTask(expired.id)?.paused_until).toBeNull();
    expect(getTask(expired.id)?.paused_from).toBeNull();

    initDb(dbPath);
  });
});
