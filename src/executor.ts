import { DEFAULT_CONFIG, getActiveConfig } from "./config";
import { insertLog } from "./db";
import type { RequestOptions, TaskRow } from "./types";

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
}

export interface RunOutcome {
  mainLogId: number;
  status: number | null;
  aborted: boolean;
  matched: boolean;
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
  if (input.expectStatus === null && input.expectBody === null) {
    return input.status >= 200 && input.status < 300;
  }
  return true;
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
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const effectiveSignal = timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : signal;

  try {
    const headers = parseStoredHeaders(rawHeaders);
    const init: BunRequestInit = {
      method,
      headers,
      body: body ?? undefined,
      signal: effectiveSignal,
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
    const response = await fetch(url, init);
    status = response.status;
    headersJson = JSON.stringify(Object.fromEntries(response.headers.entries()));
    const read = await readBodyCapped(response, bodyLimit);
    responseBody = read.text;
    truncated = read.truncated;
  } catch (caught) {
    const timedOut = timeoutSignal !== null && timeoutSignal.aborted && !signal.aborted;
    aborted = effectiveSignal.aborted;
    error = timedOut
      ? `请求超时（${timeoutMs} ms）`
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

export async function executeTaskRun(task: TaskRow, signal: AbortSignal): Promise<RunOutcome> {
  const config = getActiveConfig();
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
    error: main.error,
    notifyLogId,
    durationMs: main.durationMs,
  };
}
