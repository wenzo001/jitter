export type RedirectMode = "follow" | "manual";

export interface RequestOptions {
  insecure?: boolean;
  redirect?: RedirectMode;
  timeoutMs?: number;
  proxy?: string;
  proxyAuthorization?: string;
}

export interface RequestSpec {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  options?: RequestOptions;
}

export type TaskStatus = "active" | "stopped";

/** Kept inline (instead of importing `schedule.ts`) so rows stay dependency-free. */
export type StoredScheduleKind = "daily" | "interval";

export interface TaskRow {
  id: string;
  name: string;
  curl_command: string | null;
  request_url: string;
  request_method: string;
  request_headers: string | null;
  request_body: string | null;
  request_options: string | null;
  window_start: string;
  window_end: string;
  /** ± minutes of jitter around an exact daily time; 0 for a plain range. */
  daily_jitter_minutes: number;
  /** `daily` for every row created before scheduling modes existed. */
  schedule_kind: StoredScheduleKind;
  interval_seconds: number | null;
  interval_jitter_seconds: number;
  /** Optional first-run anchor for `interval` (epoch ms); null = from creation. */
  interval_start_at: number | null;
  status: TaskStatus;
  next_run_at: number | null;
  paused_from: number | null;
  paused_until: number | null;
  created_at: number;
  updated_at: number;
  /** Optional guard request executed before the main one; not passing = skip. */
  precheck_enabled: number;
  precheck_curl_command: string | null;
  precheck_url: string | null;
  precheck_method: string | null;
  precheck_headers: string | null;
  precheck_body: string | null;
  precheck_options: string | null;
  precheck_expect_status: number | null;
  precheck_expr: string | null;
  /** Comma-separated weekdays (0=Sunday); null means "every day". */
  precheck_weekdays: string | null;
  /** Optional HH:mm execution window for the guard. */
  precheck_time_start: string | null;
  precheck_time_end: string | null;
  notify_enabled: number;
  notify_curl_command: string | null;
  notify_url: string | null;
  notify_method: string | null;
  notify_headers: string | null;
  notify_body: string | null;
  notify_options: string | null;
  expect_status: number | null;
  expect_body: string | null;
  expect_expr: string | null;
}

export type LogKind = "task" | "notify" | "missed" | "skipped";

export interface LogRow {
  id: number;
  task_id: string;
  executed_at: number;
  request_url: string | null;
  request_method: string | null;
  request_headers: string | null;
  request_body: string | null;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  aborted: number;
  kind: LogKind;
  parent_log_id: number | null;
  matched: number | null;
}

/**
 * The light view of a log row: everything the list needs, without the request
 * and response bodies (up to 100 KiB each). The detail is fetched on demand
 * when the user opens a log entry.
 */
export interface LogSummary {
  id: number;
  task_id: string;
  executed_at: number;
  request_url: string | null;
  request_method: string | null;
  response_status: number | null;
  duration_ms: number | null;
  error: string | null;
  aborted: number;
  kind: LogKind;
  parent_log_id: number | null;
  matched: number | null;
}

export interface NewLogInput {  task_id: string;
  executed_at: number;
  request_url: string | null;
  request_method: string | null;
  request_headers: string | null;
  request_body: string | null;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  aborted: number;
  kind?: LogKind;
  parent_log_id?: number | null;
  matched?: number | null;
}

export interface NewTaskInput {
  name: string;
  curl_command: string | null;
  request: RequestSpec;
  window_start: string;
  window_end: string;
  /** Only for exact-time daily tasks (start === end); defaults to 0. */
  daily_jitter_minutes?: number;
  /** Optional so callers written before scheduling modes keep working. */
  schedule_kind?: StoredScheduleKind;
  interval_seconds?: number | null;
  interval_jitter_seconds?: number;
  interval_start_at?: number | null;
  notify_enabled: boolean;
  notify_curl_command: string | null;
  notify_request: RequestSpec | null;
  expect_status: number | null;
  expect_body: string | null;
  expect_expr: string | null;
  /** Optional guard request; `precheck_enabled === false` keeps old behaviour. */
  precheck_enabled?: boolean;
  precheck_curl_command?: string | null;
  precheck_request?: RequestSpec | null;
  precheck_expect_status?: number | null;
  precheck_expr?: string | null;
  /** Local guard: allowed weekdays (0=Sunday) and an optional HH:mm range. */
  precheck_weekdays?: number[] | null;
  precheck_time_start?: string | null;
  precheck_time_end?: string | null;
}
