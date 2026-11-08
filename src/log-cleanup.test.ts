import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOG_CLEANUP_DAYS,
  cleanupLogs,
  closeDb,
  createTask,
  getLogStorageUsage,
  getLogCleanupPreview,
  initDb,
  insertLog,
  listLogs,
} from "./db";
import type { NewTaskInput } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const tempDir = mkdtempSync(join(tmpdir(), "jitter-cleanup-"));
const dbPath = join(tempDir, "cleanup.db");

let taskId = "";

beforeAll(() => {
  initDb(dbPath);
  const input: NewTaskInput = {
    name: "cleanup fixture",
    curl_command: "curl https://example.com",
    request: { url: "https://example.com", method: "GET", headers: {}, body: null },
    window_start: "10:00",
    window_end: "10:10",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
  };
  taskId = createTask(input).id;
});

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function addLogs(count: number, executedAt: number): void {
  const body = "x".repeat(4096);
  for (let index = 0; index < count; index += 1) {
    insertLog({
      task_id: taskId,
      executed_at: executedAt,
      request_url: "https://example.com",
      request_method: "GET",
      request_headers: '{"accept":"*/*"}',
      request_body: null,
      response_status: 200,
      response_headers: '{"content-type":"text/plain"}',
      response_body: body,
      duration_ms: 5,
      error: null,
      aborted: 0,
      kind: "task",
      parent_log_id: null,
      matched: 1,
    });
  }
}

describe("log cleanup", () => {
  test("previews per-threshold counts and reports storage usage", () => {
    const now = Date.now();
    addLogs(120, now - 400 * DAY_MS);
    addLogs(10, now - 45 * DAY_MS);
    addLogs(5, now - DAY_MS);

    const preview = getLogCleanupPreview(now);
    expect(preview.options.map((option) => option.days)).toEqual([...LOG_CLEANUP_DAYS]);
    expect(preview.total_count).toBe(135);
    expect(preview.all).toEqual({ count: 135, bytes: preview.total_bytes });

    const byDays = new Map(preview.options.map((option) => [option.days, option]));
    expect(byDays.get(10)?.count).toBe(130);
    expect(byDays.get(30)?.count).toBe(130);
    expect(byDays.get(180)?.count).toBe(120);
    expect(byDays.get(365)?.count).toBe(120);
    expect(byDays.get(10)?.bytes).toBeGreaterThan(0);
    expect(preview.storage.db_bytes).toBeGreaterThan(0);
    expect(preview.storage.total_bytes).toBeGreaterThanOrEqual(preview.storage.db_bytes);
  });

  test("deletes rows older than the cutoff, keeps newer ones, and shrinks the file", () => {
    const before = getLogStorageUsage();
    const outcome = cleanupLogs({ days: 30 });

    expect(outcome.deleted).toBe(130);
    expect(outcome.remaining).toBe(5);
    expect(outcome.vacuum_error).toBeNull();
    expect(outcome.storage_before.total_bytes).toBe(before.total_bytes);
    expect(outcome.storage_after.total_bytes).toBeLessThan(outcome.storage_before.total_bytes);
    expect(outcome.reclaimed_bytes).toBe(
      outcome.storage_before.total_bytes - outcome.storage_after.total_bytes,
    );

    expect(listLogs(taskId, 100, null)).toHaveLength(5);
    expect(getLogCleanupPreview().total_count).toBe(5);
  });

  test("all clears every row", () => {
    const outcome = cleanupLogs({ all: true });
    expect(outcome.deleted).toBe(5);
    expect(outcome.remaining).toBe(0);
    expect(outcome.cutoff).toBeNull();
    expect(getLogStorageUsage().total_bytes).toBeLessThanOrEqual(
      outcome.storage_before.total_bytes,
    );
  });

  test("tier cleanup never touches future-dated rows", () => {
    addLogs(1, Date.now() + 30 * DAY_MS + 60_000);

    const preview = getLogCleanupPreview();
    expect(preview.total_count).toBe(1);
    expect(preview.options.every((option) => option.count === 0)).toBe(true);

    const outcome = cleanupLogs({ days: 365 });
    expect(outcome.deleted).toBe(0);
    expect(outcome.remaining).toBe(1);

    const cleared = cleanupLogs({ all: true });
    expect(cleared.deleted).toBe(1);
    expect(cleared.remaining).toBe(0);
  });
});
