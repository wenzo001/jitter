import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useStorage } from '@vueuse/core'
import { getLogDetail, listLogs } from '@/api/tasks'
import { localizeBackendMessage } from '@/api/client'
import type { LogDetail, LogSummary } from '@/types/task'

/** 不筛选时最多显示多少条记录（超出部分要靠「加载更早的记录」翻出来）。 */
const MAX_LOG_ROWS = 300

/** 筛选时最多显示多少条：筛选是用户明确要「一次看完」的动作，所以给足。 */
const MAX_FILTERED_LOG_ROWS = 5000

/** 结果筛选口径。 */
export type LogOutcome = 'all' | 'success' | 'failed' | 'skipped'

function compareLogsDesc(a: LogSummary, b: LogSummary): number {
  if (b.executed_at !== a.executed_at) return b.executed_at - a.executed_at
  return b.id - a.id
}

export const useLogsStore = defineStore('logs', () => {
  const logs = ref<LogSummary[]>([])
  const hasMore = ref(false)
  const retentionDays = ref(30)
  const loading = ref(false)
  const loadingOlder = ref(false)
  /** 最近一次列表查询的错误信息（空串 = 没有错误）。失败时旧日志保持展示，界面给「重试」入口。 */
  const error = ref('')
  /** 已经到「最多显示 N 条」的上限，更早的记录不再继续加载。 */
  const capped = ref(false)
  /** 结果筛选：按成功 / 失败 / 跳过过滤执行记录（记住上次选择）。 */
  const outcome = useStorage<LogOutcome>('jitter.logsOutcome', 'all')
  /** 当前筛选口径下、保留窗口内的匹配总数。 */
  const matchedTotal = ref(0)

  /** 当前一次最多显示多少条（筛选时给足，不筛选时维持原来的 300 条上限）。 */
  const maxRows = computed(() =>
    outcome.value !== 'all' ? MAX_FILTERED_LOG_ROWS : MAX_LOG_ROWS,
  )

  const detailCache = new Map<number, LogDetail>()
  const detailLoading = new Map<number, Promise<LogDetail | null>>()

  let cursor: { executedAt: number; id: number } | null = null
  let epoch = 0
  let currentTaskId: string | null = null
  let currentOutcome: LogOutcome | null = null
  /** 上一次查询的参数，供「重试」按钮重放。 */
  let lastQuery: { taskId: string; options: { reset?: boolean; older?: boolean; pageSize?: number } } | null =
    null

  function clear(): void {
    logs.value = []
    loading.value = false
    loadingOlder.value = false
    hasMore.value = false
    capped.value = false
    matchedTotal.value = 0
    cursor = null
    currentTaskId = null
    currentOutcome = null
    error.value = ''
    lastQuery = null
    epoch += 1
  }

  async function load(
    taskId: string | null,
    options: { reset?: boolean; older?: boolean; pageSize?: number } = {},
  ): Promise<void> {
    const { reset = false, older = false, pageSize = 50 } = options
    if (!taskId) {
      clear()
      return
    }
    const requestedOutcome = outcome.value
    lastQuery = { taskId, options: { reset, older, pageSize } }

    // 筛选状态下过滤发生在后端 SQL 层，一次就能把匹配记录取全，
    // 所以这里的上限和请求条数都要放大，不能再按页翻。
    const filtering = requestedOutcome !== 'all'
    const maxRows = filtering ? MAX_FILTERED_LOG_ROWS : MAX_LOG_ROWS

    // 重置换算一次代际；查询失败时**不动**现有数据，只记录 error，
    // 界面继续展示旧日志并提供「重试」，不会出现「失败 = 没有记录」的误导。
    const identityChanged = currentTaskId !== taskId || currentOutcome !== requestedOutcome
    const restarting = reset || identityChanged
    if (identityChanged) {
      logs.value = []
      cursor = null
      currentTaskId = taskId
      currentOutcome = requestedOutcome
    }
    if (restarting) {
      loading.value = false
      loadingOlder.value = false
      hasMore.value = false
      capped.value = false
      matchedTotal.value = 0
      epoch += 1
    }

    // 已经显示到上限就不再往回翻了：再翻也只是把新加载的记录挤掉，
    // 按钮点了没反应。直接告诉用户上限，并让他去「数据库」里看更早的。
    if (older && logs.value.length >= maxRows) {
      hasMore.value = false
      capped.value = true
      return
    }

    const myEpoch = epoch
    const requestCursor = restarting ? null : cursor
    if (older) loadingOlder.value = true
    else loading.value = true

    try {
      const data = await listLogs(taskId, {
        limit: filtering ? MAX_FILTERED_LOG_ROWS : pageSize,
        before: older && requestCursor ? `${requestCursor.executedAt}:${requestCursor.id}` : null,
        outcome: requestedOutcome,
      })
      if (myEpoch !== epoch) return
      error.value = ''
      if (restarting) {
        currentTaskId = taskId
        currentOutcome = requestedOutcome
      }

      const merged = new Map<number, LogSummary>()
      for (const row of restarting ? [] : logs.value) merged.set(row.id, row)
      for (const row of data.logs ?? []) merged.set(row.id, row)
      const sorted = [...merged.values()].sort(compareLogsDesc)
      // 超过上限时，被挤掉的是**更早**的记录（列表按新到旧排），
      // 所以"最新在最上面"的顺序不受影响。
      const overflow = sorted.length > maxRows
      logs.value = sorted.slice(0, maxRows)
      capped.value = overflow

      const oldest = logs.value[logs.value.length - 1]
      cursor = oldest ? { executedAt: oldest.executed_at, id: oldest.id } : null
      if (reset || older) hasMore.value = Boolean(data.has_more) && !overflow
      if (typeof data.retention_days === 'number') retentionDays.value = data.retention_days
      if (typeof data.matched_total === 'number') matchedTotal.value = data.matched_total
    } catch (cause) {
      if (myEpoch !== epoch) return
      const message = cause instanceof Error ? cause.message : String(cause)
      error.value = localizeBackendMessage(message)
    } finally {
      if (myEpoch === epoch) {
        loading.value = false
        loadingOlder.value = false
      }
    }
  }

  /** 用上一次查询的参数重放；给错误提示里的「重试」按钮用。 */
  async function retry(): Promise<void> {
    if (!lastQuery) return
    await load(lastQuery.taskId, lastQuery.options)
  }

  async function loadDetail(id: number): Promise<LogDetail | null> {
    const cached = detailCache.get(id)
    if (cached) return cached
    const pending = detailLoading.get(id)
    if (pending) return pending
    const request = (async () => {
      try {
        const data = await getLogDetail(id)
        if (data?.log) {
          detailCache.set(id, data.log)
          while (detailCache.size > 40) {
            const oldest = detailCache.keys().next().value
            if (oldest === undefined) break
            detailCache.delete(oldest)
          }
          return data.log
        }
        return null
      } finally {
        detailLoading.delete(id)
      }
    })()
    detailLoading.set(id, request)
    return request
  }

  return {
    logs,
    hasMore,
    capped,
    retentionDays,
    loading,
    loadingOlder,
    error,
    outcome,
    matchedTotal,
    maxRows,
    clear,
    load,
    retry,
    loadDetail,
  }
})
