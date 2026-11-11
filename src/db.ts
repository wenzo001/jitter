import { Database, type Statement } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogRow, NewLogInput, NewTaskInput, TaskRow } from "./types";

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
  expect_status    INTEGER,
  expect_body      TEXT
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

CREATE INDEX IF NOT EXISTS idx_logs_task_time ON logs(task_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id, id DESC);
`;

type AnyStatement = Statement<any, any[]>;

interface Statements {
  insertTask: AnyStatement;
  getTask: AnyStatement;
  listTasks: AnyStatement;
  updateNextRun: AnyStatement;
  updatePause: AnyStatement;
  updateStatus: AnyStatement;
  insertLog: AnyStatement;
  getLog: AnyStatement;
  listLogs: AnyStatement;
  listLogsBefore: AnyStatement;
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
 * every cron/timer replan rewrites it, so a service that kept running can have
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

/** Additive migrations for databases created by earlier versions. */
function migrate(db: Database): void {
  ensureColumn(db, "tasks", "request_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "notify_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "paused_until", "INTEGER");
  ensureColumn(db, "tasks", "paused_from", "INTEGER");
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
  db.exec(SCHEMA);
  migrate(db);

  statements = {
    insertTask: db.query(
      `INSERT INTO tasks (
        id, name, curl_command, request_url, request_method, request_headers, request_body, request_options,
        window_start, window_end, status, next_run_at, paused_from, paused_until, created_at, updated_at,
        notify_enabled, notify_curl_command, notify_url, notify_method, notify_headers, notify_body, notify_options,
        expect_status, expect_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getTask: db.query("SELECT * FROM tasks WHERE id = ?"),
    listTasks: db.query("SELECT * FROM tasks ORDER BY created_at DESC"),
    updateNextRun: db.query("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?"),
    updatePause: db.query(
      "UPDATE tasks SET paused_from = ?, paused_until = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
    ),
    updateStatus: db.query("UPDATE tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?"),
    insertLog: db.query(
      `INSERT INTO logs (
        task_id, executed_at, request_url, request_method, request_headers, request_body,
        response_status, response_headers, response_body, duration_ms, error, aborted,
        kind, parent_log_id, matched
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getLog: db.query("SELECT * FROM logs WHERE id = ?"),
    listLogs: db.query("SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT ?"),
    listLogsBefore: db.query(
      "SELECT * FROM logs WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
    ),
  };

  database = db;
  databasePath = target;
  return db;
}

function getDatabase(): Database {
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
    notifyEnabled ? input.expect_status : null,
    notifyEnabled ? input.expect_body : null,
  );
  const task = getTask(id);
  if (!task) {
    throw new Error("任务写入后无法读取");
  }
  return task;
}

export function getTask(id: string): TaskRow | null {
  return asTask(getStatements().getTask.get(id));
}

export function listTasks(): TaskRow[] {
  return getStatements().listTasks.all() as TaskRow[];
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

export function listLogs(taskId: string, limit: number, before: number | null = null): LogRow[] {
  const stmts = getStatements();
  const rows =
    before === null
      ? stmts.listLogs.all(taskId, limit)
      : stmts.listLogsBefore.all(taskId, before, limit);
  return rows as LogRow[];
}

export function getJournalMode(): string {
  const row = getDatabase().query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
  return row?.journal_mode ?? "unknown";
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
 * Delete logs older than the cutoff (or all logs), then VACUUM and truncate
 * the WAL so the file actually shrinks. Runs synchronously in the single Bun
 * thread, so an in-flight task cannot insert a row between DELETE and VACUUM;
 * its log lands afterwards and is not part of this cleanup.
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

export function closeDb(): void {
  if (database) {
    database.close();
  }
  database = null;
  databasePath = null;
  statements = null;
}
