/**
 * Test bench: run the exact chain a scheduled task would run, but as a
 * one-off diagnostic that writes nothing to the database.
 *
 * Steps are returned as a timeline so the UI can show the process (parse →
 * guard → request → verdict → notify) and, for each step, the request and
 * response that produced it.
 */

import { CurlParseError, normalizeStructured, parseCurlCommand } from "./curl-parser";
import { evaluatePrecheck, evaluateSuccess, executeTestRequest, type TestRequestOutcome } from "./executor";
import {
  evaluateLocalGuard,
  hasLocalConditions,
  parseTimeRange,
  parseWeekdays,
  type LocalGuardConfig,
} from "./guard";
import type { RequestSpec } from "./types";

export type TestStepStatus = "ok" | "fail" | "skip" | "info";

export interface TestStep {
  key: string;
  title: string;
  status: TestStepStatus;
  detail: string;
  durationMs: number | null;
  request: { method: string; url: string; headers: Record<string, string>; body: string | null } | null;
  response: TestRequestOutcome | null;
}

export interface TestBenchSummary {
  matched: boolean;
  skipped: boolean;
  status: number | null;
  error: string | null;
  totalMs: number;
  notifySent: boolean;
  /** A real notification was attempted (send_notify) and failed. */
  notifyFailed: boolean;
}

export interface TestBenchResult {
  steps: TestStep[];
  summary: TestBenchSummary;
}

export interface TestBenchInput {
  mode?: unknown;
  curl?: unknown;
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
  precheck_enabled?: unknown;
  precheck_curl?: unknown;
  precheck_url?: unknown;
  precheck_method?: unknown;
  precheck_headers?: unknown;
  precheck_body?: unknown;
  precheck_expect_status?: unknown;
  precheck_expr?: unknown;
  precheck_weekdays?: unknown;
  precheck_time_start?: unknown;
  precheck_time_end?: unknown;
  notify_enabled?: unknown;
  notify_curl?: unknown;
  notify_url?: unknown;
  notify_method?: unknown;
  notify_headers?: unknown;
  notify_body?: unknown;
  expect_status?: unknown;
  expect_body?: unknown;
  expect_expr?: unknown;
  /** Real notifications are opt-in: a test must not fire side effects silently. */
  send_notify?: unknown;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function headersInput(value: unknown): string | Record<string, string> | null {
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

function pickString(input: TestBenchInput, key: string): string | null {
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Build one request from a prefix (`""` = main, `"precheck"`, `"notify"`).
 * curl text wins over the structured fields, mirroring the task form.
 */
function buildRequest(prefix: string, input: TestBenchInput): RequestSpec {
  const curlKey = prefix === "" ? "curl" : `${prefix}_curl`;
  const rawCurl = pickString(input, curlKey);
  if (rawCurl !== null && rawCurl.trim() !== "") {
    return parseCurlCommand(rawCurl.trim());
  }
  const urlKey = prefix === "" ? "url" : `${prefix}_url`;
  const url = pickString(input, urlKey);
  if (url === null || url.trim() === "") {
    throw new CurlParseError(prefix === "" ? "请粘贴 curl 命令" : `请填写${prefix === "precheck" ? "前置判断" : "通知"} curl`);
  }
  const methodKey = prefix === "" ? "method" : `${prefix}_method`;
  const headersKey = prefix === "" ? "headers" : `${prefix}_headers`;
  const bodyKey = prefix === "" ? "body" : `${prefix}_body`;
  return normalizeStructured({
    url,
    method: pickString(input, methodKey),
    headers: headersInput((input as Record<string, unknown>)[headersKey]),
    body: pickString(input, bodyKey),
  });
}

function requestStepInfo(request: RequestSpec) {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
  };
}

function describeTransport(request: RequestSpec): string {
  const options = request.options ?? {};
  const extras: string[] = [];
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    extras.push(`超时 ${options.timeoutMs} ms`);
  }
  if (options.insecure) extras.push("跳过 TLS 校验");
  if (options.proxy) extras.push(`代理 ${options.proxy}`);
  if (options.redirect === "manual") extras.push("不跟随重定向");
  return extras.length > 0 ? `${request.method} ${request.url}（${extras.join("，")}）` : `${request.method} ${request.url}`;
}

function parseExpectStatus(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new CurlParseError("期望状态码必须是 100–599 的整数");
  }
  return parsed;
}

function parseExpectBody(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CurlParseError("期望响应体必须是字符串");
  return value === "" ? null : value;
}

