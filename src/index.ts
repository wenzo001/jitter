import { join } from "node:path";
import { app } from "./api";
import { getActiveConfig, loadConfig, setActiveConfig, type AppConfig } from "./config";
import { closeDb, getAutoVacuumMode, initDb } from "./db";
import { listenWithPortRetry, isLocalBindHost } from "./port";
import { startScheduler, stopAll } from "./scheduler";
import { setRuntimePort, setShutdownHandler } from "./system";
import { swapDatabase } from "./backup";
import { setRestoreHandler as registerRestoreHandler } from "./restore";

export interface ServerOptions {
  port?: number;
  hostname?: string;
  configPath?: string;
}

/** Vue 前端构建产物目录（`web/dist`）；缺失时返回 503 而不是静默 404。 */
const DIST_DIR = join(import.meta.dir, "..", "web", "dist");

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  if (relative.includes("..")) return new Response("Not Found", { status: 404 });
  const file = Bun.file(join(DIST_DIR, relative));
  if (!(await file.exists())) {
    return new Response("前端尚未构建：请先在 web/ 目录运行 `bun run build`", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(file, {
    headers: {
      "Cache-Control": relative.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

export function startServer(options: ServerOptions = {}): ReturnType<typeof Bun.serve> {
  const loaded = loadConfig(
    options.configPath === undefined ? {} : { path: options.configPath },
  );
  const config: AppConfig = {
    ...loaded.config,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.hostname !== undefined ? { host: options.hostname } : {}),
  };
  setActiveConfig(config);

  if (!isLocalBindHost(config.host)) {
    throw new Error(
      `host "${config.host}" 不是本机地址，无法监听（请使用 127.0.0.1、0.0.0.0 或本机 IP）`,
    );
  }

  initDb(config.dbPath);
  const summary = startScheduler();

  const result = (() => {
    try {
      return listenWithPortRetry({
        port: config.port,
        autoIncrement: config.autoIncrementPort,
        maxAttempts: config.portMaxAttempts,
        listen: (port) =>
          Bun.serve({
            hostname: config.host,
            port,
            fetch: async (request) => {
              const { pathname } = new URL(request.url);
              if (pathname === "/" || pathname.startsWith("/assets/")) {
                return serveStatic(pathname);
              }
              return app.fetch(request);
            },
            error(error) {
              console.error("[jitter] Bun.serve 错误", error);
              return new Response("Internal Server Error", { status: 500 });
            },
          }),
        onRetry(from, to) {
          console.warn(`端口 ${from} 被占用，尝试 ${to}…`);
        },
      });
    } catch (error) {
      stopAll();
      closeDb();
      throw error;
    }
  })();

  const server = result.handle;
  setRuntimePort(server.port ?? config.port);
  console.log(`Jitter 已启动: ${server.url}`);
  console.log(`监听: ${config.host}:${server.port}`);
  console.log(`数据库: ${config.dbPath}`);
  console.log(`配置: ${loaded.source ?? "内置默认值"}`);
  if (result.attempts > 1) {
    console.log(`端口 ${config.port} 已被占用，已自动切换到 ${server.port}`);
  }
  console.log(
    `已恢复 ${summary.recovered}/${summary.active} 个 active 任务` +
      (summary.missed > 0 ? `，记录 ${summary.missed} 次错过窗口（不补跑）` : ""),
  );
  const retention = config.logRetentionDays;
  console.log(
    `日志保留：${retention > 0 ? `超过 ${retention} 天的日志自动清理` : "不自动清理"}` +
      `（每任务上限 ${config.logMaxRowsPerTask > 0 ? `${config.logMaxRowsPerTask} 条` : "不限"}）`,
  );
  if (getAutoVacuumMode() !== 2) {
    console.log(
      "提示：当前数据库未启用增量回收；在「清理日志」对话框执行一次清理即可切换，之后自动回收不再阻塞服务。",
    );
  }

  // One shutdown path for every trigger: Ctrl+C, the tray icon and the
  // "退出应用" button in the settings page.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n正在停止 Jitter...");
    stopAll();
    server.stop(true);
    // Give an in-flight abort a moment to write its log before exiting.
    await Bun.sleep(getActiveConfig().shutdownGraceMs);
    process.exit(0);
  };
  setShutdownHandler(() => {
    void shutdown();
  });

  // 恢复备份：停调度 → 关库 → 换文件 → 重新初始化 → 重启调度。
  // 恢复前 api.ts 已经做好当前状态的安全快照，数据不会被悄悄丢弃。
  registerRestoreHandler((backupPath) => {
    try {
      stopAll();
      closeDb();
      swapDatabase(config.dbPath, backupPath);
      initDb(config.dbPath);
      startScheduler();
      console.log(`数据库已从备份恢复: ${backupPath}`);
      return true;
    } catch (error) {
      console.error("恢复备份失败:", error);
      // 至少要让服务回到可用状态。
      try {
        initDb(config.dbPath);
        startScheduler();
      } catch {
        process.exit(1);
      }
      return false;
    }
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return server;
}

if (import.meta.main) {
  try {
    startServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
