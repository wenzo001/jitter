import { Database, type Statement } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getActiveConfig } from "./config";
import type { LogRow, LogSummary, NewLogInput, NewTaskInput, TaskRow } from "./types";

/** Key of the UI-overridable retention window in the settings table. */
export const LOG_RETENTION_SETTING = "logRetentionDays";

const RUNTIME_ROOT = /(^|[\\/])~BUN([\\/]|$)/.test(import.meta.dir)
  ? process.cwd()
  : join(import.meta.dir, "..");
const DEFAULT_DB_PATH = join(RUNTIME_ROOT, "data", "app.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  curl_command     TEXT,
  request_url      TEXT NOT NULL,
  request_method   TEXT NOT NULL DEFAULT 'GET',
  request_headers  TEXT,
  request_body     TEXT,
  request_options  TEXT NOT NULL DEFAULT '{}',
  window_start     TEXT NOT NULL,
  window_end       TEXT NOT NULL,
  daily_jitter_minutes INTEGER NOT NULL DEFAULT 0,
  schedule_kind    TEXT NOT NULL DEFAULT 'daily',
  interval_seconds INTEGER,
  interval_jitter_seconds INTEGER NOT NULL DEFAULT 0,
  interval_start_at INTEGER,
  status           TEXT NOT NULL DEFAULT 'active',
  next_run_at      INTEGER,
  paused_from      INTEGER,
  paused_until     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  notify_enabled   INTEGER NOT NULL DEFAULT 0,
  notify_curl_command TEXT,
  notify_url       TEXT,
  notify_method    TEXT,
  notify_headers   TEXT,
  notify_body      TEXT,
  notify_options   TEXT NOT NULL DEFAULT '{}',
  precheck_enabled INTEGER NOT NULL DEFAULT 0,
  precheck_curl_command TEXT,
  precheck_url     TEXT,
  precheck_method  TEXT,
  precheck_headers TEXT,
  precheck_body    TEXT,
  precheck_options TEXT NOT NULL DEFAULT '{}',
  precheck_expect_status INTEGER,
  precheck_expr    TEXT,
  precheck_weekdays TEXT,
  precheck_time_start TEXT,
  precheck_time_end TEXT,
  expect_status    INTEGER,
  expect_body      TEXT,
  expect_expr      TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  executed_at      INTEGER NOT NULL,
  request_url      TEXT,
  request_method   TEXT,
  request_headers  TEXT,
  request_body     TEXT,
  response_status  INTEGER,
  response_headers TEXT,
  response_body    TEXT,
  duration_ms      INTEGER,
  error            TEXT,
  aborted          INTEGER DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'task',
  parent_log_id    INTEGER,
  matched          INTEGER
);

