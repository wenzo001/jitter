import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LogSummary, LogsResponse } from '@/types/task'

const listLogs = vi.fn()
const getLogDetail = vi.fn()

vi.mock('@/api/tasks', () => ({
  listLogs: (...args: unknown[]) => listLogs(...args),
  getLogDetail: (...args: unknown[]) => getLogDetail(...args),
}))

// 在 mock 之后再导入，确保 store 拿到的是被 mock 的 api 模块。
const { useLogsStore } = await import('@/stores/logs')

function makeLog(id: number, executedAt: number, taskId = 'task-a'): LogSummary {
  return {
    id,
    task_id: taskId,
    executed_at: executedAt,
    request_url: `https://example.com/${id}`,
    request_method: 'GET',
    response_status: 200,
    duration_ms: 10,
    error: null,
    aborted: 0,
    kind: 'http' as LogSummary['kind'],
    parent_log_id: null,
    matched: null,
    run_source: 'scheduled',
  }
}

function respond(logs: LogSummary[], hasMore = false): LogsResponse {
  return { logs, has_more: hasMore, retention_days: 30 }
}

/** 断言整列严格降序（先 executed_at，再 id）。 */
function expectStrictlyDesc(rows: LogSummary[]): void {
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]
    const curr = rows[i]
    if (prev.executed_at !== curr.executed_at) {
      expect(prev.executed_at).toBeGreaterThan(curr.executed_at)
    } else {
      expect(prev.id).toBeGreaterThan(curr.id)
    }
  }
}

describe('stores/logs 排序', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listLogs.mockReset()
    getLogDetail.mockReset()
  })

  it('后端返回乱序时，前端输出仍然按时间从新到旧', async () => {
    listLogs.mockResolvedValue(
      respond([makeLog(1, 1000), makeLog(3, 3000), makeLog(2, 2000)]),
    )

    const store = useLogsStore()
    await store.load('task-a')

    expect(store.logs.map((l) => l.id)).toEqual([3, 2, 1])
    expectStrictlyDesc(store.logs)
  })

  it('时间戳相同时按 id 从大到小，保证顺序稳定', async () => {
    listLogs.mockResolvedValue(respond([makeLog(7, 5000), makeLog(9, 5000), makeLog(8, 5000)]))

    const store = useLogsStore()
    await store.load('task-a')

    expect(store.logs.map((l) => l.id)).toEqual([9, 8, 7])
    expectStrictlyDesc(store.logs)
  })

  it('加载更旧一页后，合并结果仍然整体降序且不重复', async () => {
    listLogs.mockResolvedValueOnce(respond([makeLog(5, 5000), makeLog(4, 4000)], true))
    const store = useLogsStore()
    await store.load('task-a')

    listLogs.mockResolvedValueOnce(respond([makeLog(3, 3000), makeLog(2, 2000)], false))
    await store.load('task-a', { older: true })

    expect(store.logs.map((l) => l.id)).toEqual([5, 4, 3, 2])
    expectStrictlyDesc(store.logs)
    expect(new Set(store.logs.map((l) => l.id)).size).toBe(store.logs.length)
  })

  it('重叠页里重复出现的 id 只保留一份', async () => {
    listLogs.mockResolvedValueOnce(respond([makeLog(10, 9000), makeLog(9, 8000)], true))
    const store = useLogsStore()
    await store.load('task-a')

    listLogs.mockResolvedValueOnce(respond([makeLog(9, 8000), makeLog(8, 7000)], false))
    await store.load('task-a', { older: true })

    expect(store.logs.map((l) => l.id)).toEqual([10, 9, 8])
    expectStrictlyDesc(store.logs)
  })

  it('切换任务时清空旧数据，不残留上一个任务的历史', async () => {
    listLogs.mockResolvedValueOnce(respond([makeLog(1, 1000, 'task-a')]))
    const store = useLogsStore()
    await store.load('task-a')
    expect(store.logs).toHaveLength(1)

    listLogs.mockResolvedValueOnce(respond([makeLog(2, 2000, 'task-b')]))
    await store.load('task-b')

    expect(store.logs.map((l) => l.task_id)).toEqual(['task-b'])
  })

  it('清空后列表为空', async () => {
    listLogs.mockResolvedValue(respond([makeLog(1, 1000)]))
    const store = useLogsStore()
    await store.load('task-a')
    store.clear()

    expect(store.logs).toEqual([])
    expect(store.hasMore).toBe(false)
    expect(store.capped).toBe(false)
  })

  it('超过 300 条上限时保留最新的，并明确标记已到上限', async () => {
    const first = Array.from({ length: 200 }, (_, index) => makeLog(1000 + index, 100000 - index))
    listLogs.mockResolvedValueOnce(respond(first, true))
    const store = useLogsStore()
    await store.load('task-a', { reset: true, pageSize: 200 })
    expect(store.logs).toHaveLength(200)

    const second = Array.from({ length: 200 }, (_, index) => makeLog(500 + index, 50000 - index))
    listLogs.mockResolvedValueOnce(respond(second, true))
    await store.load('task-a', { older: true, pageSize: 200 })

    // 最多 300 条，且挤掉的是更早的记录，最新的仍在最上面。
    expect(store.logs).toHaveLength(300)
    expect(store.logs[0].id).toBe(1000)
    expectStrictlyDesc(store.logs)
    // 到上限后不再假装还有更多，否则「加载更早」点了没反应。
    expect(store.capped).toBe(true)
    expect(store.hasMore).toBe(false)
  })

  it('已经到上限时不再发请求', async () => {
    listLogs.mockResolvedValue(respond(Array.from({ length: 300 }, (_, index) => makeLog(index + 1, 90000 - index))))
    const store = useLogsStore()
    await store.load('task-a', { reset: true, pageSize: 300 })
    expect(listLogs).toHaveBeenCalledTimes(1)

    await store.load('task-a', { older: true })
    expect(listLogs).toHaveBeenCalledTimes(1)
    expect(store.hasMore).toBe(false)
    expect(store.capped).toBe(true)
  })
})
