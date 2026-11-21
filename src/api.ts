import { Elysia } from "elysia";
import { getActiveConfig } from "./config";
import {
  LOG_CLEANUP_DAYS,
  LOG_RETENTION_SETTING,
  cleanupLogs,
  createTask,
  getEffectiveRetentionDays,
  getLog,
  getLogCleanupPreview,
  getTask,
  getTestRun,
  insertTestRun,
  listLogSummaries,
  listTasks,
  listTestRuns,
  setSetting,
  type LogCursor,
} from "./db";
import { CurlParseError, normalizeStructured, parseCurlCommand } from "./curl-parser";
import { validateCondition } from "./condition";
import { executeTestRequest } from "./executor";
import { GuardError, parseTimeRange, parseWeekdays } from "./guard";
import { getMetricsReport } from "./metrics";
import { buildSchedule, previewSchedule, scheduleOf, ScheduleError } from "./schedule";
import { runTestBench, type TestBenchInput } from "./testbench";
import {
  PauseError,
  RunNowError,
  deleteTask,
  editTask,
  pauseTask,
  resumeTask,
  runTaskNow,
  runningTasks,
  scheduleNewTask,
  stopTask,
} from "./scheduler";
import { WindowError } from "./window";
import type { NewTaskInput, RequestSpec, TaskRow } from "./types";

/**
 * A task as the UI wants it: the stored row plus two pieces of runtime truth
 * that live outside the database.
 *
 *  - `running` / `running_since`: the request is in flight right now. Without
 *    this the user cannot tell "waiting for the next run" from "stuck inside a
 *    request that never returns".
 *  - `schedule_error`: the schedule cannot be parsed (hand-edited row, legacy
 *    data). The task would silently never run, so the UI must say so.
 */
export interface TaskView extends TaskRow {
  running: boolean;
  running_since: number | null;
  schedule_error: string | null;
}

/**
 * What the task list needs: the card shows scheduling, status and conditions.
 * The bodies (curl command, headers, notification and precheck payloads) are
 * left out — they are only needed by the edit form, which fetches the full
 * task on demand.
 */
export interface TaskSummary {
  id: string;
  name: string;
  status: string;
  window_start: string;
  window_end: string;
  daily_jitter_minutes: number;
  schedule_kind: string;
  interval_seconds: number | null;
  interval_jitter_seconds: number;
  interval_start_at: number | null;
  next_run_at: number | null;
  paused_from: number | null;
  paused_until: number | null;
  precheck_enabled: number;
  notify_enabled: number;
  request_options: string | null;
  request_url: string;
  request_method: string;
  expect_status: number | null;
  expect_body: string | null;
  expect_expr: string | null;
  created_at: number;
  running: boolean;
  running_since: number | null;
  schedule_error: string | null;
}

function taskSummary(task: TaskRow, running: Record<string, number>): TaskSummary {
  const startedAt = running[task.id] ?? null;
  let scheduleError: string | null = null;
  try {
    scheduleOf(task);
  } catch (error) {
    scheduleError = error instanceof Error ? error.message : String(error);
  }
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    window_start: task.window_start,
    window_end: task.window_end,
    daily_jitter_minutes: task.daily_jitter_minutes,
    schedule_kind: task.schedule_kind,
    interval_seconds: task.interval_seconds,
    interval_jitter_seconds: task.interval_jitter_seconds,
    interval_start_at: task.interval_start_at,
    next_run_at: task.next_run_at,
    paused_from: task.paused_from,
    paused_until: task.paused_until,
    precheck_enabled: task.precheck_enabled,
    notify_enabled: task.notify_enabled,
    request_options: task.request_options,
    request_url: task.request_url,
    request_method: task.request_method,
    expect_status: task.expect_status,
    expect_body: task.expect_body,
    expect_expr: task.expect_expr,
    created_at: task.created_at,
    running: startedAt !== null,
    running_since: startedAt,
    schedule_error: scheduleError,
  };
}