function parseExpectExpr(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CurlParseError(`${label}必须是字符串`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function failureStep(key: string, title: string, detail: string, started: number): TestStep {
  return {
    key,
    title,
    status: "fail",
    detail,
    durationMs: Math.max(0, Date.now() - started),
    request: null,
    response: null,
  };
}

function responseStep(
  key: string,
  title: string,
  request: RequestSpec,
  response: TestRequestOutcome,
  started: number,
): TestStep {
  const failed = response.error !== null || response.aborted || response.status === null;
  return {
    key,
    title,
    status: failed ? "fail" : "ok",
    detail:
      response.status !== null
        ? `HTTP ${response.status} · ${response.durationMs} ms${response.truncated ? " · 响应体已截断" : ""}`
        : response.aborted
          ? "请求已中断"
          : (response.error ?? "没有拿到响应"),
    durationMs: Math.max(0, Date.now() - started),
    request: requestStepInfo(request),
    response,
  };
}

/**
 * Run the whole chain once. Never throws for a bad request: a parse failure is
 * returned as a failed step so the UI can show it in the timeline.
 */
export async function runTestBench(input: TestBenchInput): Promise<TestBenchResult> {
  const startedAt = Date.now();
  const steps: TestStep[] = [];
  const summary: TestBenchSummary = {
    matched: false,
    skipped: false,
    status: null,
    error: null,
    totalMs: 0,
    notifySent: false,
    notifyFailed: false,
  };

  // 1) Parse the main request.
  let main: RequestSpec;
  const parseStarted = Date.now();
  try {
    main = buildRequest("", input);
    steps.push({
      key: "parse",
      title: "解析 curl",
      status: "ok",
      detail: describeTransport(main),
      durationMs: Math.max(0, Date.now() - parseStarted),
      request: requestStepInfo(main),
      response: null,
    });
  } catch (error) {
    steps.push(
      failureStep(
        "parse",
        "解析 curl",
        error instanceof Error ? error.message : String(error),
        parseStarted,
      ),
    );
    summary.error = error instanceof Error ? error.message : String(error);
    summary.totalMs = Math.max(0, Date.now() - startedAt);
    return { steps, summary };
  }

  // 2) Optional guard: local conditions first (no request), then the guard curl.
  let expectStatus: number | null;
  let expectBody: string | null;
  let expectExpr: string | null;
  let precheckExpectStatus: number | null;
  let precheckExpr: string | null;
  let localConfig: LocalGuardConfig;
  try {
    expectStatus = parseExpectStatus(input.expect_status);
    expectBody = parseExpectBody(input.expect_body);
    expectExpr = parseExpectExpr(input.expect_expr, "条件表达式");
    precheckExpectStatus = parseExpectStatus(input.precheck_expect_status);
    precheckExpr = parseExpectExpr(input.precheck_expr, "前置条件表达式");
    const range = parseTimeRange(input.precheck_time_start, input.precheck_time_end);
    localConfig = {
      weekdays: parseWeekdays(input.precheck_weekdays),
      timeStart: range?.start ?? null,
      timeEnd: range?.end ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push(failureStep("assert-input", "校验条件配置", message, parseStarted));
    summary.error = message;
    summary.totalMs = Math.max(0, Date.now() - startedAt);
    return { steps, summary };
  }

  const guardOn = isTruthy(input.precheck_enabled);
  const precheckCurl = pickString(input, "precheck_curl");
  const hasGuardCurl = precheckCurl !== null && precheckCurl.trim() !== "";

  if (guardOn && !hasLocalConditions(localConfig) && !hasGuardCurl) {
    steps.push(
      failureStep(
        "precheck",
        "执行前判断",
        "已启用执行前判断，但没有配置本地条件或前置 curl",
        Date.now(),
      ),
    );
    summary.error = "已启用执行前判断，但没有配置本地条件或前置 curl";
    summary.totalMs = Math.max(0, Date.now() - startedAt);
    return { steps, summary };
  }

  if (guardOn && hasLocalConditions(localConfig)) {
    const localStarted = Date.now();
    const verdict = evaluateLocalGuard(localConfig, Date.now());
    steps.push({
      key: "local",
      title: "本地条件",
      status: verdict.passed ? "ok" : "fail",
      detail: verdict.reason,
      durationMs: Math.max(0, Date.now() - localStarted),
      request: null,
      response: null,
    });
    if (!verdict.passed) {
      summary.skipped = true;
      summary.error = verdict.reason;
      steps.push({
        key: "main",
        title: "主请求",
        status: "skip",
        detail: "本地条件不满足，本次不会发送主请求",
        durationMs: null,
        request: requestStepInfo(main),
        response: null,
      });
      summary.totalMs = Math.max(0, Date.now() - startedAt);
      return { steps, summary };
    }
  }

  if (guardOn && hasGuardCurl) {
    const guardStarted = Date.now();
    let guard: RequestSpec;
    try {
      guard = buildRequest("precheck", input);
    } catch (error) {
      steps.push(
        failureStep(
          "precheck",
          "前置判断",
          error instanceof Error ? error.message : String(error),
          guardStarted,
        ),
      );
      summary.error = error instanceof Error ? error.message : String(error);
      summary.totalMs = Math.max(0, Date.now() - startedAt);
      return { steps, summary };
    }

    const guardResponse = await executeTestRequest(guard);
    const verdict = evaluatePrecheck({
      status: guardResponse.status,
      body: guardResponse.body,
      truncated: guardResponse.truncated,
      aborted: guardResponse.aborted,
      error: guardResponse.error,
      expectStatus: precheckExpectStatus,
      expectExpr: precheckExpr,
    });
    steps.push({
      key: "precheck",
      title: "前置判断",
      status: verdict.passed ? "ok" : "fail",
      detail: verdict.reason,
      durationMs: Math.max(0, Date.now() - guardStarted),
      request: requestStepInfo(guard),
      response: guardResponse,
    });
    summary.status = guardResponse.status;
    if (!verdict.passed) {
      summary.skipped = true;
      summary.error = verdict.reason;
      steps.push({
        key: "main",
        title: "主请求",
        status: "skip",
        detail: "前置条件不满足，本次不会发送主请求",
        durationMs: null,
        request: requestStepInfo(main),
        response: null,
      });
      summary.totalMs = Math.max(0, Date.now() - startedAt);
      return { steps, summary };
    }
  }

  // 3) Main request.
  const mainStarted = Date.now();
  const mainResponse = await executeTestRequest(main);
  steps.push(responseStep("main", "主请求", main, mainResponse, mainStarted));
  summary.status = mainResponse.status;
  summary.error = mainResponse.error;

  // 4) Success verdict.
  const matched = evaluateSuccess({
    status: mainResponse.status,
    body: mainResponse.body,
    truncated: mainResponse.truncated,
    aborted: mainResponse.aborted,
    error: mainResponse.error,
    expectStatus,
    expectBody,
    expectExpr,
  });
  summary.matched = matched;

  const conditions: string[] = [];
  if (expectStatus !== null) conditions.push(`状态码 = ${expectStatus}`);
  if (expectBody !== null) conditions.push("响应体完全相等");
  if (expectExpr !== null) conditions.push(`表达式 ${expectExpr}`);
  if (conditions.length === 0 && mainResponse.status !== null) conditions.push("任意 2xx");

  steps.push({
    key: "assert",
    title: "成功条件判定",
    status: matched ? "ok" : "fail",
    detail:
      conditions.length > 0
        ? `${conditions.join(" 且 ")} → ${matched ? "命中" : "未命中"}`
        : "没有可判定的响应",
    durationMs: null,
    request: null,
    response: null,
  });

  // 5) Notification (only when the task would actually send one).
  const notifyEnabled = isTruthy(input.notify_enabled);
  if (notifyEnabled) {
    const notifyStarted = Date.now();
    if (!matched) {
      steps.push({
        key: "notify",
        title: "发送通知",
        status: "skip",
        detail: "未命中成功条件，正式运行时不会发送通知",
        durationMs: null,
        request: null,
        response: null,
      });
    } else if (!isTruthy(input.send_notify)) {
      let preview: RequestSpec | null = null;
      let detail = "演练模式：通知请求没有真正发送（勾选「实际发送通知」可验证）";
      try {
        preview = buildRequest("notify", input);
        detail = `演练模式：将发送 ${describeTransport(preview)}，但没有真正发出`;
      } catch (error) {
        detail = `通知配置无效：${error instanceof Error ? error.message : String(error)}`;
      }
      steps.push({
        key: "notify",
        title: "发送通知",
        status: "skip",
        detail,
        durationMs: null,
        request: preview ? requestStepInfo(preview) : null,
        response: null,
      });
    } else {
      try {
        const notify = buildRequest("notify", input);
        const notifyResponse = await executeTestRequest(notify);
        steps.push(responseStep("notify", "发送通知", notify, notifyResponse, notifyStarted));
        summary.notifySent = notifyResponse.status !== null && notifyResponse.error === null;
        if (!summary.notifySent) {
          summary.notifyFailed = true;
          if (summary.error === null) summary.error = notifyResponse.error;
        }
      } catch (error) {
        summary.notifyFailed = true;
        steps.push(
          failureStep(
            "notify",
            "发送通知",
            error instanceof Error ? error.message : String(error),
            notifyStarted,
          ),
        );
      }
    }
  }

  summary.totalMs = Math.max(0, Date.now() - startedAt);
  return { steps, summary };
}
