import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Everything the "desktop" side of Jitter needs to know about itself:
 * where it runs, where it stores data, whether it starts with the system and
 * which version it is.
 *
 * The app stays a plain HTTP server; the tray icon and the browser are only
 * front-ends for it. That keeps all the logic here (and testable) instead of
 * scattered over a native helper.
 */

declare const __APP_VERSION__: string | undefined;

/** Injected at build time; "0.0.0-dev" when running from source. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.0.0-dev";

export const APP_NAME = "Jitter";

/** The id used for the per-user auto-start entries. */
const AUTOSTART_ID = "jitter";

/**
 * A compiled Bun executable has a virtual `import.meta.dir` that contains
 * "~BUN"; that is the reliable way to tell "installed app" from "source".
 */
export function isCompiledRuntime(): boolean {
  return /(^|[\\/])~BUN([\\/]|$)/.test(import.meta.dir);
}

/** Where the executable lives (null when running from source). */
export function getBinaryPath(): string | null {
  if (!isCompiledRuntime()) return null;
  return process.execPath;
}

/**
 * The per-user data directory:
 *   Windows  %LOCALAPPDATA%\Jitter
 *   macOS    ~/Library/Application Support/Jitter
 *   Linux    ~/.local/share/jitter
 */
export function getUserDataDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const base = local && local.length > 0 ? local : join(homedir(), "AppData", "Local");
    return join(base, APP_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "jitter");
}

/** The directory that holds the config file, the database and the logs. */
export function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const base = appData && appData.length > 0 ? appData : join(homedir(), "AppData", "Roaming");
    return join(base, APP_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "jitter");
}

// ---------------------------------------------------------------------------
// Auto start
// ---------------------------------------------------------------------------

/**
 * Where the auto-start registration lives and what it contains.
 *
 * This is a pure function of its inputs so it can be tested for every
 * platform without touching the real system.
 */
export function buildAutostartEntry(options: {
  platform: string;
  binaryPath: string;
  home: string;
  appData?: string;
  xdgConfigHome?: string;
}): { path: string; content: string } {
  const { platform, binaryPath, home } = options;

  if (platform === "win32") {
    const appData = options.appData && options.appData.length > 0
      ? options.appData
      : join(home, "AppData", "Roaming");
    const path = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.cmd`);
    // The Startup folder runs .cmd files. "start" detaches so no console
    // window stays on screen.
    const content = ["@echo off", `start "" "${binaryPath}" --background`, ""].join("\r\n");
    return { path, content };
  }

  if (platform === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `com.${AUTOSTART_ID}.app.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${AUTOSTART_ID}.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
    return { path, content };
  }

  const xdg = options.xdgConfigHome && options.xdgConfigHome.length > 0
    ? options.xdgConfigHome
    : join(home, ".config");
  const path = join(xdg, "autostart", `${AUTOSTART_ID}.desktop`);
  const content = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Exec="${binaryPath}" --background
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  return { path, content };
}

/** The auto-start entry for the current machine. */
function currentAutostartEntry(): { path: string; content: string } {
  return buildAutostartEntry({
    platform: process.platform,
    binaryPath: getBinaryPath() ?? process.execPath,
    home: homedir(),
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
}

/** The file that registers the app for auto start, per platform. */
export function getAutostartPath(): string {
  return currentAutostartEntry().path;
}

/** Whether the app is currently registered to start with the system. */
export function isAutostartEnabled(): boolean {
  try {
    return existsSync(getAutostartPath());
  } catch {
    return false;
  }
}

/**
 * Register (or unregister) the app for auto start.
 *
 * All three platforms are handled with plain file writes - no shell, no
 * registry API - so it works the same whether the app runs from source or
 * from an installed directory.
 */
export function setAutostart(enabled: boolean): void {
  const target = getAutostartPath();
  if (!enabled) {
    rmSync(target, { force: true });
    return;
  }

  if (!getBinaryPath()) {
    throw new Error("开机自启只对安装后的应用有效（当前从源码运行）");
  }

  const entry = currentAutostartEntry();
  mkdirSync(dirname(entry.path), { recursive: true });
  writeFileSync(entry.path, entry.content, "utf8");
}

// ---------------------------------------------------------------------------
// System information
// ---------------------------------------------------------------------------

export interface SystemInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  /** True when running as a compiled single-file executable. */
  compiled: boolean;
  /** Path of the executable (null in source mode). */
  binary_path: string | null;
  /** Directory the executable lives in (null in source mode). */
  install_dir: string | null;
  /** Directory for the config file and the database. */
  config_dir: string;
  /** Where the database lives. */
  db_path: string;
  /** Whether the app starts with the system. */
  autostart: boolean;
  /** Path of the auto-start registration (for troubleshooting). */
  autostart_path: string;
  /** The URL the browser should open. */
  url: string;
  port: number;
}

/** Collect everything the settings page shows about this installation. */
export function getSystemInfo(options: { port: number; dbPath: string }): SystemInfo {
  const binary = getBinaryPath();
  return {
    name: APP_NAME,
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    compiled: isCompiledRuntime(),
    binary_path: binary,
    install_dir: binary ? dirname(binary) : null,
    config_dir: getConfigDir(),
    db_path: options.dbPath,
    autostart: isAutostartEnabled(),
    autostart_path: getAutostartPath(),
    url: `http://127.0.0.1:${options.port}`,
    port: options.port,
  };
}

/** Read the version from a package.json next to the sources (development). */
export function readDevVersion(): string | null {
  const candidate = join(import.meta.dir, "..", "package.json");
  try {
    if (!existsSync(candidate)) return null;
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

let runtimePort = 0;

/** The port the server actually listens on (known after startup). */
export function setRuntimePort(port: number): void {
  runtimePort = port;
}

export function getRuntimePort(): number {
  return runtimePort;
}

let shutdownHandler: (() => void) | null = null;

/** The process that knows how to stop the server registers itself here. */
export function setShutdownHandler(handler: () => void): void {
  shutdownHandler = handler;
}

/** Ask the host process to stop. Returns false when nothing can stop it. */
export function requestShutdown(): boolean {
  if (!shutdownHandler) return false;
  shutdownHandler();
  return true;
}
