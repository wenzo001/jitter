import { Elysia } from "elysia";
import { getActiveConfig } from "./config";
import {
  LOG_CLEANUP_DAYS,
  cleanupLogs,
  createTask,
  getLog,
  getLogCleanupPreview,
  getTask,
  listLogs,
  listTasks,
} from "./db";
import { CurlParseError, normalizeStructured, parseCurlCommand } from "./curl-parser";
import { PauseError, pauseTask, resumeTask, scheduleNewTask, stopTask } from "./scheduler";
import { WindowError, validateWindow } from "./window";
import type { NewTaskInput, RequestSpec, TaskRow } from "./types";

function toHeadersInput(value: unknown): string | Record<string, string> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof headerValue !== "string") {
        throw new CurlParseError(`Header ${name} 的值必须是字符串`);
      }
      result[name] = headerValue;
    }
    return result;
  }
  throw new CurlParseError("Headers 必须是文本或 JSON 对象");
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseTaskInput(body: unknown): NewTaskInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CurlParseError("请求体必须是 JSON 对象");
  }
  const input = body as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CurlParseError("请填写任务名称");
  if (name.length > 200) throw new CurlParseError("任务名称不能超过 200 个字符");

  const windowStart = typeof input.window_start === "string" ? input.window_start.trim() : "";
  const windowEnd = typeof input.window_end === "string" ? input.window_end.trim() : "";
  const windowError = validateWindow(windowStart, windowEnd);
  if (windowError) throw new WindowError(windowError);

  const hasCurl = typeof input.curl === "string" && input.curl.trim().length > 0;
  const mode =
    input.mode === "structured"
      ? "structured"
      : input.mode === "curl"
        ? "curl"
        : hasCurl
          ? "curl"
          : "structured";

  let request: RequestSpec;
  let curlCommand: string | null = null;
  if (mode === "curl") {
    if (typeof input.curl !== "string" || !input.curl.trim()) {
      throw new CurlParseError("请粘贴 curl 命令");
    }
    curlCommand = input.curl.trim();
    request = parseCurlCommand(curlCommand);
  } else {
    if (typeof input.url !== "string" || !input.url.trim()) {
      throw new CurlParseError("请填写 URL");
    }
    const bodyValue = input.body;
    if (bodyValue !== undefined && bodyValue !== null && typeof bodyValue !== "string") {
      throw new CurlParseError("Body 必须是字符串");
    }
    request = normalizeStructured({
      url: input.url,
      method: typeof input.method === "string" ? input.method : null,
      headers: toHeadersInput(input.headers),
      body: typeof bodyValue === "string" ? bodyValue : null,
    });
  }

  const notifyEnabled = toBoolean(input.notify_enabled);
  let notifyRequest: RequestSpec | null = null;
  let notifyCurl: string | null = null;
  let expectStatus: number | null = null;
  let expectBody: string | null = null;

  if (notifyEnabled) {
    if (typeof input.notify_curl !== "string" || !input.notify_curl.trim()) {
      throw new CurlParseError("启用通知时必须填写通知 curl");
    }
    notifyCurl = input.notify_curl.trim();
    notifyRequest = parseCurlCommand(notifyCurl);

    const rawStatus = input.expect_status;
    if (rawStatus !== undefined && rawStatus !== null && rawStatus !== "") {
      const status = Number(rawStatus);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new CurlParseError("期望状态码必须是 100–599 的整数");
      }
      expectStatus = status;
    }

    const rawBody = input.expect_body;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody !== "string") {
        throw new CurlParseError("期望响应体必须是字符串");
      }
      if (rawBody !== "") expectBody = rawBody;
    }
  }

  return {
    name,
    curl_command: curlCommand,
    request,
    window_start: windowStart,
    window_end: windowEnd,
    notify_enabled: notifyEnabled,
    notify_curl_command: notifyCurl,
    notify_request: notifyRequest,
    expect_status: expectStatus,
    expect_body: expectBody,
  };
}

function createAndSchedule(input: NewTaskInput): TaskRow {
  const task = createTask(input);
  try {
    return scheduleNewTask(task);
  } catch (error) {
    // Never leave an active task behind without a cron/timer if scheduling failed.
    stopTask(task.id);
    throw error;
  }
}

