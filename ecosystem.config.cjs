// PM2 single-instance config. Do not use cluster mode: Bun.cron/timers and
// SQLite are in-process, so multiple instances would double-run tasks.
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "jitter",
      cwd: __dirname,
      // Spawn bun directly (interpreter: "none") so SIGINT/SIGTERM reach
      // src/index.ts; do not use a single "bun run ..." string (shell wrapper).
      script: "bun",
      args: "run src/index.ts",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      // Must stay well above shutdownGraceMs (150 ms in jitter.config.json).
      kill_timeout: 5000,
      // Safety net only: measured RSS is ~50-66 MB under load. If this trips
      // repeatedly, investigate instead of raising it blindly.
      max_memory_restart: "300M",
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "3001",
        JITTER_CONFIG: path.join(__dirname, "jitter.config.json"),
        // Absolute path required: PM2's cwd and the config file dir may differ.
        JITTER_DB_PATH: path.join(__dirname, "data", "app.db"),
      },
    },
  ],
};
