export interface TestStepRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
}

export interface TestResponseOutcome {
  status: number | null
  headers: Record<string, string> | null
  body: string
  truncated: boolean
  error: string | null
  aborted: boolean
  durationMs: number
}

export interface TestStep {
  key: string
  title: string
  status: 'ok' | 'fail' | 'skip' | 'info' | string
  detail: string
  durationMs: number | null
  request: TestStepRequest | null
  response: TestResponseOutcome | null
}

export interface TestSummary {
  matched: boolean
  skipped: boolean
  status: number | null
  error: string | null
  totalMs: number
  notifySent: boolean
  notifyFailed: boolean
}

export interface TestBenchResult {
  steps: TestStep[]
  summary: TestSummary
}

export interface TestBenchResponse {
  result: TestBenchResult
  test_run_id: number | null
}

export interface TestRunSummary {
  id: number
  created_at: number
  ok: number
  summary: TestSummary
}

export interface TestRunDetail {
  id: number
  task_id: string
  created_at: number
  ok: number
  summary: TestSummary
  steps: TestStep[]
}

export interface TestBenchPayload {
  curl: string
  precheck_enabled: boolean
  notify_enabled: boolean
  send_notify: boolean
  task_id?: string
  precheck_weekdays?: number[]
  precheck_time_start?: string
  precheck_time_end?: string
  precheck_curl?: string
  precheck_ip_pattern?: string
  precheck_require_ac?: boolean
  precheck_expect_status?: number
  precheck_expr?: string
  expect_status?: number
  expect_body?: string
  expect_expr?: string
  notify_curl?: string
}

import type { ConditionModel } from './form'

/** 试跑弹窗的初始配置：来自任务卡片、试跑入口或正在编辑的表单。 */
export interface TestBenchConfig {
  curl: string
  precheckEnabled: boolean
  conditions: ConditionModel
  expectStatus: string
  expectBody: string
  expectExpr: string
  notifyEnabled: boolean
  notifyCurl: string
  taskId: string | null
  taskName?: string
}
