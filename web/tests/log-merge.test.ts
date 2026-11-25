import { describe, expect, it } from 'vitest'
import type { LogSummary } from '@/types/task'
import { groupLogs, logGroupKey, normalizeLogError } from '@/utils/log-merge'

function logOf(overrides: Partial<LogSummary> = {}): LogSummary {
  return {
    id: 1,
    task_id: 't1',
    executed_at: 1_700_000_000_000,
    request_url: 'http://1.1.1.3/ac_portal/login.php',
    request_method: 'POST',
    response_status: null,
    duration_ms: 0,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: null,
    run_source: 'scheduled',
    ...overrides,
  } as LogSummary
}

/** 截图里那种跳过记录：只有「当前 HH:MM」在变。 */
function skippedAt(id: number, clock: string): LogSummary {
  return logOf({
    id,
    kind: 'skipped',
    error: `当前 ${clock} 不在执行时段 23:55–01:05（跨午夜）内；已跳过主请求 POST http://1.1.1.3/ac_portal/login.php`,
  })
}

describe('utils/log-merge', () => {
  it('归一化错误文本只替换第一个时间戳', () => {
    expect(normalizeLogError('当前 18:55 不在执行时段 23:55–01:05 内')).toBe(
      '当前 <now> 不在执行时段 23:55–01:05 内',
    )
    expect(normalizeLogError('没有时间的错误')).toBe('没有时间的错误')
  })

  it('同因的跳过记录归到同一组', () => {
    const groups = groupLogs([skippedAt(3, '18:55'), skippedAt(2, '18:50'), skippedAt(1, '18:45')])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(3)
    expect(groups[0].items.map((item) => item.id)).toEqual([3, 2, 1])
  })

  it('不同的执行时段不会被合并', () => {
    const a = skippedAt(2, '18:55')
    const b = logOf({
      id: 1,
      kind: 'skipped',
      error:
        '当前 18:50 不在执行时段 09:00–10:00 内；已跳过主请求 POST http://1.1.1.3/ac_portal/login.php',
    })
    const groups = groupLogs([a, b])
    expect(groups).toHaveLength(2)
  })

  it('中间夹了别的类型就断开分组', () => {
    const groups = groupLogs([
      skippedAt(3, '18:55'),
      logOf({ id: 2, kind: 'task', response_status: 200, matched: 1 }),
      skippedAt(1, '18:45'),
    ])
    expect(groups).toHaveLength(3)
  })

  it('耗时不同不影响归组（耗时每次都在变）', () => {
    const a = logOf({ id: 2, duration_ms: 100 })
    const b = logOf({ id: 1, duration_ms: 900 })
    expect(logGroupKey(a)).toBe(logGroupKey(b))
    expect(groupLogs([a, b])).toHaveLength(1)
  })

  it('状态码 / 触发方式不同就不合并', () => {
    const a = logOf({ id: 2, response_status: 200, matched: 1 })
    const b = logOf({ id: 1, response_status: 500, matched: 0 })
    const c = logOf({ id: 3, response_status: 200, matched: 1, run_source: 'manual' })
    expect(groupLogs([a, b])).toHaveLength(2)
    expect(groupLogs([a, c])).toHaveLength(2)
  })

  it('空列表返回空分组', () => {
    expect(groupLogs([])).toEqual([])
  })
})
