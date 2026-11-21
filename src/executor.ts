import { DEFAULT_CONFIG, getActiveConfig } from "./config";
import { evaluateCondition } from "./condition";
import { insertLog } from "./db";
import { evaluateLocalGuard, localGuardOf } from "./guard";
import type { RequestOptions, RequestSpec, TaskRow } from "./types";

/** Mirrors the configurable cap from one source; the live limit is the config. */
export const RESPONSE_BODY_LIMIT = DEFAULT_CONFIG.logBodyLimitBytes;

export interface SuccessInput {
  status: number | null;
  body: string | null;
  truncated: boolean;
  aborted: boolean;
  error: string | null;
  expectStatus: number | null;
  expectBody: string | null;
  expectExpr: string | null;
}

export interface RunOutcome {
  mainLogId: number;
  status: number | null;
  aborted: boolean;
  matched: boolean;
  /** The guard request did not pass, so the main request was never sent. */
  skipped: boolean;
  error: string | null;
  notifyLogId: number | null;
  durationMs: number;
}

export interface BodyReadResult {
  text: string;
  truncated: boolean;
}

interface RequestResult {
  status: number | null;
  headersJson: string | null;
  body: string;
  truncated: boolean;
  error: string | null;
  aborted: boolean;
  durationMs: number;
}

export function evaluateSuccess(input: SuccessInput): boolean {
  if (input.aborted || input.error !== null || input.status === null) {
    return false;
  }
  if (input.expectStatus !== null && input.status !== input.expectStatus) {
    return false;
  }
  if (input.expectBody !== null) {
    if (input.truncated) return false;
    if ((input.body ?? "") !== input.expectBody) return false;
  }
  if (input.expectExpr !== null) {
    if (input.truncated) return false;
    let json: unknown = null;
    if (input.body !== null) {
      try {
        json = JSON.parse(input.body);
      } catch {
        json = null;
      }
    }
    if (!evaluateCondition(input.expectExpr, { json, status: input.status, body: input.body })) {
      return false;
    }
  }
  if (
    input.expectStatus === null &&
    input.expectBody === null &&
    input.expectExpr === null
  ) {
    return input.status >= 200 && input.status < 300;
  }
  return true;
}

/**
 * Guard-request verdict. Kept separate from `evaluateSuccess` because the
 * failure has to be explained in the skipped log: users need to know WHY the
 * main request was not sent.
 */
export interface PrecheckInput {
  status: number | null;
  body: string | null;
  truncated: boolean;
  aborted: boolean;
  error: string | null;
  expectStatus: number | null;
  expectExpr: string | null;
}

export interface PrecheckVerdict {
  passed: boolean;
  reason: string;
}

export function evaluatePrecheck(input: PrecheckInput): PrecheckVerdict {
  if (input.aborted) return { passed: false, reason: "前置判断请求被中断" };
  if (input.error !== null) return { passed: false, reason: `前置判断请求失败：${input.error}` };
  if (input.status === null) return { passed: false, reason: "前置判断请求没有拿到响应" };
  if (input.expectStatus !== null && input.status !== input.expectStatus) {
    return {
      passed: false,
      reason: `前置判断返回 HTTP ${input.status}，期望 ${input.expectStatus}`,
    };
  }
  if (input.expectExpr !== null) {
    if (input.truncated) {
      return { passed: false, reason: "前置判断的响应体超过上限被截断，条件表达式无法判断" };
    }
    let json: unknown = null;
    try {
      json = input.body === null ? null : JSON.parse(input.body);
    } catch {
      json = null;
    }
    if (!evaluateCondition(input.expectExpr, { json, status: input.status, body: input.body })) {
      return { passed: false, reason: `前置条件不满足：${input.expectExpr}` };
    }
    return { passed: true, reason: `前置条件满足：${input.expectExpr}` };
  }
  if (input.expectStatus === null && !(input.status >= 200 && input.status < 300)) {
    return {
      passed: false,
      reason: `前置判断返回 HTTP ${input.status}（未配置条件时要求 2xx）`,
    };
  }
  return { passed: true, reason: `前置判断通过（HTTP ${input.status}）` };
}