export const app = new Elysia()
  .onError(({ code, error, set }) => {
    if (
      error instanceof CurlParseError ||
      error instanceof WindowError ||
      error instanceof PauseError
    ) {
      set.status = 400;
      return { error: error.message };
    }
    if (code === "PARSE" || code === "VALIDATION") {
      set.status = 400;
      return { error: "请求体不是合法 JSON 或字段格式不正确" };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "接口不存在" };
    }
    console.error("[jitter] API 错误", error);
    set.status = 500;
    return { error: "服务器内部错误" };
  })
  .get("/api/health", () => ({ ok: true, now: Date.now() }))
  .get("/api/config", () => {
    const config = getActiveConfig();
    return {
      logsPageSize: config.logsPageSize,
      defaultWindowMinutes: config.defaultWindowMinutes,
      pollIntervalMs: config.pollIntervalMs,
      logBodyLimitBytes: config.logBodyLimitBytes,
    };
  })
  .get("/api/tasks", () => ({ tasks: listTasks() }))
  .post("/api/tasks", ({ body, set }) => {
    const input = parseTaskInput(body);
    const scheduled = createAndSchedule(input);
    set.status = 201;
    return { task: scheduled };
  })
  .post("/api/tasks/:id/stop", ({ params, set }) => {
    const task = stopTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task };
  })
  .post("/api/tasks/:id/resume", ({ params, set }) => {
    const task = resumeTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task };
  })
  .post("/api/tasks/:id/pause", ({ params, body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    const days = typeof input.days === "number" ? input.days : Number.NaN;
    const startsToday = toBoolean(input.starts_today);
    const task = pauseTask(params.id, { days, startsToday });
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task };
  })
  .get("/api/tasks/:id/logs", ({ params, query, set }) => {
    const task = getTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }

    const config = getActiveConfig();
    const rawLimit =
      typeof query.limit === "string" && query.limit.trim() !== ""
        ? Number(query.limit)
        : config.logsPageSize;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), config.logsMaxPageSize)
      : config.logsPageSize;

    let before: number | null = null;
    if (query.before !== undefined && query.before !== "") {
      const parsed = Number(query.before);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        set.status = 400;
        return { error: "before 必须是正整数" };
      }
      before = Math.trunc(parsed);
    }

    const rows = listLogs(params.id, limit + 1, before);
    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    return { logs, has_more: hasMore };
  })
  .get("/api/logs/cleanup/preview", () => getLogCleanupPreview())
  .post("/api/logs/cleanup", ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    const wantsAll = input.all === true;
    const hasDays = input.days !== undefined && input.days !== null;

    if (wantsAll && hasDays) {
      set.status = 400;
      return { error: "days 与 all 不能同时指定" };
    }

    if (wantsAll) {
      if (input.confirm !== "DELETE_ALL") {
        set.status = 400;
        return { error: "全部清除需要二次确认：confirm 必须为 \"DELETE_ALL\"" };
      }
      return cleanupLogs({ all: true });
    }

    const days = input.days;
    if (typeof days !== "number" || !(LOG_CLEANUP_DAYS as readonly number[]).includes(days)) {
      set.status = 400;
      return { error: `days 必须是 ${LOG_CLEANUP_DAYS.join(" / ")} 之一（数字类型）` };
    }
    if (input.confirm !== true && input.confirm !== "DELETE") {
      set.status = 400;
      return { error: "清理前需要二次确认：confirm 必须为 true" };
    }
    const cutoffRaw = input.cutoff;
    if (cutoffRaw !== undefined && cutoffRaw !== null) {
      if (
        typeof cutoffRaw !== "number" ||
        !Number.isInteger(cutoffRaw) ||
        cutoffRaw <= 0 ||
        cutoffRaw > Date.now()
      ) {
        set.status = 400;
        return { error: "cutoff 必须是有效的过去时间戳（来自清理预检）" };
      }
    }
    // A preview cutoff makes deletion match the confirmed count exactly.
    return cleanupLogs({
      days,
      ...(typeof cutoffRaw === "number" ? { cutoff: cutoffRaw } : {}),
    });
  })
  .get("/api/logs/:id", ({ params, set }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      set.status = 400;
      return { error: "日志 ID 无效" };
    }
    const log = getLog(id);
    if (!log) {
      set.status = 404;
      return { error: "日志不存在" };
    }
    return { log };
  });
