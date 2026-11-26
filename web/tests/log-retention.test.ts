import { describe, expect, it } from 'vitest'
import {
  LOG_RETENTION_CHOICES,
  effectiveRetentionDays,
  logRetentionOptions,
  logRetentionValue,
  parseLogRetention,
} from '@/utils/log-retention'
import { emptyFormModel, formModelFromTask } from '@/types/form'
import type { Task } from '@/types/task'

/** 造一个最小可用的任务对象。 */
function taskOf(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: '每日签到',
    status: 'active',
    running: 0,
    curl_command: null,
    request_url: 'http://example.com',
    request_method: 'GET',
    request_headers: null,
    request_body: null,
    request_options: '{}',
    notify_enabled: 0,
    notify_curl_command: null,
    notify_url: null,
    notify_method: null,
    notify_headers: null,
    notify_body: null,
    notify_options: null,
    expect_status: null,
    expect_body: null,
    expect_expr: null,
    precheck_enabled: 0,
    precheck_curl_command: null,
    precheck_url: null,
    precheck_method: null,
    precheck_headers: null,
    precheck_body: null,
    precheck_options: null,
    precheck_expect_status: null,
    precheck_expr: null,
    precheck_weekdays: null,
    precheck_time_start: null,
    precheck_time_end: null,
    precheck_require_ac: 0,
    precheck_require_network: 0,
    precheck_ip_pattern: null,
    precheck_day_type: null,
    log_retention_days: null,
    run_on_startup: 0,
    ...overrides,
  } as unknown as Task
}

const t = (key: string, named?: Record<string, unknown>) =>
  named ? `${key}:${JSON.stringify(named)}` : key

describe('utils/log-retention', () => {
  it('下拉选项：跟随全局 + 各档天数 + 永久保留', () => {
    const options = logRetentionOptions(t)
    expect(options[0].value).toBe('inherit')
    expect(options[options.length - 1].value).toBe(0)
    const dayValues = options
      .map((option) => option.value)
      .filter((value): value is number => typeof value === 'number' && value !== 0)
    expect(dayValues).toEqual([...LOG_RETENTION_CHOICES])
  })

  it('null 表示跟随全局，0 表示永久', () => {
    expect(logRetentionValue(null)).toBe('inherit')
    expect(logRetentionValue(undefined)).toBe('inherit')
    expect(logRetentionValue(0)).toBe(0)
    expect(logRetentionValue(30)).toBe(30)
  })

  it('下拉值能解析回天数', () => {
    expect(parseLogRetention('inherit')).toBeNull()
    expect(parseLogRetention(0)).toBe(0)
    expect(parseLogRetention(30)).toBe(30)
    expect(parseLogRetention('7')).toBe(7)
    expect(parseLogRetention(undefined)).toBeNull()
  })

  it('任务自己设了就用它的，否则用全局的', () => {
    expect(effectiveRetentionDays(null, 30)).toBe(30)
    expect(effectiveRetentionDays(undefined, 30)).toBe(30)
    expect(effectiveRetentionDays(7, 30)).toBe(7)
    expect(effectiveRetentionDays(0, 30)).toBe(0)
  })
})

describe('任务表单的日志保留', () => {
  it('新建任务默认跟随全局', () => {
    expect(emptyFormModel().logRetentionDays).toBeNull()
  })

  it('编辑任务时带回这个任务的保留天数', () => {
    expect(formModelFromTask(taskOf({ log_retention_days: 30 })).logRetentionDays).toBe(30)
    expect(formModelFromTask(taskOf({ log_retention_days: 0 })).logRetentionDays).toBe(0)
  })

  it('没设置过就保持 null（跟随全局）', () => {
    expect(formModelFromTask(taskOf({ log_retention_days: null })).logRetentionDays).toBeNull()
  })
})
