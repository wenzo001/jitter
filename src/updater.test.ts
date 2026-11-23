import { describe, expect, test } from "bun:test";
import { compareVersions, getAssetName } from "./updater";

describe("version comparison", () => {
  test("orders plain versions", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
  });

  test("ignores a leading v and extra parts", () => {
    expect(compareVersions("v1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  test("treats a pre-release as older than the release", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBe(1);
    expect(compareVersions("1.2.3-beta.2", "1.2.3-beta.1")).toBe(1);
  });

  test("treats missing parts as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.3", "1.2.9")).toBe(1);
  });
});

describe("release assets", () => {
  test("names the asset after the running platform", () => {
    const name = getAssetName();
    expect(name).toMatch(/^jitter-(windows|macos|linux)-(x64|arm64)\.zip$/);
  });
});
