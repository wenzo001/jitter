export type ScheduleKind = 'daily' | 'interval'
export type TaskStatus = 'active' | 'stopped' | string

/** 上一次执行的结果归类。 */
export type RunOutcome = 'success' | 'failed' | 'condition_miss'

export interface TaskLastRun {
  id: number
  executedAt: number
  outcome: RunOutcome
  /** HTTP 状态码。 */
  status: number | null
  durationMs: number | null
  error: string | null
  /** 是否满足成功条件（1 = 满足）。 */
  matched: number | null
  /** 触发来源：scheduled / manual / startup。 */
  runSource: string | null
  kind: string
}

export interface Task {
  id: string
  name: string
  curl_command: string | null
  request_url: string
  request_method: string
  request_headers: string | null
  request_body: string | null
  request_options: string | null
  window_start: string
  window_end: string
  daily_jitter_minutes: number
  schedule_kind: ScheduleKind
  interval_seconds: number | null
  interval_jitter_seconds: number
  interval_start_at: number | null
  status: TaskStatus
  next_run_at: number | null
  paused_from: number | null
  paused_until: number | null
  created_at: number
  updated_at: number
  sort_order: number
  notify_enabled: number
  notify_curl_command: string | null
  notify_url: string | null
  notify_method: string | null
  notify_headers: string | null
  notify_body: string | null
  notify_options: string | null
  precheck_enabled: number
  precheck_curl_command: string | null
  precheck_url: string | null
  precheck_method: string | null
  precheck_headers: string | null
  precheck_body: string | null
  precheck_options: string | null
  precheck_expect_status: number | null
  precheck_expr: string | null
  precheck_weekdays: string | null
  precheck_time_start: string | null
  precheck_time_end: string | null
  precheck_require_ac: number
  precheck_ip_pattern: string | null
  /** 工作日 / 休息日条件：workday / offday；null 表示不限制。 */
  precheck_day_type: 'workday' | 'offday' | null
  run_on_startup: number
  expect_status: number | null
  expect_body: string | null
  expect_expr: string | null
  schedule_description: string
  running: boolean
  running_since: number | null
  schedule_error: string | null
  /** 上一次执行（没有执行过时为 null）。 */
  last_run: TaskLastRun | null
}

export interface TaskPayload {
  name: string
  schedule_kind: ScheduleKind
  mode: 'curl' | 'structured'
  notify_enabled: boolean
  precheck_enabled: boolean
  run_on_startup: boolean
  window_start?: string
  window_end?: string
  daily_jitter_minutes?: number
  interval_seconds?: number
  interval_jitter_seconds?: number
  interval_start_at?: number
  curl?: string
  url?: string
  method?: string
  headers?: string
  body?: string
  notify_curl?: string
  expect_status?: number
  expect_body?: string
  expect_expr?: string
  precheck_weekdays?: number[]
  precheck_time_start?: string
  precheck_time_end?: string
  precheck_curl?: string
  precheck_ip_pattern?: string
  precheck_require_ac?: boolean
  /** 工作日 / 休息日条件（法定节假日数据判断）。 */
  precheck_day_type?: 'workday' | 'offday'
  precheck_expect_status?: number
  precheck_expr?: string
}

export type LogKind = 'task' | 'notify' | 'missed' | 'skipped' | string

export interface LogSummary {
  id: number
  task_id: string
  executed_at: number
  request_url: string | null
  request_method: string | null
  response_status: number | null
  duration_ms: number | null
  error: string | null
  aborted: number
  kind: LogKind
  parent_log_id: number | null
  matched: number | null
  run_source: 'scheduled' | 'manual' | 'startup' | null
  /** 附属通知：API 聚合到父任务行，通知本身不再单独成行。列表给摘要，详情给完整行。 */
  notify?: LogSummary &
    Partial<Pick<LogDetail, 'request_headers' | 'request_body' | 'response_headers' | 'response_body'>>
}

export interface LogDetail extends LogSummary {
  request_headers: string | null
  request_body: string | null
  response_headers: string | null
  response_body: string | null
}

export interface LogsResponse {
  logs: LogSummary[]
  has_more: boolean
  retention_days: number
}

export interface LogDetailResponse {
  log: LogDetail
}

export interface TaskResponse {
  task: Task
}

export interface TasksResponse {
  tasks: Task[]
}

export interface RunResult {
  ok: boolean
  status: number | null
  matched: boolean
  skipped: boolean
  error: string | null
  aborted: boolean
  durationMs: number | null
  notifySent: boolean
}

export interface SchedulePreviewRequest {
  schedule_kind: ScheduleKind
  window_start?: string
  window_end?: string
  daily_jitter_minutes?: number
  interval_seconds?: number
  interval_jitter_seconds?: number
  interval_start_at?: number
  count: number
}

export interface SchedulePreviewResponse {
  kind: ScheduleKind
  next: number[]
  window: { start: string; end: string; instant: boolean } | null
  jitter_minutes: number
  description: string
}