function taskView(task: TaskRow, running: Record<string, number>): TaskView {
  const startedAt = running[task.id] ?? null;
  let scheduleError: string | null = null;
  try {
    scheduleOf(task);
  } catch (error) {
    scheduleError = error instanceof Error ? error.message : String(error);
  }
  return {
    ...task,
    running: startedAt !== null,
    running_since: startedAt,
    schedule_error: scheduleError,
  };
}

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

/** Stored JSON columns (test history) are display-only: bad data shows as null. */
function parseJsonColumn(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Log paging cursor: "<executed_at>:<id>". Logs are sorted by executed_at DESC
 * then id DESC, so the cursor carries both parts.
 */
function parseLogCursor(value: unknown): LogCursor | null {
  if (typeof value !== "string") return null;
  const [rawAt, rawId, ...rest] = value.split(":");
  if (rest.length > 0) return null;
  const executedAt = Number(rawAt);
  const id = Number(rawId);
  if (!Number.isInteger(executedAt) || executedAt < 0) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  return { executedAt, id };
}

function parseTaskInput(body: unknown): NewTaskInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CurlParseError("请求体必须是 JSON 对象");
  }
  const input = body as Record<string, unknown>;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new CurlParseError("请填写任务名称");
  if (name.length > 200) throw new CurlParseError("任务名称不能超过 200 个字符");

  // Scheduling: one payload shape covers all three kinds. `daily` keeps the
  // historical window validation, so old clients keep working untouched.
  const schedule = buildSchedule({
    schedule_kind: input.schedule_kind,
    window_start: typeof input.window_start === "string" ? input.window_start.trim() : "",
    window_end: typeof input.window_end === "string" ? input.window_end.trim() : "",
    daily_jitter_minutes: input.daily_jitter_minutes,
    interval_seconds: input.interval_seconds,
    interval_jitter_seconds: input.interval_jitter_seconds,
    interval_start_at: input.interval_start_at,
  });
  const windowStart = schedule.kind === "daily" ? (input.window_start as string).trim() : "";
  const windowEnd = schedule.kind === "daily" ? (input.window_end as string).trim() : "";

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

  if (notifyEnabled) {
    if (typeof input.notify_curl !== "string" || !input.notify_curl.trim()) {
      throw new CurlParseError("启用通知时必须填写通知 curl");
    }
    notifyCurl = input.notify_curl.trim();
    notifyRequest = parseCurlCommand(notifyCurl);
  }

  // Success conditions are independent of notifications: they decide the
  // "命中" flag recorded with every run, whether or not a notification exists.
  let expectStatus: number | null = null;
  let expectBody: string | null = null;
  let expectExpr: string | null = null;

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

  const rawExpr = input.expect_expr;
  if (rawExpr !== undefined && rawExpr !== null) {
    if (typeof rawExpr !== "string") {
      throw new CurlParseError("条件表达式必须是字符串");
    }
    const trimmed = rawExpr.trim();
    if (trimmed !== "") {
      const error = validateCondition(trimmed);
      if (error !== null) throw new CurlParseError(`条件表达式无效：${error}`);
      expectExpr = trimmed;
    }
  }

  // Pre-run guard: local conditions (weekdays / time range) and/or a guard curl.
  const precheckEnabled = toBoolean(input.precheck_enabled);
  let precheckRequest: RequestSpec | null = null;
  let precheckCurl: string | null = null;
  let precheckExpectStatus: number | null = null;
  let precheckExpr: string | null = null;
  let precheckWeekdays: number[] | null = null;
  let precheckTimeStart: string | null = null;
  let precheckTimeEnd: string | null = null;

  if (precheckEnabled) {
    // GuardError -> 400 via onError.
    precheckWeekdays = parseWeekdays(input.precheck_weekdays);
    const range = parseTimeRange(input.precheck_time_start, input.precheck_time_end);
    precheckTimeStart = range?.start ?? null;
    precheckTimeEnd = range?.end ?? null;

    const hasPrecheckCurl =
      typeof input.precheck_curl === "string" && input.precheck_curl.trim().length > 0;
    if (hasPrecheckCurl) {
      precheckCurl = (input.precheck_curl as string).trim();
      precheckRequest = parseCurlCommand(precheckCurl);
    } else if (typeof input.precheck_url === "string" && input.precheck_url.trim() !== "") {
      precheckRequest = normalizeStructured({
        url: input.precheck_url,
        method: typeof input.precheck_method === "string" ? input.precheck_method : null,
        headers: toHeadersInput(input.precheck_headers),
        body: typeof input.precheck_body === "string" ? input.precheck_body : null,
      });
    }

    const rawPreStatus = input.precheck_expect_status;
    if (rawPreStatus !== undefined && rawPreStatus !== null && rawPreStatus !== "") {
      const status = Number(rawPreStatus);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new CurlParseError("前置判断的期望状态码必须是 100–599 的整数");
      }
      precheckExpectStatus = status;
    }

    const rawPreExpr = input.precheck_expr;
    if (rawPreExpr !== undefined && rawPreExpr !== null) {
      if (typeof rawPreExpr !== "string") throw new CurlParseError("前置条件表达式必须是字符串");
      const trimmed = rawPreExpr.trim();
      if (trimmed !== "") {
        const error = validateCondition(trimmed);
        if (error !== null) throw new CurlParseError(`前置条件表达式无效：${error}`);
        precheckExpr = trimmed;
      }
    }

    const hasLocal = precheckWeekdays !== null || precheckTimeStart !== null;
    if (!hasLocal && precheckRequest === null) {
      throw new CurlParseError(
        "启用执行前判断时，至少配置本地条件（星期 / 时段）或前置判断 curl 之一",
      );
    }
    if (
      precheckRequest === null &&
      (precheckExpectStatus !== null || precheckExpr !== null)
    ) {
      throw new CurlParseError("配置了前置状态码或表达式时，必须填写前置判断 curl");
    }
  }

  return {
    name,
    curl_command: curlCommand,
    request,
    window_start: windowStart,
    window_end: windowEnd,
    daily_jitter_minutes: schedule.jitterMinutes,
    schedule_kind: schedule.kind,
    interval_seconds: schedule.intervalSeconds,
    interval_jitter_seconds: schedule.intervalJitterSeconds,
    interval_start_at: schedule.startAt,
    notify_enabled: notifyEnabled,
    notify_curl_command: notifyCurl,
    notify_request: notifyRequest,
    expect_status: expectStatus,
    expect_body: expectBody,
    expect_expr: expectExpr,
    precheck_enabled: precheckEnabled,
    precheck_curl_command: precheckCurl,
    precheck_request: precheckRequest,
    precheck_expect_status: precheckExpectStatus,
    precheck_expr: precheckExpr,
    precheck_weekdays: precheckWeekdays,
    precheck_time_start: precheckTimeStart,
    precheck_time_end: precheckTimeEnd,
  };
}

