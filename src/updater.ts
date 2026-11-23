import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { withProxyFallback } from "./proxy";
import { APP_VERSION, getBinaryPath, isCompiledRuntime } from "./system";

/**
 * Self update from the GitHub releases.
 *
 * The flow is deliberately simple: the page asks whether a newer release
 * exists, shows its notes, and on confirmation downloads the asset for this
 * platform, swaps the binary and restarts.
 */

const REPO = process.env.JITTER_UPDATE_REPO ?? "wenzo001/jitter";
const API_BASE = `https://api.github.com/repos/${REPO}`;

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  notes: string | null;
  url: string | null;
  published_at: string | null;
  asset: UpdateAsset | null;
  error: string | null;
}

/** The asset name that matches this platform, e.g. jitter-windows-x64.zip. */
export function getAssetName(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `jitter-${platform}-${arch}.zip`;
}

/**
 * Compare two versions ("1.2.3" / "v1.2.3"); -1, 0 or 1.
 *
 * Follows semver for the pre-release part: 1.2.3-beta is older than 1.2.3.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const cleaned = value.trim().replace(/^v/i, "");
    const dash = cleaned.indexOf("-");
    const core = dash >= 0 ? cleaned.slice(0, dash) : cleaned;
    const prerelease = dash >= 0 ? cleaned.slice(dash + 1) : "";
    const parts = core
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
    return { parts, prerelease };
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A release is newer than any pre-release of the same version.
  if (left.prerelease === "") return 1;
  if (right.prerelease === "") return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  published_at: string | null;
  assets: GitHubAsset[];
}

/** Ask GitHub for the newest release and compare it with the running one. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = APP_VERSION;
  const base: UpdateInfo = {
    current,
    latest: null,
    available: false,
    notes: null,
    url: null,
    published_at: null,
    asset: null,
    error: null,
  };

  try {
    const release = await withProxyFallback(async () => {
      const response = await fetch(`${API_BASE}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Jitter",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if (response.status === 404) {
          // The repository has no releases yet - that is not an error.
          return null;
        }
        throw new Error(`GitHub 返回 ${response.status}`);
      }
      return (await response.json()) as GitHubRelease;
    });
    if (!release) {
      return { ...base, error: null };
    }
    const wanted = getAssetName();
    const asset = release.assets.find((entry) => entry.name === wanted) ?? null;
    const available = compareVersions(release.tag_name, current) > 0 && asset !== null;
    return {
      current,
      latest: release.tag_name,
      available,
      notes: release.body,
      url: release.html_url,
      published_at: release.published_at,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      error: asset === null ? `该版本没有提供 ${wanted}（当前平台 ${process.platform}/${process.arch}）` : null,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface UpdateProgress {
  phase: "idle" | "downloading" | "extracting" | "installing" | "done" | "error";
  percent: number;
  message: string;
  error: string | null;
}

let progress: UpdateProgress = { phase: "idle", percent: 0, message: "", error: null };

export function getUpdateProgress(): UpdateProgress {
  return progress;
}

function setProgress(next: Partial<UpdateProgress>): void {
  progress = { ...progress, ...next };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Download the asset into a temporary directory and return the new binary. */
async function downloadAndExtract(asset: UpdateAsset): Promise<string> {
  const workDir = join(tmpdir(), `jitter-update-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const zipPath = join(workDir, asset.name);

  setProgress({ phase: "downloading", percent: 0, message: "正在下载新版本…" });
  const response = await withProxyFallback(() =>
    fetch(asset.url, {
      headers: { "User-Agent": "Jitter" },
      signal: AbortSignal.timeout(10 * 60_000),
    }),
  );
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("下载失败：没有响应内容");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        setProgress({
          percent: Math.min(99, Math.round((received / total) * 100)),
          message: `正在下载新版本… ${Math.round((received / total) * 100)}%`,
        });
      }
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  writeFileSync(zipPath, bytes);

  setProgress({ phase: "extracting", percent: 99, message: "正在解压…" });
  const files = unzipSync(bytes);
  const wanted = process.platform === "win32" ? "jitter.exe" : "jitter";
  const entry = Object.entries(files).find(([name]) => name.endsWith(wanted));
  if (!entry) {
    throw new Error(`压缩包里没有找到 ${wanted}`);
  }
  const target = join(workDir, wanted);
  writeFileSync(target, entry[1]);
  return target;
}

/** Replace the running binary and start the new one. */
async function install(newBinary: string): Promise<void> {
  const current = getBinaryPath();
  if (!current) {
    throw new Error("当前不是安装版本，无法自动升级");
  }
  const target = current;
  const dir = dirname(target);

  setProgress({ phase: "installing", percent: 100, message: "正在替换程序文件…" });

  if (process.platform === "win32") {
    // A running executable cannot be overwritten: a small helper waits for
    // this process to disappear, swaps the file and starts the new one.
    const helper = join(dir, "jitter-update.cmd");
    writeFileSync(
      helper,
      [
        "@echo off",
        "ping -n 4 127.0.0.1 >nul",
        `move /Y "${newBinary}" "${target}" >nul`,
        `start "" "${target}"`,
        "del \"%~f0\" >nul 2>&1",
        "",
      ].join("\r\n"),
      "utf8",
    );
    spawnDetached(["cmd", "/c", helper]);
    return;
  }

  // macOS / Linux: swap the file in place and start the new binary.
  const backup = `${target}.old`;
  rmSync(backup, { force: true });
  renameSync(target, backup);
  writeFileSync(target, new Uint8Array(await Bun.file(newBinary).arrayBuffer()));
  chmodSync(target, 0o755);

  if (process.platform === "darwin") {
    // A downloaded binary carries the quarantine flag and an invalid
    // signature; clear both or macOS refuses to run it.
    await runQuietly(["xattr", "-d", "com.apple.quarantine", target]);
    await runQuietly(["xattr", "-c", target]);
    await runQuietly(["codesign", "--force", "--sign", "-", target]);
  }

  spawnDetached([target]);
}

/** Start a process that outlives this one. */
function spawnDetached(command: string[]): void {
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // Nothing else to do: the user can start the app manually.
  }
}

async function runQuietly(command: string[]): Promise<void> {
  try {
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    await proc.exited;
  } catch {
    // Best effort: not every system has these tools.
  }
}

/**
 * Download and install the newest release, then let the caller restart the
 * process.
 */
export async function applyUpdate(info: UpdateInfo): Promise<{ ok: boolean; message: string }> {
  if (!isCompiledRuntime()) {
    return { ok: false, message: "当前不是安装版本，无法自动升级（请从 Release 下载后手动替换）" };
  }
  if (!info.asset) {
    return { ok: false, message: info.error ?? "没有可用的更新包" };
  }
  if (!info.available) {
    return { ok: false, message: "当前已经是最新版本" };
  }

  try {
    const newBinary = await downloadAndExtract(info.asset);
    await install(newBinary);
    setProgress({ phase: "done", percent: 100, message: "升级完成，正在重启…" });
    return { ok: true, message: "升级完成，正在重启…" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setProgress({ phase: "error", percent: 0, message: "", error: message });
    return { ok: false, message };
  }
}

/** Used by the tests: the directory a downloaded update would live in. */
export function getUpdateWorkDir(): string {
  return join(tmpdir(), "jitter-update");
}

/** Only used to keep the import list honest in tests. */
export function listUpdateDir(): string[] {
  const dir = getUpdateWorkDir();
  return existsSync(dir) ? readdirSync(dir) : [];
}