/** Test-bench history: the last few runs per task, newest first. */
CREATE TABLE IF NOT EXISTS test_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  created_at       INTEGER NOT NULL,
  ok               INTEGER NOT NULL,
  summary          TEXT NOT NULL,
  steps            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_task_time ON logs(task_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(executed_at);
CREATE INDEX IF NOT EXISTS idx_test_runs_task ON test_runs(task_id, id DESC);

/**
 * Covering indexes for the two hot read paths.
 *
 * Without them SQLite has to fetch the whole row — including the up-to-100
 * KiB request/response bodies — to reach the trailing small columns, which
 * turns a log list into hundreds of megabytes of I/O.
 *
 *  - idx_logs_summary serves the log list and the per-task metrics.
 *  - idx_logs_metrics serves the "today / last 7 days" aggregates.
 *
 * Both only carry small columns, so they stay a few hundred KiB even for
 * hundreds of thousands of logs.
 */
CREATE INDEX IF NOT EXISTS idx_logs_summary
  ON logs(task_id, executed_at DESC, id DESC, response_status, duration_ms, error, aborted, kind, parent_log_id, matched);
CREATE INDEX IF NOT EXISTS idx_logs_metrics
  ON logs(executed_at, kind, response_status, error, duration_ms);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type AnyStatement = Statement<any, any[]>;

interface Statements {
  insertTask: AnyStatement;
  getTask: AnyStatement;
  listTasks: AnyStatement;
  updateNextRun: AnyStatement;
  updatePause: AnyStatement;
  updateStatus: AnyStatement;
  updateTaskConfig: AnyStatement;
  insertLog: AnyStatement;
  getLog: AnyStatement;
  listLogs: AnyStatement;
  listLogsBefore: AnyStatement;
  listLogSummaries: AnyStatement;
  listLogSummariesBefore: AnyStatement;
  listLogSummariesSince: AnyStatement;
  listLogSummariesBeforeSince: AnyStatement;
  listRecentTaskLogs: AnyStatement;
  countRunsSince: AnyStatement;
}

let database: Database | null = null;
let databasePath: string | null = null;
let statements: Statements | null = null;

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Local midnight, optionally shifted by whole calendar days (DST-safe). */
function localDayStart(timestamp: number, offsetDays: number = 0): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  if (offsetDays !== 0) date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

/**
 * Older builds stored only `paused_until`, which made "start tomorrow" behave
 * as "start right now" (the bug where an afternoon run was skipped).
 *
 * `updated_at` is NOT a usable proxy for "when the pause was configured":
 * every timer replan rewrites it, so a service that kept running can have
 * an `updated_at` days newer than the pause. Inferring the start day from it
 * silently shortens the pause. Use a deterministic rule instead: keep the
 * original resume time and treat the remaining pause as starting at local
 * midnight of the UPGRADE day. Any still-live legacy pause must already span
 * today (otherwise it would have expired), so every future paused day is
 * preserved. The only divergence is a pause configured earlier the same day
 * with "start tomorrow"; the log below asks the user to re-set it once.
 *
 * Also clear `next_run_at`: legacy builds pushed it to the resume day as soon
 * as the pause was created, so the scheduler must re-plan from the new interval.
 */
function backfillPauseFrom(db: Database): void {
  const rows = db
    .query(
      "SELECT id, paused_until FROM tasks WHERE paused_until IS NOT NULL AND paused_from IS NULL",
    )
    .all() as Array<{ id: string; paused_until: number }>;
  if (rows.length === 0) return;

  const now = Date.now();
  const today = localDayStart(now);
  let inferred = 0;
  for (const row of rows) {
    if (row.paused_until <= now) {
      db.query("UPDATE tasks SET paused_from = NULL, paused_until = NULL WHERE id = ?").run(row.id);
      continue;
    }
    db.query("UPDATE tasks SET paused_from = ?, next_run_at = NULL WHERE id = ?").run(
      today,
      row.id,
    );
    inferred += 1;
  }
  console.warn(
    `[jitter] 已迁移 ${rows.length} 条旧版暂停记录（${inferred} 条按「升级当天 00:00 起继续暂停至原恢复时刻」处理）；如有需要请重新设置一次暂停`,
  );
}

/**
 * Databases created before scheduling modes existed have no
 * `schedule_kind`; the column default makes every one of them `daily`, which
 * is exactly the old behaviour (one random run inside the HH:mm window).
 *
 * Cron expressions were removed on purpose (ordinary users cannot read them),
 * so any row still pointing at `cron` — or at an unknown kind — is repaired to
 * a daily window. Those rows have no window columns, so they get a visible
 * 00:00–00:05 placeholder and a console warning: the user only needs to adjust
 * the time on the card instead of silently losing the task.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function backfillScheduleKind(db: Database): void {
  const broken = db
    .query(
      `SELECT id, name, schedule_kind, window_start, window_end
         FROM tasks
        WHERE schedule_kind IS NULL OR schedule_kind NOT IN ('daily', 'interval')`,
    )
    .all() as Array<{
    id: string;
    name: string;
    schedule_kind: string | null;
    window_start: string;
    window_end: string;
  }>;
  if (broken.length === 0) return;

  const keepWindow = db.query(
    `UPDATE tasks
        SET schedule_kind = 'daily', daily_jitter_minutes = 0, interval_seconds = NULL,
            interval_jitter_seconds = 0, interval_start_at = NULL
      WHERE id = ?`,
  );
  // A replaced window invalidates the stored plan: keeping it would make the
  // first post-upgrade run fall outside the new window and be logged as
  // "missed". Clearing it lets startup recovery plan inside the new window.
  const repairWindow = db.query(
    `UPDATE tasks
        SET schedule_kind = 'daily', daily_jitter_minutes = 0, interval_seconds = NULL,
            interval_jitter_seconds = 0, interval_start_at = NULL,
            window_start = ?, window_end = ?,
            next_run_at = NULL
      WHERE id = ?`,
  );
  for (const row of broken) {
    const hasWindow =
      HHMM.test(row.window_start ?? "") &&
      HHMM.test(row.window_end ?? "") &&
      row.window_start !== row.window_end;
    if (hasWindow) {
      keepWindow.run(row.id);
    } else {
      repairWindow.run("00:00", "00:05", row.id);
    }
  }
  const names = broken.map((row) => `「${row.name}」`).join("、");
  console.warn(
    `[jitter] 已把 ${broken.length} 条旧调度（含已移除的 Cron）改为「每天窗口」：${names}；请到页面确认执行时间`,
  );
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db: Database): void {
  ensureColumn(db, "tasks", "request_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "notify_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "paused_until", "INTEGER");
  ensureColumn(db, "tasks", "paused_from", "INTEGER");
  ensureColumn(db, "tasks", "expect_expr", "TEXT");
  // Scheduling modes: old rows fall back to `daily` (their window columns).
  ensureColumn(db, "tasks", "schedule_kind", "TEXT NOT NULL DEFAULT 'daily'");
  ensureColumn(db, "tasks", "daily_jitter_minutes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "interval_seconds", "INTEGER");
  ensureColumn(db, "tasks", "interval_jitter_seconds", "INTEGER NOT NULL DEFAULT 0");
  // Optional first-run anchor for cycling tasks ("start at 09:00, every 2h").
  ensureColumn(db, "tasks", "interval_start_at", "INTEGER");
  // Pre-run guard: a second request that decides whether the main one runs.
  ensureColumn(db, "tasks", "precheck_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "precheck_curl_command", "TEXT");
  ensureColumn(db, "tasks", "precheck_url", "TEXT");
  ensureColumn(db, "tasks", "precheck_method", "TEXT");
  ensureColumn(db, "tasks", "precheck_headers", "TEXT");
  ensureColumn(db, "tasks", "precheck_body", "TEXT");
  ensureColumn(db, "tasks", "precheck_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "precheck_expect_status", "INTEGER");
  ensureColumn(db, "tasks", "precheck_expr", "TEXT");
  // Local part of the guard: allowed weekdays and an optional time range.
  ensureColumn(db, "tasks", "precheck_weekdays", "TEXT");
  ensureColumn(db, "tasks", "precheck_time_start", "TEXT");
  ensureColumn(db, "tasks", "precheck_time_end", "TEXT");
  backfillScheduleKind(db);
  backfillPauseFrom(db);
}

export function resolveDbPath(path?: string): string {
  const candidate = path ?? process.env.JITTER_DB_PATH;
  return candidate?.trim() || DEFAULT_DB_PATH;
}

export function initDb(path?: string): Database {
  const target = resolveDbPath(path);
  if (database && databasePath === target) {
    return database;
  }
  if (database) {
    database.close();
    database = null;
    statements = null;
  }

  if (target !== ":memory:") {
    mkdirSync(dirname(target), { recursive: true });
  }

  const db = new Database(target, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  // Must be set BEFORE the first table is created: a fresh database then
  // reclaims freed pages in small chunks instead of needing a full VACUUM
  // (which would block the single-threaded server for a long time).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec(SCHEMA);
  migrate(db);

  statements = {
    insertTask: db.query(
      `INSERT INTO tasks (
        id, name, curl_command, request_url, request_method, request_headers, request_body, request_options,
        window_start, window_end, daily_jitter_minutes, schedule_kind, interval_seconds, interval_jitter_seconds,
        interval_start_at,
        status, next_run_at, paused_from, paused_until, created_at, updated_at,
        notify_enabled, notify_curl_command, notify_url, notify_method, notify_headers, notify_body, notify_options,
        precheck_enabled, precheck_curl_command, precheck_url, precheck_method, precheck_headers,
        precheck_body, precheck_options, precheck_expect_status, precheck_expr,
        precheck_weekdays, precheck_time_start, precheck_time_end,
        expect_status, expect_body, expect_expr
      ) VALUES (${Array.from({ length: 43 }, () => "?").join(", ")})`,
    ),
    getTask: db.query("SELECT * FROM tasks WHERE id = ?"),
    listTasks: db.query("SELECT * FROM tasks ORDER BY created_at DESC"),
    updateNextRun: db.query("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?"),
    updatePause: db.query(
      "UPDATE tasks SET paused_from = ?, paused_until = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
    ),
    updateStatus: db.query("UPDATE tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?"),
    updateTaskConfig: db.query(
      `UPDATE tasks SET
        name = ?, curl_command = ?, request_url = ?, request_method = ?, request_headers = ?,
        request_body = ?, request_options = ?, window_start = ?, window_end = ?, daily_jitter_minutes = ?,
        schedule_kind = ?, interval_seconds = ?, interval_jitter_seconds = ?,
        interval_start_at = ?,
        notify_enabled = ?, notify_curl_command = ?, notify_url = ?, notify_method = ?,
        notify_headers = ?, notify_body = ?, notify_options = ?,
        precheck_enabled = ?, precheck_curl_command = ?, precheck_url = ?, precheck_method = ?,
        precheck_headers = ?, precheck_body = ?, precheck_options = ?,
        precheck_expect_status = ?, precheck_expr = ?,
        precheck_weekdays = ?, precheck_time_start = ?, precheck_time_end = ?,
        expect_status = ?, expect_body = ?, expect_expr = ?, updated_at = ?
       WHERE id = ?`,
    ),
    insertLog: db.query(
      `INSERT INTO logs (
        task_id, executed_at, request_url, request_method, request_headers, request_body,
        response_status, response_headers, response_body, duration_ms, error, aborted,
        kind, parent_log_id, matched
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getLog: db.query("SELECT * FROM logs WHERE id = ?"),
    listLogs: db.query(
      "SELECT * FROM logs WHERE task_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?",
    ),
    listLogsBefore: db.query(
      `SELECT * FROM logs
       WHERE task_id = ?
         AND (executed_at < ? OR (executed_at = ? AND id < ?))
       ORDER BY executed_at DESC, id DESC
       LIMIT ?`,
    ),
    // The list view deliberately leaves the bodies out: one page of 50 rows
    // with 100 KiB bodies each would move ~10 MB on every poll.
    listLogSummaries: db.query(
      `SELECT id, task_id, executed_at, request_url, request_method,
              response_status, duration_ms, error, aborted, kind,
              parent_log_id, matched
         FROM logs WHERE task_id = ?
        ORDER BY executed_at DESC, id DESC
        LIMIT ?`,
    ),
    listLogSummariesBefore: db.query(
      `SELECT id, task_id, executed_at, request_url, request_method,
              response_status, duration_ms, error, aborted, kind,
              parent_log_id, matched
         FROM logs
        WHERE task_id = ?
          AND (executed_at < ? OR (executed_at = ? AND id < ?))
        ORDER BY executed_at DESC, id DESC
        LIMIT ?`,
    ),
    // The same, but only the rows inside the retention window.
    listLogSummariesSince: db.query(
      `SELECT id, task_id, executed_at, request_url, request_method,
              response_status, duration_ms, error, aborted, kind,
              parent_log_id, matched
         FROM logs
        WHERE task_id = ? AND executed_at >= ?
        ORDER BY executed_at DESC, id DESC
        LIMIT ?`,
    ),
    listLogSummariesBeforeSince: db.query(
      `SELECT id, task_id, executed_at, request_url, request_method,
              response_status, duration_ms, error, aborted, kind,
              parent_log_id, matched
         FROM logs
        WHERE task_id = ?
          AND (executed_at < ? OR (executed_at = ? AND id < ?))
          AND executed_at >= ?
        ORDER BY executed_at DESC, id DESC
        LIMIT ?`,
    ),
    // The newest task runs of one task, for the metrics panel. The
    // (task_id, executed_at DESC) index makes this a bounded index scan.
    listRecentTaskLogs: db.query(
      `SELECT id, task_id, executed_at, request_url, request_method,
              response_status, duration_ms, error, aborted, kind,
              parent_log_id, matched
         FROM logs
        WHERE task_id = ? AND kind = 'task'
        ORDER BY executed_at DESC, id DESC
        LIMIT ?`,
    ),
    countRunsSince: db.query(
      `SELECT COUNT(*) AS runs,
              SUM(CASE WHEN error IS NULL AND response_status IS NOT NULL
                        AND response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
              AVG(duration_ms) AS avg_ms
         FROM logs
        WHERE kind = 'task' AND executed_at >= ?`,
    ),
  };

  database = db;
  databasePath = target;
  return db;
}

/**
 * The live database handle. Exported for tests and maintenance tooling that
 * needs to inspect or repair a row the normal API refuses to touch.
 */
export function getDatabase(): Database {
  if (!database) {
    throw new Error("数据库尚未初始化，请先调用 initDb()");
  }
  return database;
}

function getStatements(): Statements {
  if (!statements) {
    throw new Error("数据库尚未初始化，请先调用 initDb()");
  }
  return statements;
}

function asTask(row: unknown): TaskRow | null {
  return (row as TaskRow | null) ?? null;
}

function asLog(row: unknown): LogRow | null {
  return (row as LogRow | null) ?? null;
}

export function createTask(
  input: NewTaskInput,
  id: string = crypto.randomUUID(),
  now: number = Date.now(),
): TaskRow {
  const notifyEnabled = input.notify_enabled ? 1 : 0;
  const notify = notifyEnabled ? input.notify_request : null;
  // A guard without any condition would silently behave like "no guard", so
  // the flag is stored only when at least one condition exists (local or curl).
  const precheck = input.precheck_enabled ? (input.precheck_request ?? null) : null;
  const localGuard = Boolean(
    (input.precheck_weekdays && input.precheck_weekdays.length > 0) ||
      input.precheck_time_start ||
      input.precheck_time_end,
  );
  const guardEnabled = input.precheck_enabled === true && (precheck !== null || localGuard);
  getStatements().insertTask.run(
    id,
    input.name,
    input.curl_command,
    input.request.url,
    input.request.method,
    JSON.stringify(input.request.headers),
    input.request.body,
    JSON.stringify(input.request.options ?? {}),
    input.window_start,
    input.window_end,
    input.daily_jitter_minutes ?? 0,
    input.schedule_kind ?? "daily",
    input.interval_seconds ?? null,
    input.interval_jitter_seconds ?? 0,
    input.interval_start_at ?? null,
    "active",
    null, // next_run_at
    null, // paused_from
    null, // paused_until
    now,
    now,
    notifyEnabled,
    notifyEnabled ? input.notify_curl_command : null,
    notify?.url ?? null,
    notify?.method ?? null,
    notify ? JSON.stringify(notify.headers) : null,
    notify?.body ?? null,
    notify ? JSON.stringify(notify.options ?? {}) : "{}",
    guardEnabled ? 1 : 0,
    precheck ? (input.precheck_curl_command ?? null) : null,
    precheck?.url ?? null,
    precheck?.method ?? null,
    precheck ? JSON.stringify(precheck.headers) : null,
    precheck?.body ?? null,
    precheck ? JSON.stringify(precheck.options ?? {}) : "{}",
    precheck ? (input.precheck_expect_status ?? null) : null,
    precheck ? (input.precheck_expr ?? null) : null,
    guardEnabled && input.precheck_weekdays?.length
      ? input.precheck_weekdays.join(",")
      : null,
    guardEnabled ? (input.precheck_time_start ?? null) : null,
    guardEnabled ? (input.precheck_time_end ?? null) : null,
    // Success conditions are independent of notifications: they decide the
    // "命中" flag in the log even when no notification is configured.
    input.expect_status ?? null,
    input.expect_body ?? null,
    input.expect_expr ?? null,
  );
  const task = getTask(id);
  if (!task) {
    throw new Error("任务写入后无法读取");
  }
  return task;
}

/**
 * Overwrite a task's editable configuration while deliberately preserving
 * id/status/next_run_at/paused_* /created_at. Scheduling state belongs to the
 * scheduler, which replans after this write; a stopped task stays stopped.
 */
export function updateTaskConfig(
  id: string,
  input: NewTaskInput,
  now: number = Date.now(),
): TaskRow | null {
  const notifyEnabled = input.notify_enabled ? 1 : 0;
  const notify = notifyEnabled ? input.notify_request : null;
  const precheck = input.precheck_enabled ? (input.precheck_request ?? null) : null;
  const localGuard = Boolean(
    (input.precheck_weekdays && input.precheck_weekdays.length > 0) ||
      input.precheck_time_start ||
      input.precheck_time_end,
  );
  const guardEnabled = input.precheck_enabled === true && (precheck !== null || localGuard);
  getStatements().updateTaskConfig.run(
    input.name,
    input.curl_command,
    input.request.url,
    input.request.method,
    JSON.stringify(input.request.headers),
    input.request.body,
    JSON.stringify(input.request.options ?? {}),
    input.window_start,
    input.window_end,
    input.daily_jitter_minutes ?? 0,
    input.schedule_kind ?? "daily",
    input.interval_seconds ?? null,
    input.interval_jitter_seconds ?? 0,
    input.interval_start_at ?? null,
    notifyEnabled,
    notifyEnabled ? input.notify_curl_command : null,
    notify?.url ?? null,
    notify?.method ?? null,
    notify ? JSON.stringify(notify.headers) : null,
    notify?.body ?? null,
    notify ? JSON.stringify(notify.options ?? {}) : "{}",
    guardEnabled ? 1 : 0,
    precheck ? (input.precheck_curl_command ?? null) : null,
    precheck?.url ?? null,
    precheck?.method ?? null,
    precheck ? JSON.stringify(precheck.headers) : null,
    precheck?.body ?? null,
    precheck ? JSON.stringify(precheck.options ?? {}) : "{}",
    precheck ? (input.precheck_expect_status ?? null) : null,
    precheck ? (input.precheck_expr ?? null) : null,
    guardEnabled && input.precheck_weekdays?.length
      ? input.precheck_weekdays.join(",")
      : null,
    guardEnabled ? (input.precheck_time_start ?? null) : null,
    guardEnabled ? (input.precheck_time_end ?? null) : null,
    input.expect_status ?? null,
    input.expect_body ?? null,
    input.expect_expr ?? null,
    now,
    id,
  );
  return getTask(id);
}

export function getTask(id: string): TaskRow | null {
  return asTask(getStatements().getTask.get(id));
}

export function listTasks(): TaskRow[] {
  return getStatements().listTasks.all() as TaskRow[];
}

export interface DeleteTaskOutcome {
  /** Whether the task existed and was removed. */
  deleted: boolean;
  /** Number of log rows removed together with the task. */
  deleted_logs: number;
  /** Number of test-bench history rows removed together with the task. */
  deleted_test_runs: number;
}

/**
 * Delete a task together with EVERY log that belongs to it: normal runs,
 * notify runs and missed-window records all share the same `task_id`.
 *
 * `logs.task_id` has a foreign key onto `tasks` and `PRAGMA foreign_keys = ON`,
 * so logs must be removed before the task row. Both statements run in one
 * transaction: a failure can never leave an orphan task or stray log rows.
 */
export function deleteTask(id: string): DeleteTaskOutcome {
  const db = getDatabase();
  const remove = db.transaction(() => {
    const tests = db.run("DELETE FROM test_runs WHERE task_id = ?", [id]);
    const logs = db.run("DELETE FROM logs WHERE task_id = ?", [id]);
    const task = db.run("DELETE FROM tasks WHERE id = ?", [id]);
    return {
      deleted: Number(task.changes) > 0,
      deleted_logs: Number(logs.changes),
      deleted_test_runs: Number(tests.changes),
    };
  });
  return remove();
}

export function updateTaskNextRun(id: string, nextRunAt: number | null, now: number = Date.now()): void {
  getStatements().updateNextRun.run(nextRunAt, now, id);
}

export interface PauseRecord {
  from: number;
  until: number;
}

/** Persist the pause interval (`null` clears it) together with the next run. */
export function setTaskPause(
  id: string,
  pause: PauseRecord | null,
  nextRunAt: number | null,
  now: number = Date.now(),
): void {
  getStatements().updatePause.run(pause?.from ?? null, pause?.until ?? null, nextRunAt, now, id);
}

export function updateTaskStatus(
  id: string,
  status: TaskRow["status"],
  nextRunAt: number | null,
  now: number = Date.now(),
): void {
  getStatements().updateStatus.run(status, nextRunAt, now, id);
}

export function insertLog(input: NewLogInput): number {
  const result = getStatements().insertLog.run(
    input.task_id,
    input.executed_at,
    input.request_url,
    input.request_method,
    input.request_headers,
    input.request_body,
    input.response_status,
    input.response_headers,
    input.response_body,
    input.duration_ms,
    input.error,
    input.aborted,
    input.kind ?? "task",
    input.parent_log_id ?? null,
    input.matched ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getLog(id: number): LogRow | null {
  return asLog(getStatements().getLog.get(id));
}

/**
 * Keyset cursor for "load older" paging. Rows are ordered by executed_at DESC
 * then id DESC, so the cursor has to carry both parts to stay stable.
 */
export interface LogCursor {
  executedAt: number;
  id: number;
}

export function listLogs(taskId: string, limit: number, before: LogCursor | null = null): LogRow[] {
  const stmts = getStatements();
  const rows =
    before === null
      ? stmts.listLogs.all(taskId, limit)
      : stmts.listLogsBefore.all(
          taskId,
          before.executedAt,
          before.executedAt,
          before.id,
          limit,
        );
  return rows as LogRow[];
}

/**
 * Light rows for the log list. The bodies stay in the database until someone
 * actually opens an entry.
 *
 * `since` bounds the result by time: logs older than the retention window are
 * never queried, so a table with months of history cannot slow the list down.
 */
export function listLogSummaries(
  taskId: string,
  limit: number,
  before: LogCursor | null = null,
  since: number | null = null,
): LogSummary[] {
  const stmts = getStatements();
  const rows =
    before === null
      ? since === null
        ? stmts.listLogSummaries.all(taskId, limit)
        : stmts.listLogSummariesSince.all(taskId, since, limit)
      : since === null
        ? stmts.listLogSummariesBefore.all(
            taskId,
            before.executedAt,
            before.executedAt,
            before.id,
            limit,
          )
        : stmts.listLogSummariesBeforeSince.all(
            taskId,
            before.executedAt,
            before.executedAt,
            before.id,
            since,
            limit,
          );
  return rows as LogSummary[];
}

export function getJournalMode(): string {
  const row = getDatabase().query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
  return row?.journal_mode ?? "unknown";
}

/** 0 = NONE, 1 = FULL, 2 = INCREMENTAL. */
export function getAutoVacuumMode(): number {
  const row = getDatabase().query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | null;
  return row?.auto_vacuum ?? 0;
}

/**
 * Reclaim at most `pages` free pages (4 KiB each). Only meaningful with
 * auto_vacuum=INCREMENTAL, and bounded on purpose: a full VACUUM would block
 * the single-threaded server for minutes on a large database.
 */
export function incrementalVacuum(pages: number): number {
  const db = getDatabase();
  if (getAutoVacuumMode() !== 2) return 0;
  db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.trunc(pages))});`);
  return pages;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention options exposed to the UI, in days. */
export const LOG_CLEANUP_DAYS = [10, 30, 180, 365] as const;

const LOG_CLEANUP_LABELS: Record<number, string> = {
  10: "10 天",
  30: "30 天",
  180: "半年",
  365: "一年",
};

/**
 * Rough on-disk payload estimate per row: text column bytes plus ~64 bytes of
 * row/page overhead. Used only for the pre-cleanup preview, never for billing.
 */
const LOG_BYTES_EXPR = `(
  length(coalesce(request_url, '')) +
  length(coalesce(request_method, '')) +
  length(coalesce(request_headers, '')) +
  length(coalesce(request_body, '')) +
  length(coalesce(response_headers, '')) +
  length(coalesce(response_body, '')) +
  length(coalesce(error, '')) + 64
)`;

export interface LogStorageUsage {
  db_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  total_bytes: number;
}

export interface LogCleanupOption {
  days: number;
  label: string;
  cutoff: number;
  count: number;
  bytes: number;
}

export interface LogCleanupPreview {
  generated_at: number;
  total_count: number;
  total_bytes: number;
  oldest_executed_at: number | null;
  newest_executed_at: number | null;
  storage: LogStorageUsage;
  options: LogCleanupOption[];
  all: { count: number; bytes: number };
}

export interface LogCleanupOutcome {
  deleted: number;
  remaining: number;
  cutoff: number | null;
  storage_before: LogStorageUsage;
  storage_after: LogStorageUsage;
  reclaimed_bytes: number;
  vacuum_error: string | null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Actual sizes of the database and its WAL/SHM sidecar files. */
export function getLogStorageUsage(): LogStorageUsage {
  if (!databasePath || databasePath === ":memory:") {
    return { db_bytes: 0, wal_bytes: 0, shm_bytes: 0, total_bytes: 0 };
  }
  const dbBytes = fileSize(databasePath);
  const walBytes = fileSize(`${databasePath}-wal`);
  const shmBytes = fileSize(`${databasePath}-shm`);
  return {
    db_bytes: dbBytes,
    wal_bytes: walBytes,
    shm_bytes: shmBytes,
    total_bytes: dbBytes + walBytes + shmBytes,
  };
}

interface LogCountRow {
  count: number;
  bytes: number;
  oldest: number | null;
  newest: number | null;
}

function countLogs(where = "", params: (number | string)[] = []): LogCountRow {
  const row = getDatabase()
    .query(
      `SELECT count(*) AS count,
              coalesce(sum(${LOG_BYTES_EXPR}), 0) AS bytes,
              min(executed_at) AS oldest,
              max(executed_at) AS newest
       FROM logs ${where}`,
    )
    .get(...params) as LogCountRow | null;
  return {
    count: Number(row?.count ?? 0),
    bytes: Number(row?.bytes ?? 0),
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
  };
}

/**
 * Read-only preview. Cutoff column is logs.executed_at (epoch ms); a row is
 * removed when executed_at < now - days * 24h. No per-task retention.
 */
export function getLogCleanupPreview(now: number = Date.now()): LogCleanupPreview {
  const totals = countLogs();
  const options = LOG_CLEANUP_DAYS.map((days) => {
    const cutoff = now - days * DAY_MS;
    const row = countLogs("WHERE executed_at < ?", [cutoff]);
    return {
      days,
      label: LOG_CLEANUP_LABELS[days] ?? `${days} 天`,
      cutoff,
      count: row.count,
      bytes: row.bytes,
    };
  });
  return {
    generated_at: now,
    total_count: totals.count,
    total_bytes: totals.bytes,
    oldest_executed_at: totals.oldest,
    newest_executed_at: totals.newest,
    storage: getLogStorageUsage(),
    options,
    all: { count: totals.count, bytes: totals.bytes },
  };
}

/**
 * How many rows one retention pass may delete. The server is single
 * threaded: an unbounded DELETE over a huge log table would freeze every
 * request. The sweep repeats, so a backlog is worked off in batches.
 */
export const PRUNE_BATCH_ROWS = 5000;

/**
 * Retention: delete logs that are older than `retentionDays` and/or keep only
 * the newest `maxRowsPerTask` rows per task. `0` disables that half.
 *
 * Each pass is bounded (see `PRUNE_BATCH_ROWS`): the deletes use the
 * `executed_at` / `(task_id, executed_at DESC)` indexes and never load a body
 * into memory.
 */
export interface LogPruneOutcome {
  deleted: number;
  by_age: number;
  by_count: number;
}

export function pruneLogs(
  now: number,
  retentionDays: number,
  maxRowsPerTask: number,
): LogPruneOutcome {
  const db = getDatabase();
  let byAge = 0;
  let byCount = 0;

  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const cutoff = now - retentionDays * DAY_MS;
    byAge = Number(
      db
        .run(
          `DELETE FROM logs
            WHERE id IN (SELECT id FROM logs
                          WHERE executed_at < ?
                          ORDER BY executed_at
                          LIMIT ?)`,
          [cutoff, PRUNE_BATCH_ROWS],
        )
        .changes,
    );
  }

  if (Number.isFinite(maxRowsPerTask) && maxRowsPerTask > 0) {
    const tasks = db.query("SELECT id FROM tasks").all() as Array<{ id: string }>;
    for (const task of tasks) {
      byCount += Number(
        db
          .run(
            `DELETE FROM logs
              WHERE id IN (
                SELECT id FROM logs
                 WHERE task_id = ?
                   AND id NOT IN (SELECT id FROM logs
                                   WHERE task_id = ?
                                   ORDER BY executed_at DESC, id DESC
                                   LIMIT ?)
                 ORDER BY executed_at
                 LIMIT ?)`,
            [task.id, task.id, Math.trunc(maxRowsPerTask), PRUNE_BATCH_ROWS],
          )
          .changes,
      );
    }
  }

  return { deleted: byAge + byCount, by_age: byAge, by_count: byCount };
}

/**
 * The newest task runs of one task (light fields). Bounded by the caller, so
 * the metrics panel never scans the whole log table.
 */
export function listRecentTaskLogs(taskId: string, limit: number): LogSummary[] {
  return getStatements().listRecentTaskLogs.all(taskId, Math.max(1, Math.trunc(limit))) as LogSummary[];
}

export interface RunTotals {
  runs: number;
  ok: number;
  avg_duration_ms: number | null;
}

/** Task runs since a cutoff: count, successes and average duration. */
export function countRunsSince(cutoff: number): RunTotals {
  const row = getStatements().countRunsSince.get(cutoff) as
    | { runs?: number; ok?: number | null; avg_ms?: number | null }
    | null;
  return {
    runs: Number(row?.runs ?? 0),
    ok: Number(row?.ok ?? 0),
    avg_duration_ms: row?.avg_ms === null || row?.avg_ms === undefined ? null : Number(row.avg_ms),
  };
}

/**
 * The retention window actually in force: the value the user picked in the UI
 * wins over the config file default. `0` means "keep everything".
 */
export function getEffectiveRetentionDays(): number {
  const raw = getSetting(LOG_RETENTION_SETTING);
  if (raw !== null) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650) return parsed;
  }
  return getActiveConfig().logRetentionDays;
}

/**
 * Runtime settings that the user can change from the UI (the config file is
 * the default, this is the override).
 */
export function getSetting(key: string): string | null {
  const row = getDatabase().query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  const db = getDatabase();
  if (value === null) {
    db.run("DELETE FROM settings WHERE key = ?", [key]);
    return;
  }
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/**
 * How many logs exist, and how old the oldest one is. Used by the retention
 * sweep to decide whether a cleanup pass is worth running.
 */
export function getLogAgeRange(): { oldest: number | null; newest: number | null } {
  const row = getDatabase()
    .query("SELECT MIN(executed_at) AS oldest, MAX(executed_at) AS newest FROM logs")
    .get() as { oldest: number | null; newest: number | null } | null;
  return { oldest: row?.oldest ?? null, newest: row?.newest ?? null };
}

/**
 * Delete logs older than the cutoff (or all logs), then VACUUM and truncate
 * the WAL so the file actually shrinks. Runs synchronously in the single Bun
 * thread, so an in-flight task cannot insert a row between DELETE and VACUUM;
 * its log lands afterwards and is not part of this cleanup.
 *
 * The VACUUM also converts the file to auto_vacuum=INCREMENTAL, so every
 * later cleanup can reclaim space in small chunks instead of blocking the
 * whole server for minutes.
 */
export function cleanupLogs(
  input: { days: number; cutoff?: number } | { all: true },
  now: number = Date.now(),
): LogCleanupOutcome {
  const db = getDatabase();
  let cutoff: number | null;
  if ("all" in input) {
    cutoff = null;
  } else if (input.cutoff !== undefined) {
    // The preview's cutoff is authoritative: the count the user confirmed is
    // exactly the count deleted, even if the dialog stayed open for a while.
    if (!Number.isInteger(input.cutoff) || input.cutoff <= 0 || input.cutoff > now) {
      throw new Error("无效的清理截止时间");
    }
    cutoff = input.cutoff;
  } else {
    cutoff = now - input.days * DAY_MS;
  }
  const before = getLogStorageUsage();

  const result =
    cutoff === null
      ? db.run("DELETE FROM logs")
      : db.run("DELETE FROM logs WHERE executed_at < ?", [cutoff]);
  const deleted = Number(result.changes);

  let vacuumError: string | null = null;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    // Switching the file to incremental auto-vacuum happens during the VACUUM
    // below; afterwards the automatic retention sweep reclaims space in
    // bounded chunks and no long lock is needed.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    db.exec("VACUUM;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    vacuumError = error instanceof Error ? error.message : String(error);
  }

  const after = getLogStorageUsage();
  return {
    deleted,
    remaining: countLogs().count,
    cutoff,
    storage_before: before,
    storage_after: after,
    reclaimed_bytes: Math.max(0, before.total_bytes - after.total_bytes),
    vacuum_error: vacuumError,
  };
}

/** How many test-bench runs are kept per task (oldest are pruned on insert). */
export const TEST_RUN_KEEP = 10;

export interface TestRunRow {
  id: number;
  task_id: string;
  created_at: number;
  ok: number;
  summary: string;
  steps: string;
}

export type TestRunSummaryRow = Omit<TestRunRow, "steps">;

export interface NewTestRunInput {
  task_id: string;
  ok: boolean;
  /** JSON of TestBenchSummary. */
  summary: string;
  /** JSON of TestStep[]. */
  steps: string;
  created_at?: number;
}

/**
 * Persist one test-bench run and prune everything past `TEST_RUN_KEEP`.
 * History is per task, so a busy task can never evict another task's runs.
 */
export function insertTestRun(input: NewTestRunInput): number {
  const db = getDatabase();
  const write = db.transaction(() => {
    const result = db.run(
      "INSERT INTO test_runs (task_id, created_at, ok, summary, steps) VALUES (?, ?, ?, ?, ?)",
      [
        input.task_id,
        input.created_at ?? Date.now(),
        input.ok ? 1 : 0,
        input.summary,
        input.steps,
      ],
    );
    const id = Number(result.lastInsertRowid);
    db.run(
      `DELETE FROM test_runs
        WHERE task_id = ?
          AND id NOT IN (
            SELECT id FROM test_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?
          )`,
      [input.task_id, input.task_id, TEST_RUN_KEEP],
    );
    return id;
  });
  return write();
}

export function listTestRuns(taskId: string, limit: number = TEST_RUN_KEEP): TestRunSummaryRow[] {
  return getDatabase()
    .query(
      `SELECT id, task_id, created_at, ok, summary
         FROM test_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(taskId, limit) as TestRunSummaryRow[];
}

export function getTestRun(id: number): TestRunRow | null {
  return (
    (getDatabase().query("SELECT * FROM test_runs WHERE id = ?").get(id) as TestRunRow | null) ??
    null
  );
}

export function closeDb(): void {
  if (database) {
    database.close();
  }
  database = null;
  databasePath = null;
  statements = null;
}