export async function readBodyCapped(
  response: Response,
  limit: number = getActiveConfig().logBodyLimitBytes,
): Promise<BodyReadResult> {
  const stream = response.body;
  if (!stream) {
    return { text: "", truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = limit - received;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          received += remaining;
        }
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored; the cap is what matters.
        }
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    throw error;
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function parseStoredHeaders(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求头数据格式损坏");
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`请求头 ${name} 的值不是字符串`);
    }
    result[name] = value;
  }
  return result;
}

function describeError(error: unknown, aborted: boolean): string {
  if (aborted) return "请求已中断";
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function parseRequestOptions(raw: string | null): RequestOptions {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const options: RequestOptions = {};
    if (record.insecure === true) options.insecure = true;
    if (record.redirect === "follow" || record.redirect === "manual") {
      options.redirect = record.redirect;
    }
    if (
      typeof record.timeoutMs === "number" &&
      Number.isInteger(record.timeoutMs) &&
      record.timeoutMs >= 0
    ) {
      options.timeoutMs = record.timeoutMs;
    }
    if (typeof record.proxy === "string" && record.proxy.trim() !== "") {
      options.proxy = record.proxy.trim();
    }
    if (
      typeof record.proxyAuthorization === "string" &&
      record.proxyAuthorization.trim() !== ""
    ) {
      options.proxyAuthorization = record.proxyAuthorization.trim();
    }
    return options;
  } catch {
    return {};
  }
}

interface BunRequestInit extends RequestInit {
  tls?: { rejectUnauthorized?: boolean };
  proxy?:
    | string
    | {
        url: string;
        headers?: Record<string, string>;
      };
}

/**
 * Bun's fetch pool reuses keep-alive sockets. A remote peer (often a CDN) may
 * close an idle socket out from under us; the next fetch then writes into that
 * half-closed socket and rejects with ECONNRESET before any response byte is
 * received. Long-interval jobs (e.g. a daily notification) hit this reliably.
 *
 * We retry ONLY reset-shaped transport failures, only before response headers
 * arrive (the `fetch()` call itself), and never on abort/timeout. Retries carry
 * `Connection: close` so the pool opens a fresh socket instead of handing back
 * the same stale one. Non-reset errors (DNS, TLS, HTTP status, bad body) are
 * never retried — an HTTP status is a normal Response, not a thrown error.
 */
const FETCH_RESET_RETRIES = 2;
const FETCH_RETRY_BASE_DELAY_MS = 150;

/**
 * Long-lived processes (e.g. PM2) can inherit a stale proxy from env: the
 * proxy app changes its local port, but the daemon never restarts, so every
 * fetch hangs against the dead port while the browser (using the current
 * system proxy) works. Bun has no per-request "ignore env proxy" switch, so
 * the only way to fall back to a direct connection is to clear the proxy
 * env vars for this process. We snapshot them first and restore them if the
 * direct retry also fails.
 */
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** Cap a first attempt through an env proxy so a dead proxy fails fast. */
const PROXY_PROBE_TIMEOUT_MS = 8_000;

function snapshotEnvProxy(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim() !== "") snapshot[key] = value;
  }
  return snapshot;
}

function clearEnvProxy(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

function restoreEnvProxy(snapshot: Record<string, string>): void {
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function isConnectionResetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("socket connection was closed unexpectedly") ||
    message.includes("connection reset by peer") ||
    message.includes("econnreset")
  );
}

function headersWithClose(init: RequestInit): HeadersInit {
  const headers = new Headers(init.headers ?? undefined);
  headers.set("Connection", "close");
  return headers;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithResetRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw abortReason(signal);
    try {
      return await fetch(url, attempt === 0 ? init : { ...init, headers: headersWithClose(init) });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (attempt >= FETCH_RESET_RETRIES || !isConnectionResetError(error)) throw error;
      // Small, jittered backoff; abortable so stop/timeout stay responsive.
      const delay = FETCH_RETRY_BASE_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 80);
      await sleepAbortable(delay, signal);
    }
  }
}

