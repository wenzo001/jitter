import indexHtml from "./frontend/index.html";
import { app } from "./api";
import { getActiveConfig, loadConfig, setActiveConfig, type AppConfig } from "./config";
import { closeDb, initDb } from "./db";
import { listenWithPortRetry, isLocalBindHost } from "./port";
import { startScheduler, stopAll } from "./scheduler";

export interface ServerOptions {
  port?: number;
  hostname?: string;
  configPath?: string;
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
            routes: {
              "/": indexHtml,
            },
            fetch: (request) => app.fetch(request),
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

  return server;
}

if (import.meta.main) {
  try {
    const server = startServer();
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
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
