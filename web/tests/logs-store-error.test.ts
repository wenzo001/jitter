/**
 * logs store 可靠性回归：
 * - 查询失败要有 error 状态、可 retry() 重试；
 * - 查询失败时保留旧日志，而不是先清空再失败；
 * - loading 状态在失败后必须复位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LogSummary } from '@/types/task'

const { listLogs, getLogDetail } = vi.hoisted(() => ({
  listLogs: vi.fn(),
  getLogDetail: vi.fn(),
}))
vi.mock('@/api/tasks', () => ({
  listLogs: (...args: unknown[]) => listLogs(...args),
  getLogDetail: (...args: unknown[]) => getLogDetail(...args),
}))

import { useLogsStore } from '@/stores/logs'

function logOf(id: number, overrides: Partial<LogSummary> = {}): LogSummary {
  return {
    id,
    task_id: 't1',
    executed_at: 1_700_000_000_000 + id,
    request_url: 'https://example.com/x',
    request_method: 'GET',
    response_status: 200,
    duration_ms: 10,
    error: null,
    aborted: 0,
    kind: 'task',
    parent_log_id: null,
    matched: 1,
    run_source: 'scheduled',
    ...overrides,
  }
}

describe('stores/logs 错误与重试', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listLogs.mockReset()
    getLogDetail.mockReset()
  })

  it('查询成功后失败：保留旧日志并记录 error，loading 复位', async () => {
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: false,
      retention_days: 30,
    })
    const logs = useLogsStore()
    await logs.load('t1', { reset: true })
    expect(logs.logs.map((l) => l.id)).toEqual([1])

    listLogs.mockRejectedValueOnce(new Error('连不上后台服务'))
    await logs.load('t1', { reset: true })

    // 旧日志必须还在：失败不能把已展示的数据清空。
    expect(logs.logs.map((l) => l.id)).toEqual([1])
    expect(logs.error).toContain('连不上后台服务')
    expect(logs.loading).toBe(false)
  })

  it('retry() 重放上一次查询，成功后清除 error', async () => {
    listLogs.mockRejectedValueOnce(new Error('boom'))
    const logs = useLogsStore()
    await logs.load('t1', { reset: true })
    expect(logs.error).toBe('boom')
    expect(logs.logs).toEqual([])

    listLogs.mockResolvedValueOnce({
      logs: [logOf(7)],
      has_more: false,
      retention_days: 30,
    })
    await logs.retry()
    expect(logs.error).toBe('')
    expect(logs.logs.map((l) => l.id)).toEqual([7])
  })

  it('切换到别的任务查询失败：不把上一个任务的日志冒充当前任务', async () => {
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: false,
      retention_days: 30,
    })
    const logs = useLogsStore()
    await logs.load('t1', { reset: true })

    listLogs.mockRejectedValueOnce(new Error('网络错误'))
    await logs.load('t2', { reset: true })
    expect(logs.logs).toEqual([])
    expect(logs.error).toBe('网络错误')
  })

  it('切换结果筛选后查询失败：不把旧筛选的日志冒充当前筛选', async () => {
    const logs = useLogsStore()
    logs.outcome = 'all'
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1, { error: 'failed' })],
      has_more: false,
      retention_days: 30,
      matched_total: 1,
    })
    await logs.load('t1', { reset: true })
    expect(logs.logs.map((l) => l.id)).toEqual([1])

    logs.outcome = 'success'
    listLogs.mockRejectedValueOnce(new Error('网络错误'))
    await logs.load('t1', { reset: true })

    expect(listLogs).toHaveBeenLastCalledWith('t1', expect.objectContaining({ outcome: 'success' }))
    expect(logs.logs).toEqual([])
    expect(logs.matchedTotal).toBe(0)
    expect(logs.error).toBe('网络错误')
  })

  it('切换任务时立即清空旧口径，迟到的旧响应也不能填回来', async () => {
    let resolveOld!: (value: { logs: LogSummary[]; has_more: boolean; retention_days: number }) => void
    let resolveNext!: (value: {
      logs: LogSummary[]
      has_more: boolean
      retention_days: number
      matched_total?: number
    }) => void
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: false,
      retention_days: 30,
    })
    const logs = useLogsStore()
    await logs.load('t1', { reset: true })

    listLogs.mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)))
    const oldRequest = logs.load('t1', { reset: true })
    listLogs.mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)))
    const nextRequest = logs.load('t2', { reset: true })

    expect(logs.logs).toEqual([])

    resolveOld({ logs: [logOf(2)], has_more: false, retention_days: 30 })
    await oldRequest
    expect(logs.logs).toEqual([])

    resolveNext({ logs: [logOf(3, { task_id: 't2' })], has_more: false, retention_days: 30 })
    await nextRequest
    expect(logs.logs.map((row) => row.id)).toEqual([3])
  })

  it('切换结果筛选时立即清空旧口径，不等新请求落定', async () => {
    let resolveNext!: (value: {
      logs: LogSummary[]
      has_more: boolean
      retention_days: number
      matched_total?: number
    }) => void
    const logs = useLogsStore()
    logs.outcome = 'all'
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1, { error: 'failed' })],
      has_more: false,
      retention_days: 30,
      matched_total: 1,
    })
    await logs.load('t1', { reset: true })

    logs.outcome = 'success'
    listLogs.mockReturnValueOnce(new Promise((resolve) => (resolveNext = resolve)))
    const nextRequest = logs.load('t1', { reset: true })

    expect(logs.logs).toEqual([])
    expect(logs.matchedTotal).toBe(0)

    resolveNext({ logs: [], has_more: false, retention_days: 30, matched_total: 0 })
    await nextRequest
    expect(logs.logs).toEqual([])
  })

  it('加载更早记录时切换筛选：旧请求不能把新口径永久留在加载态', async () => {
    let resolveOlder!: (value: { logs: LogSummary[]; has_more: boolean; retention_days: number }) => void
    const logs = useLogsStore()
    logs.outcome = 'all'
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: true,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true })

    listLogs.mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
    const olderRequest = logs.load('t1', { older: true })
    expect(logs.loadingOlder).toBe(true)

    logs.outcome = 'success'
    listLogs.mockResolvedValueOnce({
      logs: [],
      has_more: false,
      retention_days: 30,
      matched_total: 0,
    })
    const nextRequest = logs.load('t1', { reset: true })
    expect(logs.loadingOlder).toBe(false)
    await nextRequest

    resolveOlder({ logs: [logOf(2)], has_more: false, retention_days: 30 })
    await olderRequest
    expect(logs.loadingOlder).toBe(false)
  })

  it('clear() 复位仍在途的加载更早状态', async () => {
    let resolveOlder!: (value: { logs: LogSummary[]; has_more: boolean; retention_days: number }) => void
    const logs = useLogsStore()
    listLogs.mockResolvedValueOnce({
      logs: [logOf(1)],
      has_more: true,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true })

    listLogs.mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
    const olderRequest = logs.load('t1', { older: true })
    expect(logs.loadingOlder).toBe(true)

    logs.clear()
    expect(logs.loadingOlder).toBe(false)

    resolveOlder({ logs: [logOf(2)], has_more: false, retention_days: 30 })
    await olderRequest
    expect(logs.loadingOlder).toBe(false)
  })

  it('查询成功后 error 清空', async () => {
    const logs = useLogsStore()
    listLogs.mockRejectedValueOnce(new Error('boom'))
    await logs.load('t1', { reset: true })
    expect(logs.error).toBe('boom')

    listLogs.mockResolvedValueOnce({
      logs: [logOf(2)],
      has_more: false,
      retention_days: 30,
    })
    await logs.load('t1', { reset: true })
    expect(logs.error).toBe('')
  })

  it('同一条日志的并发详情请求共享在途 Promise', async () => {
    let resolve!: (value: { log: LogSummary }) => void
    getLogDetail.mockReturnValue(new Promise((r) => (resolve = r)))
    const logs = useLogsStore()

    const first = logs.loadDetail(1)
    const second = logs.loadDetail(1)
    expect(getLogDetail).toHaveBeenCalledTimes(1)

    resolve({ log: logOf(1) })
    const results = await Promise.all([first, second])
    expect(results[0]?.id).toBe(1)
    expect(results[1]?.id).toBe(1)
  })

  it('clear() 同时清掉 error', async () => {
    const logs = useLogsStore()
    listLogs.mockRejectedValueOnce(new Error('boom'))
    await logs.load('t1', { reset: true })
    logs.clear()
    expect(logs.error).toBe('')
    expect(logs.logs).toEqual([])
  })
})
