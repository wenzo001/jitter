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
  status: TaskStatus;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
  notify_enabled: number;
  notify_curl_command: string | null;
  notify_url: string | null;
  notify_method: string | null;
  notify_headers: string | null;
  notify_body: string | null;
  notify_options: string | null;
  expect_status: number | null;
  expect_body: string | null;
}

export type LogKind = "task" | "notify" | "missed";

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

export interface NewLogInput {
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
  notify_enabled: boolean;
  notify_curl_command: string | null;
  notify_request: RequestSpec | null;
  expect_status: number | null;
  expect_body: string | null;
}
