import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  autoIncrementPort: boolean;
  portMaxAttempts: number;
  dbPath: string;
  logBodyLimitBytes: number;
  logsPageSize: number;
  logsMaxPageSize: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  defaultWindowMinutes: number;
  pollIntervalMs: number;
}

export const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  port: 3000,
  host: "127.0.0.1",
  autoIncrementPort: true,
  portMaxAttempts: 100,
  dbPath: "data/app.db",
  logBodyLimitBytes: 100 * 1024,
  logsPageSize: 50,
  logsMaxPageSize: 200,
  requestTimeoutMs: 0,
  shutdownGraceMs: 150,
  defaultWindowMinutes: 5,
  pollIntervalMs: 4000,
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadConfigOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  projectRoot?: string;
}

export interface LoadedConfig {
  config: AppConfig;
  source: string | null;
}

const CONFIG_KEYS = new Set([
  "port",
  "host",
  "autoIncrementPort",
  "portMaxAttempts",
  "dbPath",
  "logBodyLimitBytes",
  "logsPageSize",
  "logsMaxPageSize",
  "requestTimeoutMs",
  "shutdownGraceMs",
  "defaultWindowMinutes",
  "pollIntervalMs",
]);

function readInteger(
  value: unknown,
  key: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`配置项 "${key}" 必须是整数`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`配置项 "${key}" 必须在 ${min}–${max} 之间`);
  }
  return value;
}

function readBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`配置项 "${key}" 必须是 true 或 false`);
  }
  return value;
}

function readString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`配置项 "${key}" 必须是非空字符串`);
  }
  return value.trim();
}

function parseIntText(value: string, label: string, min: number, max: number): number {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ConfigError(`${label} 必须是整数`);
  }
  return readInteger(Number(trimmed), label, min, max);
}

function validateFileConfig(raw: Record<string, unknown>): Partial<AppConfig> {
  for (const key of Object.keys(raw)) {
    if (key === "$schema") continue;
    if (!CONFIG_KEYS.has(key)) {
      throw new ConfigError(`未知配置项: ${key}`);
    }
  }

  const result: Partial<AppConfig> = {};
  if ("port" in raw) result.port = readInteger(raw.port, "port", 0, 65535);
  if ("host" in raw) result.host = readString(raw.host, "host");
  if ("autoIncrementPort" in raw) {
    result.autoIncrementPort = readBoolean(raw.autoIncrementPort, "autoIncrementPort");
  }
  if ("portMaxAttempts" in raw) {
    result.portMaxAttempts = readInteger(raw.portMaxAttempts, "portMaxAttempts", 1, 1000);
  }
  if ("dbPath" in raw) result.dbPath = readString(raw.dbPath, "dbPath");
  if ("logBodyLimitBytes" in raw) {
    result.logBodyLimitBytes = readInteger(
      raw.logBodyLimitBytes,
      "logBodyLimitBytes",
      1024,
      100 * 1024 * 1024,
    );
  }
  if ("logsPageSize" in raw) {
    result.logsPageSize = readInteger(raw.logsPageSize, "logsPageSize", 1, 1000);
  }
  if ("logsMaxPageSize" in raw) {
    result.logsMaxPageSize = readInteger(raw.logsMaxPageSize, "logsMaxPageSize", 1, 5000);
  }
  if ("requestTimeoutMs" in raw) {
    result.requestTimeoutMs = readInteger(
      raw.requestTimeoutMs,
      "requestTimeoutMs",
      0,
      24 * 60 * 60 * 1000,
    );
  }
  if ("shutdownGraceMs" in raw) {
    result.shutdownGraceMs = readInteger(raw.shutdownGraceMs, "shutdownGraceMs", 0, 60_000);
  }
  if ("defaultWindowMinutes" in raw) {
    result.defaultWindowMinutes = readInteger(
      raw.defaultWindowMinutes,
      "defaultWindowMinutes",
      1,
      24 * 60,
    );
  }
  if ("pollIntervalMs" in raw) {
    result.pollIntervalMs = readInteger(raw.pollIntervalMs, "pollIntervalMs", 500, 60_000);
  }
  return result;
}

function validateMerged(config: AppConfig): void {
  if (config.logsMaxPageSize < config.logsPageSize) {
    throw new ConfigError('配置项 "logsMaxPageSize" 不能小于 "logsPageSize"');
  }
}

function isCompiledRuntime(): boolean {
  return /(^|[\\/])~BUN([\\/]|$)/.test(import.meta.dir);
}

function defaultProjectRoot(): string {
  return isCompiledRuntime() ? process.cwd() : join(import.meta.dir, "..");
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? defaultProjectRoot();

  const explicitPath = (options.path ?? env.JITTER_CONFIG ?? "").trim();
  let configPath: string;
  const explicit = explicitPath.length > 0;
  if (explicit) {
    configPath = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
  } else {
    const candidates = [join(projectRoot, "jitter.config.json")];
    if (options.projectRoot === undefined) {
      // Compiled executables have a virtual import.meta.dir; look next to the
      // launch directory and the executable as well.
      candidates.push(join(cwd, "jitter.config.json"));
      candidates.push(join(dirname(process.execPath), "jitter.config.json"));
    }
    configPath =
      candidates.find((candidate) => existsSync(candidate)) ??
      join(projectRoot, "jitter.config.json");
  }

  let fileConfig: Partial<AppConfig> = {};
  let source: string | null = null;

  if (existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`配置文件不是合法 JSON: ${configPath}\n${message}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`配置文件根节点必须是 JSON 对象: ${configPath}`);
    }
    fileConfig = validateFileConfig(raw as Record<string, unknown>);
    source = configPath;
  } else if (explicit) {
    throw new ConfigError(`配置文件不存在: ${configPath}`);
  }

  const config: AppConfig = { ...DEFAULT_CONFIG, ...fileConfig };

  // Relative paths from the file are resolved against the config file's directory.
  const configDir = source ? dirname(source) : projectRoot;
  config.dbPath =
    config.dbPath === ":memory:"
      ? ":memory:"
      : isAbsolute(config.dbPath)
        ? config.dbPath
        : resolve(configDir, config.dbPath);

  if (env.PORT !== undefined && env.PORT.trim() !== "") {
    config.port = parseIntText(env.PORT, "环境变量 PORT", 0, 65535);
  }
  if (env.HOST !== undefined && env.HOST.trim() !== "") {
    config.host = env.HOST.trim();
  }
  if (env.JITTER_DB_PATH !== undefined && env.JITTER_DB_PATH.trim() !== "") {
    const value = env.JITTER_DB_PATH.trim();
    config.dbPath =
      value === ":memory:"
        ? ":memory:"
        : isAbsolute(value)
          ? value
          : resolve(cwd, value);
  }

  validateMerged(config);
  return { config, source };
}

let activeConfig: Readonly<AppConfig> = { ...DEFAULT_CONFIG };

export function getActiveConfig(): Readonly<AppConfig> {
  return activeConfig;
}

export function setActiveConfig(config: AppConfig): void {
  activeConfig = Object.freeze({ ...config });
}
