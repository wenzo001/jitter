import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { listLogs } = vi.hoisted(() => ({ listLogs: vi.fn() }))

vi.mock('@/api/tasks', () => ({
  listLogs,
  getLogDetail: vi.fn(),
}))

import { useLogsStore } from '@/stores/logs'
import type { LogSummary } from '@/types/task'

function summaryOf(id: number): LogSummary {
  return {
    id,
    task_id: 't1',
    executed_at: 1000 + id,
    request_url: 'http://example.com',
    request_method: 'GET',
    response_status: 200,
    duration_ms: 10,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: 1,
    run_source: 'scheduled',
  }
}

describe('执行记录的结果筛选', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listLogs.mockReset()
    listLogs.mockResolvedValue({ logs: [], has_more: false, retention_days: 30 })
  })

  it('默认是「全部」，请求里带上 all 口径', async () => {
    const logs = useLogsStore()
    expect(logs.outcome).toBe('all')
    await logs.load('t1', { reset: true, pageSize: 50 })
    expect(listLogs).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ outcome: 'all', limit: 50 }),
    )
  })

  it('筛选时一次拉全量匹配记录（limit 放大），不用再翻页', async () => {
    const logs = useLogsStore()
    logs.outcome = 'success'
    await logs.load('t1', { reset: true, pageSize: 50 })
    expect(listLogs).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ outcome: 'success', limit: 5000 }),
    )
  })

  it('筛选模式下显示上限放宽到 5000 条', async () => {
    const logs = useLogsStore()
    logs.outcome = 'success'
    expect(logs.maxRows).toBe(5000)
    logs.outcome = 'all'
    expect(logs.maxRows).toBe(300)
  })

  it('不筛选时仍然只显示最近 300 条', async () => {
    const logs = useLogsStore()
    listLogs.mockResolvedValue({
      logs: Array.from({ length: 320 }, (_, index) => summaryOf(index)),
      has_more: true,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true, pageSize: 50 })
    expect(logs.logs).toHaveLength(300)
    expect(logs.capped).toBe(true)
  })

  it('筛选结果超过 300 条也全部保留', async () => {
    const logs = useLogsStore()
    logs.outcome = 'success'
    listLogs.mockResolvedValue({
      logs: Array.from({ length: 320 }, (_, index) => summaryOf(index)),
      has_more: false,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true, pageSize: 50 })
    expect(logs.logs).toHaveLength(320)
    expect(logs.capped).toBe(false)
  })

  it('匹配总数会写进 store，供界面显示「共 N 条」', async () => {
    const logs = useLogsStore()
    logs.outcome = 'success'
    listLogs.mockResolvedValue({
      logs: [summaryOf(1)],
      has_more: false,
      retention_days: 30,
      matched_total: 128,
    })
    await logs.load('t1', { reset: true })
    expect(logs.matchedTotal).toBe(128)
  })

  it('换筛选口径会清空旧记录再重新拉取', async () => {
    const logs = useLogsStore()
    listLogs.mockResolvedValue({
      logs: [summaryOf(1)],
      has_more: false,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true })
    expect(logs.logs).toHaveLength(1)

    listLogs.mockResolvedValue({ logs: [], has_more: false, retention_days: 30 })
    logs.outcome = 'success'
    await logs.load('t1', { reset: true })
    expect(logs.logs).toHaveLength(0)
  })
})
