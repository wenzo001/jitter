import indexHtml from "./frontend/index.html";
import { app } from "./api";
import { initDb, resolveDbPath } from "./db";
import { startScheduler, stopAll } from "./scheduler";

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

export function startServer(options: ServerOptions = {}): ReturnType<typeof Bun.serve> {
  initDb();
  const summary = startScheduler();

  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";

  const server = Bun.serve({
    hostname,
    port,
    routes: {
      "/": indexHtml,
    },
    fetch: (request) => app.fetch(request),
    error(error) {
      console.error("[jitter] Bun.serve 错误", error);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  console.log(`Jitter 已启动: ${server.url}`);
  console.log(`数据库: ${resolveDbPath()}`);
  console.log(
    `已恢复 ${summary.recovered}/${summary.active} 个 active 任务` +
      (summary.missed > 0 ? `，记录 ${summary.missed} 次错过窗口（不补跑）` : ""),
  );

  return server;
}

if (import.meta.main) {
  const server = startServer();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n正在停止 Jitter...");
    stopAll();
    server.stop(true);
    // Give an in-flight abort a moment to write its log before exiting.
    await Bun.sleep(150);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
