import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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

/** Additive migrations for databases created by earlier versions. */
function migrate(db: Database): void {
  ensureColumn(db, "tasks", "request_options", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "notify_options", "TEXT NOT NULL DEFAULT '{}'");
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
        window_start, window_end, status, next_run_at, created_at, updated_at,
        notify_enabled, notify_curl_command, notify_url, notify_method, notify_headers, notify_body, notify_options,
        expect_status, expect_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getTask: db.query("SELECT * FROM tasks WHERE id = ?"),
    listTasks: db.query("SELECT * FROM tasks ORDER BY created_at DESC"),
    updateNextRun: db.query("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?"),
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
    null,
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

export function closeDb(): void {
  if (database) {
    database.close();
  }
  database = null;
  databasePath = null;
  statements = null;
}
