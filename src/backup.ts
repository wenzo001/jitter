/**
 * 数据库备份 / 导出 / 导入。
 *
 * 备份用 SQLite 的 `VACUUM INTO`：它在活库上做一份**完整且独立**的快照
 * （正确合并 WAL，不需要停服务），产物是标准的 SQLite 文件，
 * 可以直接当数据库打开，也可以恢复回主库。
 *
 * 备份文件放在数据库同目录的 `backups/` 下，随部署一起走。
 * 恢复前会自动再做一份当前状态的安全备份，当前数据永远不会被悄悄丢弃。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getDatabase } from "./db";

export interface BackupEntry {
  name: string;
  size: number;
  modified_at: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/;

export class BackupError extends Error {}

function fail(message: string): never {
  throw new BackupError(message);
}

function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export function getBackupDir(dbPath: string): string {
  return backupDirFor(dbPath);
}

function timestamp(now: number): string {
  const date = new Date(now);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * The filename for a new backup. Collisions get a numeric suffix, because
 * `VACUUM INTO` refuses to overwrite an existing file.
 */
export function backupFileName(now: number, attempt = 0): string {
  const suffix = attempt === 0 ? "" : `-${attempt}`;
  return `jitter-${timestamp(now)}${suffix}.db`;
}

function validateName(name: string, dbPath: string): string {
  if (!NAME_PATTERN.test(name)) fail(`备份文件名不合法: ${name}`);
  if (isAbsolute(name) || name.includes("..")) fail(`备份文件名不合法: ${name}`);
  const dir = resolve(backupDirFor(dbPath));
  const target = resolve(dir, name);
  // 双保险：解析后必须仍然在备份目录里（防路径穿越）。
  if (dirname(target) !== dir) fail(`备份文件名不合法: ${name}`);
  return target;
}

/** 做一份完整快照（活库上安全，正确合并 WAL）。 */
export function createBackup(dbPath: string, now: number = Date.now()): BackupEntry {
  const dir = backupDirFor(dbPath);
  mkdirSync(dir, { recursive: true });
  const db = getDatabase();
  // 快照时强制把 WAL 合并进主文件，确保 VACUUM INTO 拿到的是最新状态。
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  let target: string | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(dir, backupFileName(now, attempt));
    if (!existsSync(candidate)) {
      target = candidate;
      break;
    }
  }
  if (!target) fail("备份文件名冲突，无法创建备份");
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    try {
      unlinkSync(target);
    } catch {
      // 忽略清理失败
    }
    throw error;
  }
  const stats = statSync(target);
  return { name: basename(target), size: stats.size, modified_at: stats.mtimeMs };
}

/** 列出全部备份（按时间倒序）。 */
export function listBackups(dbPath: string): BackupEntry[] {
  const dir = backupDirFor(dbPath);
  if (!existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!NAME_PATTERN.test(name)) continue;
    const target = join(dir, name);
    try {
      const stats = statSync(target);
      if (!stats.isFile()) continue;
      entries.push({ name, size: stats.size, modified_at: stats.mtimeMs });
    } catch {
      // 文件可能刚好被删了
    }
  }
  entries.sort((a, b) => b.modified_at - a.modified_at);
  return entries;
}

/** 校验文件名并返回备份文件的绝对路径。 */
export function resolveBackupPath(dbPath: string, name: string): string {
  return validateName(name, dbPath);
}

/** 备份文件是否存在。 */
export function backupExists(dbPath: string, name: string): boolean {
  const target = validateName(name, dbPath);
  return existsSync(target);
}

/** 删除一份备份。 */
export function deleteBackup(dbPath: string, name: string): void {
  const target = validateName(name, dbPath);
  if (!existsSync(target)) fail(`备份不存在: ${name}`);
  unlinkSync(target);
}

/** 把上传的字节保存为一份备份。 */
export function saveUploadedBackup(dbPath: string, name: string, bytes: Uint8Array): BackupEntry {
  if (!NAME_PATTERN.test(name)) fail(`备份文件名不合法: ${name}`);
  // 上传的文件名固定加前缀，避免覆盖自动命名的备份。
  const safeName = name.startsWith("uploaded-") ? name : `uploaded-${name}`;
  if (!NAME_PATTERN.test(safeName)) fail(`备份文件名不合法: ${safeName}`);
  const dir = backupDirFor(dbPath);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, safeName);
  if (existsSync(target)) fail(`同名备份已存在: ${safeName}`);
  // 合法性预检：SQLite 文件以 "SQLite format 3\0" 开头。
  const header = bytes.slice(0, 16);
  const expected = "SQLite format 3\0";
  const headerText = new TextDecoder().decode(header.slice(0, 15));
  if (headerText !== expected.slice(0, 15)) fail("文件不是 SQLite 数据库备份");
  const buffer = new Uint8Array(bytes.length);
  buffer.set(bytes);
  writeFileSync(target, buffer);
  const stats = statSync(target);
  return { name: safeName, size: stats.size, modified_at: stats.mtimeMs };
}

/**
 * 恢复的三个步骤拆开给调用方（index.ts 拥有数据库生命周期）：
 *
 *  1. `prepareRestore` —— 校验备份存在，返回当前库的安全备份名与备份路径。
 *  2. `swapDatabase`    —— 停调度、关库之后调用：用备份文件替换主库文件。
 *  3. 恢复方重新 initDb 并重启调度器。
 */
export interface RestorePlan {
  backup_path: string;
  safety_name: string;
}

export function prepareRestore(dbPath: string, name: string, now: number = Date.now()): RestorePlan {
  const backupPath = validateName(name, dbPath);
  if (!existsSync(backupPath)) fail(`备份不存在: ${name}`);
  const safety = createBackup(dbPath, now);
  return { backup_path: backupPath, safety_name: safety.name };
}

/** 用备份文件替换主库文件（调用前必须已经关闭数据库）。 */
export function swapDatabase(dbPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) fail(`备份不存在: ${basename(backupPath)}`);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(backupPath, dbPath);
}