async function performRequest(
  url: string,
  method: string,
  rawHeaders: string | null,
  body: string | null,
  signal: AbortSignal,
  options: RequestOptions,
  defaultTimeoutMs: number,
  bodyLimit: number,
): Promise<RequestResult> {
  const started = performance.now();
  let status: number | null = null;
  let headersJson: string | null = null;
  let responseBody = "";
  let truncated = false;
  let error: string | null = null;
  let aborted = false;

  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  const headers = parseStoredHeaders(rawHeaders);
  const init: BunRequestInit = {
    method,
    headers,
    body: body ?? undefined,
    signal: signal,
    redirect: options.redirect ?? "follow",
  };
  if (options.insecure) {
    init.tls = { rejectUnauthorized: false };
  }
  if (options.proxy) {
    init.proxy = options.proxyAuthorization
      ? {
          url: options.proxy,
          headers: {
            "Proxy-Authorization": options.proxyAuthorization,
          },
        }
      : options.proxy;
  }

  async function attempt(activeSignal: AbortSignal): Promise<void> {
    const response = await fetchWithResetRetry(url, { ...init, signal: activeSignal }, activeSignal);
    status = response.status;
    headersJson = JSON.stringify(Object.fromEntries(response.headers.entries()));
    const read = await readBodyCapped(response, bodyLimit);
    responseBody = read.text;
    truncated = read.truncated;
  }

  // An explicit curl `-x` means the user chose a proxy: never second-guess it.
  // Otherwise, if the process inherited proxy env vars, a dead proxy port can
  // hang every request. Give the first attempt a short probe timeout; on a
  // timeout / connection failure, clear the env proxy and retry direct once.
  const envProxy = options.proxy ? {} : snapshotEnvProxy();
  const hasEnvProxy = Object.keys(envProxy).length > 0;
  const firstTimeoutMs = hasEnvProxy
    ? timeoutMs > 0
      ? Math.min(timeoutMs, PROXY_PROBE_TIMEOUT_MS)
      : PROXY_PROBE_TIMEOUT_MS
    : timeoutMs;

  let caught: unknown = null;
  let didProxyFallback = false;
  let lastTimeoutMs = firstTimeoutMs;
  for (let round = 0; round < 2; round += 1) {
    if (signal.aborted) break;
    const activeTimeoutMs = round === 0 ? firstTimeoutMs : timeoutMs;
    lastTimeoutMs = activeTimeoutMs;
    const timeoutSignal = activeTimeoutMs > 0 ? AbortSignal.timeout(activeTimeoutMs) : null;
    const effectiveSignal = timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal;
    try {
      // Reset per-attempt outputs so a failed round cannot leak stale state.
      status = null;
      headersJson = null;
      responseBody = "";
      truncated = false;
      aborted = false;
      await attempt(effectiveSignal);
      caught = null;
      break;
    } catch (error) {
      caught = error;
      const callerAborted = signal.aborted;
      const timedOut = timeoutSignal !== null && timeoutSignal.aborted && !callerAborted;
      aborted = effectiveSignal.aborted;
      // A dead/stale env proxy typically *hangs* until the probe timeout
      // (a refused port fails fast and is left alone). Fall back only on that
      // timeout, only on round 0, only when we actually used an env proxy,
      // and only before any response headers arrived (status === null).
      // Use the CALLER's signal for the abort check: the internal timeout also
      // marks effectiveSignal.aborted, which must not be mistaken for a cancel.
      const canFallback = round === 0 && hasEnvProxy && !callerAborted && timedOut && status === null;
      if (canFallback) {
        clearEnvProxy();
        didProxyFallback = true;
        console.warn("[jitter] 环境代理探测超时，已清除失效代理并改用直连重试");
        continue;
      }
      break;
    }
  }

  // A direct retry that also fails means the env proxy is needed after all;
  // put it back so other requests are not stranded without their proxy.
  if (didProxyFallback && status === null && caught !== null) {
    restoreEnvProxy(envProxy);
  }

  if (caught !== null) {
    const message = caught instanceof Error ? caught.message : String(caught);
    // Bun reports its own socket timeout as "ETIMEDOUT", which the old
    // case-sensitive check missed: the user saw a raw socket error instead of
    // "请求超时".
    const lower = message.toLowerCase();
    const looksLikeTimeout =
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("etimedout");
    error = looksLikeTimeout
      ? `请求超时（${lastTimeoutMs} ms）`
      : describeError(caught, aborted);
  }

  return {
    status,
    headersJson,
    body: responseBody,
    truncated,
    error,
    aborted,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

/** A one-off probe request: same transport as a real task run, but no DB log. */
export interface TestRequestOutcome {
  status: number | null;
  headers: Record<string, string> | null;
  body: string;
  truncated: boolean;
  error: string | null;
  aborted: boolean;
  durationMs: number;
}

/** Safety net for the test endpoint so a hanging URL cannot block the caller. */
const TEST_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a single request parsed from a user-pasted curl, reusing the exact
 * transport (retries, TLS/proxy options, timeout, body cap) as a scheduled run.
 * Nothing is written to the database — this is a diagnostic probe only.
 */
export async function executeTestRequest(request: RequestSpec): Promise<TestRequestOutcome> {
  const config = getActiveConfig();
  const result = await performRequest(
    request.url,
    request.method,
    request.headers ? JSON.stringify(request.headers) : null,
    request.body,
    new AbortController().signal,
    { timeoutMs: TEST_REQUEST_TIMEOUT_MS, ...(request.options ?? {}) },
    config.requestTimeoutMs,
    config.logBodyLimitBytes,
  );

  let headers: Record<string, string> | null = null;
  if (result.headersJson !== null) {
    try {
      headers = JSON.parse(result.headersJson) as Record<string, string>;
    } catch {
      headers = null;
    }
  }

  return {
    status: result.status,
    headers,
    body: result.body,
    truncated: result.truncated,
    error: result.error,
    aborted: result.aborted,
    durationMs: result.durationMs,
  };
}

interface SkipExchange {
  requestUrl: string | null;
  requestMethod: string | null;
  requestHeaders: string | null;
  requestBody: string | null;
  status: number | null;
  headersJson: string | null;
  body: string;
  truncated: boolean;
  aborted: boolean;
  durationMs: number;
}

/**
 * One row that explains a skipped run. Local-guard skips carry no exchange
 * (nothing was sent); curl-guard skips carry the guard request and response,
 * because that is what actually happened.
 */
function recordSkip(task: TaskRow, reason: string, exchange: SkipExchange | null): number {
  const storedBody =
    exchange && exchange.status !== null
      ? exchange.truncated
        ? `${exchange.body}\n[truncated]`
        : exchange.body
      : null;
  return insertLog({
    task_id: task.id,
    executed_at: Date.now(),
    request_url: exchange?.requestUrl ?? null,
    request_method: exchange?.requestMethod ?? null,
    request_headers: exchange?.requestHeaders ?? null,
    request_body: exchange?.requestBody ?? null,
    response_status: exchange?.status ?? null,
    response_headers: exchange?.headersJson ?? null,
    response_body: storedBody,
    duration_ms: exchange?.durationMs ?? 0,
    error: `${reason}；已跳过主请求 ${task.request_method} ${task.request_url}`,
    aborted: exchange?.aborted ? 1 : 0,
    kind: "skipped",
    parent_log_id: null,
    matched: 0,
  });
}

export async function executeTaskRun(task: TaskRow, signal: AbortSignal): Promise<RunOutcome> {
  const config = getActiveConfig();

  // Guard first: the main request is only sent when every configured guard
  // condition passes. Local conditions cost nothing; the guard curl runs only
  // when one is configured.
  if (task.precheck_enabled === 1) {
    const verdict = evaluateLocalGuard(localGuardOf(task), Date.now());
    if (!verdict.passed) {
      const mainLogId = recordSkip(task, verdict.reason, null);
      console.warn(`[jitter] 任务「${task.name}」跳过本次执行：${verdict.reason}`);
      return {
        mainLogId,
        status: null,
        aborted: false,
        matched: false,
        skipped: true,
        error: verdict.reason,
        notifyLogId: null,
        durationMs: 0,
      };
    }

    if (task.precheck_url) {
      const precheck = await runPrecheck(task, signal, config);
      if (!precheck.verdict.passed) {
        const mainLogId = recordSkip(task, precheck.verdict.reason, {
          requestUrl: task.precheck_url,
          requestMethod: task.precheck_method ?? "GET",
          requestHeaders: task.precheck_headers,
          requestBody: task.precheck_body,
          status: precheck.status,
          headersJson: precheck.headersJson,
          body: precheck.body,
          truncated: precheck.truncated,
          aborted: precheck.aborted,
          durationMs: precheck.durationMs,
        });
        console.warn(`[jitter] 任务「${task.name}」跳过本次执行：${precheck.verdict.reason}`);
        return {
          mainLogId,
          status: precheck.status,
          aborted: precheck.aborted,
          matched: false,
          skipped: true,
          error: precheck.verdict.reason,
          notifyLogId: null,
          durationMs: precheck.durationMs,
        };
      }
    }
  }

  const mainOptions = parseRequestOptions(task.request_options);
  const mainExecutedAt = Date.now();
  const main = await performRequest(
    task.request_url,
    task.request_method,
    task.request_headers,
    task.request_body,
    signal,
    mainOptions,
    config.requestTimeoutMs,
    config.logBodyLimitBytes,
  );

  const matched = evaluateSuccess({
    status: main.status,
    body: main.body,
    truncated: main.truncated,
    aborted: main.aborted,
    error: main.error,
    expectStatus: task.expect_status,
    expectBody: task.expect_body,
    expectExpr: task.expect_expr,
  });

  const storedBody =
    main.status === null
      ? null
      : main.truncated
        ? `${main.body}\n[truncated]`
        : main.body;

  const mainLogId = insertLog({
    task_id: task.id,
    executed_at: mainExecutedAt,
    request_url: task.request_url,
    request_method: task.request_method,
    request_headers: task.request_headers,
    request_body: task.request_body,
    response_status: main.status,
    response_headers: main.headersJson,
    response_body: storedBody,
    duration_ms: main.durationMs,
    error: main.error,
    aborted: main.aborted ? 1 : 0,
    kind: "task",
    parent_log_id: null,
    matched: matched ? 1 : 0,
  });

  let notifyLogId: number | null = null;
  if (
    matched &&
    task.notify_enabled === 1 &&
    task.notify_url &&
    !signal.aborted
  ) {
    const notifyExecutedAt = Date.now();
    const notifyOptions = parseRequestOptions(task.notify_options);
    const notify = await performRequest(
      task.notify_url,
      task.notify_method ?? "GET",
      task.notify_headers,
      task.notify_body,
      signal,
      notifyOptions,
      config.requestTimeoutMs,
      config.logBodyLimitBytes,
    );
    notifyLogId = insertLog({
      task_id: task.id,
      executed_at: notifyExecutedAt,
      request_url: task.notify_url,
      request_method: task.notify_method ?? "GET",
      request_headers: task.notify_headers,
      request_body: task.notify_body,
      response_status: notify.status,
      response_headers: notify.headersJson,
      response_body:
        notify.status === null
          ? null
          : notify.truncated
            ? `${notify.body}\n[truncated]`
            : notify.body,
      duration_ms: notify.durationMs,
      error: notify.error,
      aborted: notify.aborted ? 1 : 0,
      kind: "notify",
      parent_log_id: mainLogId,
      matched: null,
    });
  }

  return {
    mainLogId,
    status: main.status,
    aborted: main.aborted,
    matched,
    skipped: false,
    error: main.error,
    notifyLogId,
    durationMs: main.durationMs,
  };
}

interface PrecheckRun {
  verdict: PrecheckVerdict;
  status: number | null;
  headersJson: string | null;
  body: string;
  truncated: boolean;
  error: string | null;
  aborted: boolean;
  durationMs: number;
}

/** Send the guard request with exactly the same transport as a normal run. */
async function runPrecheck(
  task: TaskRow,
  signal: AbortSignal,
  config: ReturnType<typeof getActiveConfig>,
): Promise<PrecheckRun> {
  const result = await performRequest(
    task.precheck_url ?? "",
    task.precheck_method ?? "GET",
    task.precheck_headers,
    task.precheck_body,
    signal,
    parseRequestOptions(task.precheck_options),
    config.requestTimeoutMs,
    config.logBodyLimitBytes,
  );
  const verdict = evaluatePrecheck({
    status: result.status,
    body: result.body,
    truncated: result.truncated,
    aborted: result.aborted,
    error: result.error,
    expectStatus: task.precheck_expect_status,
    expectExpr: task.precheck_expr,
  });
  return {
    verdict,
    status: result.status,
    headersJson: result.headersJson,
    body: result.body,
    truncated: result.truncated,
    error: result.error,
    aborted: result.aborted,
    durationMs: result.durationMs,
  };
}
