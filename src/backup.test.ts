import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupFileName,
  createBackup,
  deleteBackup,
  listBackups,
  prepareRestore,
  resolveBackupPath,
  saveUploadedBackup,
  swapDatabase,
} from "./backup";
import { closeDb, createTask, getTask, initDb, listTasks } from "./db";
import { DEFAULT_CONFIG } from "./config";

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "jitter-backup-"));
  return join(dir, "app.db");
}

function payload(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    curl_command: `curl https://example.com/${name}`,
    request: {
      url: `https://example.com/${name}`,
      method: "GET",
      headers: {},
      body: null,
      options: {},
    },
    window_start: "10:10",
    window_end: "10:20",
    notify_enabled: false,
    notify_curl_command: null,
    notify_request: null,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
    ...overrides,
  };
}

describe("backup files", () => {
  test("generates collision-free names", () => {
    expect(backupFileName(1794828938930)).toMatch(/^jitter-\d{8}-\d{6}\.db$/);
    expect(backupFileName(1794828938930, 2)).toMatch(/^jitter-\d{8}-\d{6}-2\.db$/);
  });
});

describe("createBackup", () => {
  test("produces a standalone snapshot that contains the data", () => {
    const dbPath = tempDb();
    try {
      initDb(dbPath);
      createTask(payload("first"), "t1");
      const entry = createBackup(dbPath);
      expect(entry.size).toBeGreaterThan(0);
      const backupPath = resolveBackupPath(dbPath, entry.name);
      expect(existsSync(backupPath)).toBe(true);

      // 快照必须是合法的 SQLite 文件，并且能看到备份时刻的数据。
      const bytes = readFileSync(backupPath);
      expect(bytes.subarray(0, 15).toString()).toBe("SQLite format 3");

      closeDb();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      // 把备份直接当数据库打开，验证快照是独立完整的。
      const { Database } = require("bun:sqlite");
      const snapshot = new Database(backupPath, { readonly: true });
      const count = snapshot.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
      snapshot.close();
      expect(count.c).toBe(1);
    } finally {
      closeDb();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("listBackups / deleteBackup", () => {
  test("lists backups newest first and deletes by name", () => {
    const dbPath = tempDb();
    try {
      initDb(dbPath);
      const first = createBackup(dbPath, 1794828938930);
      const second = createBackup(dbPath, 1794828938930 + 1000);
      const list = listBackups(dbPath);
      expect(list.map((entry) => entry.name)).toEqual([second.name, first.name]);

      deleteBackup(dbPath, first.name);
      expect(listBackups(dbPath).map((entry) => entry.name)).toEqual([second.name]);
      expect(() => deleteBackup(dbPath, first.name)).toThrow(/备份不存在/);
    } finally {
      closeDb();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  test("rejects path traversal and bad extensions", () => {
    const dbPath = tempDb();
    try {
      initDb(dbPath);
      expect(() => resolveBackupPath(dbPath, "../app.db")).toThrow(/不合法/);
      expect(() => resolveBackupPath(dbPath, "sub/app.db")).toThrow(/不合法/);
      expect(() => resolveBackupPath(dbPath, "notes.txt")).toThrow(/不合法/);
      expect(() => resolveBackupPath(dbPath, "C:\\evil\\app.db")).toThrow(/不合法/);
    } finally {
      closeDb();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("restore round trip", () => {
  test("restoring an older snapshot brings the old data back", () => {
    const dbPath = tempDb();
    try {
      initDb(dbPath);
      createTask(payload("first"), "t1");
      const snapshot = createBackup(dbPath);

      // 备份之后又加了数据、改了任务。
      createTask(payload("second"), "t2");
      expect(listTasks().map((task) => task.id)).toEqual(["t2", "t1"]);

      const plan = prepareRestore(dbPath, snapshot.name, 1794828938930);
      expect(existsSync(resolveBackupPath(dbPath, plan.safety_name))).toBe(true);

      closeDb();
      swapDatabase(dbPath, plan.backup_path);
      initDb(dbPath);

      const ids = listTasks().map((task) => task.id);
      expect(ids).toEqual(["t1"]);
      expect(getTask("t2")).toBeNull();
      expect(getTask("t1")?.name).toBe("first");
    } finally {
      closeDb();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("saveUploadedBackup", () => {
  test("accepts a real SQLite file and rejects everything else", () => {
    const dbPath = tempDb();
    try {
      initDb(dbPath);
      createTask(payload("first"), "t1");
      const snapshot = createBackup(dbPath);
      const bytes = readFileSync(resolveBackupPath(dbPath, snapshot.name));

      const entry = saveUploadedBackup(dbPath, "from-another-machine.db", bytes);
      expect(entry.name).toBe("uploaded-from-another-machine.db");
      expect(listBackups(dbPath).some((item) => item.name === entry.name)).toBe(true);

      expect(() => saveUploadedBackup(dbPath, "fake.db", new TextEncoder().encode("hello")))
        .toThrow(/SQLite/);
      expect(() => saveUploadedBackup(dbPath, "../evil.db", bytes)).toThrow(/不合法/);
    } finally {
      closeDb();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});
