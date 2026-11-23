import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_VERSION,
  buildAutostartEntry,
  getConfigDir,
  getUserDataDir,
  isCompiledRuntime,
} from "./system";

describe("system", () => {
  test("reports the injected version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("knows whether it runs from source or as a compiled app", () => {
    expect(typeof isCompiledRuntime()).toBe("boolean");
  });

  test("puts the data and config directories under the user's home", () => {
    const data = getUserDataDir();
    const config = getConfigDir();
    expect(data.length).toBeGreaterThan(0);
    expect(config.length).toBeGreaterThan(0);
    // Never inside the system directory: the app runs without admin rights.
    expect(data.startsWith("/usr/")).toBe(false);
    expect(data.startsWith("/etc/")).toBe(false);
  });
});

describe("auto start entry", () => {
  test("writes a Windows startup command", () => {
    const entry = buildAutostartEntry({
      platform: "win32",
      binaryPath: "C:\\Users\\me\\AppData\\Local\\Jitter\\jitter.exe",
      home: "C:\\Users\\me",
      appData: "C:\\Users\\me\\AppData\\Roaming",
    });
    expect(entry.path).toContain("Start Menu");
    expect(entry.path.endsWith(".cmd")).toBe(true);
    expect(entry.content).toContain("jitter.exe");
    expect(entry.content).toContain("--background");
  });

  test("writes a macOS launch agent", () => {
    const entry = buildAutostartEntry({
      platform: "darwin",
      binaryPath: "/Users/me/Applications/Jitter/jitter",
      home: "/Users/me",
    });
    expect(entry.path).toContain("LaunchAgents");
    expect(entry.content).toContain("<key>RunAtLoad</key>");
    expect(entry.content).toContain("/Users/me/Applications/Jitter/jitter");
  });

  test("writes a Linux autostart entry", () => {
    const entry = buildAutostartEntry({
      platform: "linux",
      binaryPath: "/home/me/.local/bin/jitter",
      home: "/home/me",
    });
    expect(entry.path).toContain("autostart");
    expect(entry.content).toContain("[Desktop Entry]");
    expect(entry.content).toContain("/home/me/.local/bin/jitter");
  });
});
