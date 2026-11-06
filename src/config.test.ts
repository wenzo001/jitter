import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_CONFIG, loadConfig } from "./config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jitter-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("loadConfig", () => {
  test("uses defaults when the default config file is absent", () => {
    const loaded = loadConfig({ env: {}, cwd: dir, projectRoot: dir });
    expect(loaded.source).toBeNull();
    expect(loaded.config.port).toBe(DEFAULT_CONFIG.port);
    expect(loaded.config.host).toBe(DEFAULT_CONFIG.host);
    expect(loaded.config.autoIncrementPort).toBe(true);
    expect(loaded.config.logsPageSize).toBe(DEFAULT_CONFIG.logsPageSize);
    expect(loaded.config.dbPath).toBe(join(dir, "data", "app.db"));
  });

  test("loads partial config and resolves dbPath against the config directory", () => {
    const path = writeConfig("custom.json", {
      port: 4123,
      autoIncrementPort: false,
      logsPageSize: 10,
      logsMaxPageSize: 20,
      dbPath: "db/app.db",
    });
    const loaded = loadConfig({ path, env: {}, cwd: dir, projectRoot: dir });
    expect(loaded.source).toBe(path);
    expect(loaded.config.port).toBe(4123);
    expect(loaded.config.autoIncrementPort).toBe(false);
    expect(loaded.config.logsPageSize).toBe(10);
    expect(loaded.config.logsMaxPageSize).toBe(20);
    expect(loaded.config.dbPath).toBe(join(dir, "db", "app.db"));
    expect(loaded.config.host).toBe(DEFAULT_CONFIG.host);
  });

  test("env overrides config values", () => {
    const path = writeConfig("custom.json", {
      port: 4123,
      host: "127.0.0.1",
      dbPath: "db/app.db",
    });
    const cwd = join(dir, "run");
    mkdirSync(cwd, { recursive: true });
    const loaded = loadConfig({
      path,
      env: { PORT: "4200", HOST: "0.0.0.0", JITTER_DB_PATH: "env/app.db" },
      cwd,
      projectRoot: dir,
    });
    expect(loaded.config.port).toBe(4200);
    expect(loaded.config.host).toBe("0.0.0.0");
    expect(loaded.config.dbPath).toBe(join(cwd, "env", "app.db"));
  });

  test("supports JITTER_CONFIG as the file path", () => {
    const path = writeConfig("env.json", { port: 4300 });
    const loaded = loadConfig({ env: { JITTER_CONFIG: path }, cwd: dir, projectRoot: dir });
    expect(loaded.source).toBe(path);
    expect(loaded.config.port).toBe(4300);
  });

  test("blank env values fall back to defaults", () => {
    const loaded = loadConfig({
      env: { PORT: "  ", HOST: " ", JITTER_DB_PATH: "  " },
      cwd: dir,
      projectRoot: dir,
    });
    expect(loaded.config.port).toBe(DEFAULT_CONFIG.port);
    expect(loaded.config.host).toBe(DEFAULT_CONFIG.host);
    expect(loaded.config.dbPath).toBe(join(dir, "data", "app.db"));
  });

  test("accepts $schema as metadata but rejects unknown keys", () => {
    const ok = writeConfig("schema.json", {
      $schema: "https://example.com/jitter.schema.json",
      port: 4400,
    });
    expect(loadConfig({ path: ok, env: {}, cwd: dir, projectRoot: dir }).config.port).toBe(4400);

    const bad = writeConfig("unknown.json", { port: 4400, bogus: true });
    expect(() => loadConfig({ path: bad, env: {}, cwd: dir, projectRoot: dir })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ path: bad, env: {}, cwd: dir, projectRoot: dir })).toThrow(
      /未知配置项/,
    );
  });

  test("rejects wrong types and out-of-range values", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["port-type", { port: "3000" }, /port/],
      ["port-range", { port: 70000 }, /port/],
      ["bool-type", { autoIncrementPort: "yes" }, /autoIncrementPort/],
      ["host-empty", { host: "" }, /host/],
      ["db-empty", { dbPath: "" }, /dbPath/],
      ["page-max", { logsPageSize: 100, logsMaxPageSize: 50 }, /logsMaxPageSize/],
      ["timeout", { requestTimeoutMs: -1 }, /requestTimeoutMs/],
      ["window-default", { defaultWindowMinutes: 0 }, /defaultWindowMinutes/],
    ];
    for (const [name, value, pattern] of cases) {
      const path = writeConfig(`${name}.json`, value);
      expect(() => loadConfig({ path, env: {}, cwd: dir, projectRoot: dir })).toThrow(pattern);
    }
  });

  test("rejects invalid env port", () => {
    expect(() =>
      loadConfig({ env: { PORT: "not-a-number" }, cwd: dir, projectRoot: dir }),
    ).toThrow(/PORT/);
  });

  test("preserves the :memory: database path", () => {
    expect(
      loadConfig({ projectRoot: dir, env: { JITTER_DB_PATH: ":memory:" }, cwd: dir }).config
        .dbPath,
    ).toBe(":memory:");

    const path = writeConfig("memory.json", { dbPath: ":memory:" });
    expect(loadConfig({ path, env: {}, cwd: dir, projectRoot: dir }).config.dbPath).toBe(
      ":memory:",
    );
  });

  test("strips a UTF-8 BOM from the config file", () => {
    const path = join(dir, "bom.json");
    writeFileSync(path, "\uFEFF" + JSON.stringify({ port: 4500 }));
    expect(loadConfig({ path, env: {}, cwd: dir, projectRoot: dir }).config.port).toBe(4500);
  });

  test("rejects an explicitly missing config and invalid JSON", () => {
    expect(() =>
      loadConfig({ path: join(dir, "missing.json"), env: {}, cwd: dir, projectRoot: dir }),
    ).toThrow(/不存在/);

    const bad = join(dir, "invalid.json");
    writeFileSync(bad, "{");
    expect(() => loadConfig({ path: bad, env: {}, cwd: dir, projectRoot: dir })).toThrow(/JSON/);
  });

  test("the shipped jitter.config.json is valid", () => {
    const projectRoot = join(import.meta.dir, "..");
    const path = join(projectRoot, "jitter.config.json");
    const loaded = loadConfig({ path, env: {}, cwd: projectRoot, projectRoot });
    expect(loaded.source).toBe(path);
    expect(loaded.config.port).toBeGreaterThanOrEqual(0);
    expect(loaded.config.port).toBeLessThanOrEqual(65535);
    expect(typeof loaded.config.autoIncrementPort).toBe("boolean");
    expect(loaded.config.logsPageSize).toBeGreaterThan(0);
    expect(loaded.config.logsMaxPageSize).toBeGreaterThanOrEqual(loaded.config.logsPageSize);
    expect(loaded.config.dbPath).toMatch(/app\.db$/);
  });
});