function createAndSchedule(input: NewTaskInput): TaskRow {
  const task = createTask(input);
  try {
    return scheduleNewTask(task);
  } catch (error) {
    // Never leave an active task behind without a timer if scheduling failed.
    stopTask(task.id);
    throw error;
  }
}

export const app = new Elysia()
  .onError(({ code, error, set }) => {
    if (error instanceof RunNowError) {
      set.status = 409;
      return { error: error.message };
    }
    if (
      error instanceof CurlParseError ||
      error instanceof WindowError ||
      error instanceof ScheduleError ||
      error instanceof GuardError ||
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
      // 0 means "no timeout": the UI warns, because a request that never
      // returns would keep the task busy forever.
      requestTimeoutMs: config.requestTimeoutMs,
      // The retention window actually in force (the UI override wins).
      logRetentionDays: getEffectiveRetentionDays(),
    };
  })
  /**
   * Change the retention window at runtime. 0 keeps everything.
   */
  .post("/api/settings", ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    const days = Number(input.logRetentionDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      set.status = 400;
      return { error: "保留天数必须是 0–3650 的整数（0 表示不限制）" };
    }
    setSetting(LOG_RETENTION_SETTING, String(days));
    return { ok: true, logRetentionDays: days };
  })
  /**
   * Run statistics for the metrics panel: headline numbers plus a per-task
   * success rate over the last N runs.
   */
  .get("/api/metrics", () => {
    const running = Object.keys(runningTasks()).length;
    return getMetricsReport(Date.now(), running);
  })
  .post("/api/curl/test", async ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    if (typeof input.curl !== "string" || input.curl.trim() === "") {
      set.status = 400;
      return { error: "请粘贴 curl 命令" };
    }
    // parseCurlCommand throws CurlParseError -> onError maps it to 400.
    const request = parseCurlCommand(input.curl.trim());
    const result = await executeTestRequest(request);
    return { result };
  })
  /**
   * Unified test bench: parse → local guard → guard curl → main request →
   * verdict → notify, all as one step timeline. Nothing is written to the
   * execution log; when `task_id` is given the run is kept in that task's
   * test history (last 10).
   */
  .post("/api/test/run", async ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    const result = await runTestBench(input as TestBenchInput);

    let testRunId: number | null = null;
    const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
    if (taskId !== "" && getTask(taskId)) {
      try {
        testRunId = insertTestRun({
          task_id: taskId,
          ok:
            !result.summary.skipped &&
            result.summary.matched &&
            result.summary.error === null &&
            !result.summary.notifyFailed,
          summary: JSON.stringify(result.summary),
          steps: JSON.stringify(result.steps),
        });
      } catch (error) {
        // History is a convenience: never fail the test itself for it.
        console.error("[jitter] 保存测试记录失败", error);
      }
    }
    return { result, test_run_id: testRunId };
  })
  .get("/api/tasks/:id/test-runs", ({ params, set }) => {
    if (!getTask(params.id)) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    const runs = listTestRuns(params.id).map((run) => ({
      id: run.id,
      created_at: run.created_at,
      ok: run.ok,
      summary: parseJsonColumn(run.summary),
    }));
    return { runs };
  })
  .get("/api/test-runs/:id", ({ params, set }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      set.status = 400;
      return { error: "测试记录 ID 无效" };
    }
    const run = getTestRun(id);
    if (!run) {
      set.status = 404;
      return { error: "测试记录不存在" };
    }
    return {
      run: {
        id: run.id,
        task_id: run.task_id,
        created_at: run.created_at,
        ok: run.ok,
        summary: parseJsonColumn(run.summary),
        steps: parseJsonColumn(run.steps),
      },
    };
  })
  /** "When will this actually run?" preview for the scheduler form. */
  .post("/api/schedule/preview", ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "请求体必须是 JSON 对象" };
    }
    const input = body as Record<string, unknown>;
    const schedule = buildSchedule({
      schedule_kind: input.schedule_kind,
      window_start: typeof input.window_start === "string" ? input.window_start : "",
      window_end: typeof input.window_end === "string" ? input.window_end : "",
      daily_jitter_minutes: input.daily_jitter_minutes,
      interval_seconds: input.interval_seconds,
      interval_jitter_seconds: input.interval_jitter_seconds,
      interval_start_at: input.interval_start_at,
    });
    // The form asks for 7; cap it so a stray value cannot return thousands.
    const rawCount = Number(input.count);
    const count = Number.isInteger(rawCount) ? Math.min(Math.max(rawCount, 1), 20) : 7;
    const preview = previewSchedule(schedule, Date.now(), count);
    return {
      ok: true,
      kind: schedule.kind,
      description: preview.description,
      next: preview.next,
      // The effective daily window: instant = "exact time", otherwise a range
      // (for jitter mode this is already expanded to [T-N, T+N]).
      window: schedule.window
        ? {
            start: schedule.window.start,
            end: schedule.window.end,
            instant: schedule.window.instant,
          }
        : null,
      jitter_minutes: schedule.jitterMinutes,
    };
  })
  .get("/api/tasks", () => {
    const running = runningTasks();
    return { tasks: listTasks().map((task) => taskSummary(task, running)) };
  })
  /** The full task, with the bodies the edit form needs. */
  .get("/api/tasks/:id", ({ params, set }) => {
    const task = getTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task: taskView(task, runningTasks()) };
  })
  .post("/api/tasks", ({ body, set }) => {
    const input = parseTaskInput(body);
    const scheduled = createAndSchedule(input);
    set.status = 201;
    return { task: taskView(scheduled, runningTasks()) };
  })
  .put("/api/tasks/:id", ({ params, body, set }) => {
    if (!getTask(params.id)) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    const input = parseTaskInput(body);
    const task = editTask(params.id, input);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task: taskView(task, runningTasks()) };
  })
  .delete("/api/tasks/:id", async ({ params, set }) => {
    const outcome = await deleteTask(params.id);
    if (!outcome) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return {
      ok: true,
      id: outcome.task.id,
      deleted_logs: outcome.deleted_logs,
      deleted_test_runs: outcome.deleted_test_runs,
    };
  })
  .post("/api/tasks/:id/stop", ({ params, set }) => {
    const task = stopTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task: taskView(task, runningTasks()) };
  })
  .post("/api/tasks/:id/run", async ({ params, set }) => {
    const result = await runTaskNow(params.id);
    if (!result) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return {
      ok: true,
      status: result.outcome.status,
      matched: result.outcome.matched,
      skipped: result.outcome.skipped,
      error: result.outcome.error,
      aborted: result.outcome.aborted,
      durationMs: result.outcome.durationMs,
      notifySent: result.outcome.notifyLogId !== null,
    };
  })
  .post("/api/tasks/:id/resume", ({ params, set }) => {
    const task = resumeTask(params.id);
    if (!task) {
      set.status = 404;
      return { error: "任务不存在" };
    }
    return { task: taskView(task, runningTasks()) };
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
    return { task: taskView(task, runningTasks()) };
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

    let before: LogCursor | null = null;
    if (query.before !== undefined && query.before !== "") {
      const parsed = parseLogCursor(query.before);
      if (!parsed) {
        set.status = 400;
        return { error: "before 必须是 <executed_at>:<id> 形式的游标" };
      }
      before = parsed;
    }

    // Older than the retention window: never queried, never rendered. The
    // background sweep deletes them for good.
    const retentionDays = getEffectiveRetentionDays();
    const since = retentionDays > 0 ? Date.now() - retentionDays * 24 * 60 * 60 * 1000 : null;

    const rows = listLogSummaries(params.id, limit + 1, before, since);
    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    return { logs, has_more: hasMore, retention_days: retentionDays };
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
    const DAY_MS = 24 * 60 * 60 * 1000;
    const cutoffRaw = input.cutoff;
    if (cutoffRaw !== undefined && cutoffRaw !== null) {
      // Bind the supplied cutoff to THIS tier's preview. A newer cutoff would
      // widen the deletion and bypass the stronger "delete all" confirmation;
      // a very old one means the user confirmed a stale snapshot.
      const expectedCutoff = Date.now() - days * DAY_MS;
      if (
        typeof cutoffRaw !== "number" ||
        !Number.isInteger(cutoffRaw) ||
        cutoffRaw <= 0 ||
        cutoffRaw > expectedCutoff + 5 * 60_000 ||
        cutoffRaw < expectedCutoff - DAY_MS
      ) {
        set.status = 400;
        return { error: "cutoff 必须来自对应档位的清理预检（不得放大删除范围或使用过期预检）" };
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
