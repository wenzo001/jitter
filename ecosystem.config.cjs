// PM2 keeps one process alive. Do not use cluster mode: Bun.cron/timers and
// SQLite are in-process, so multiple instances would double-run tasks.
module.exports = {
  apps: [
    {
      name: "jitter",
      cwd: __dirname,
      script: "bun",
      args: "run src/index.ts",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      kill_timeout: 5000,
      env: { NODE_ENV: "production" },
    },
  ],
};
