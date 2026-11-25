import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getLogDetail, listLogs } from '@/api/tasks'
import type { LogDetail, LogSummary } from '@/types/task'

const MAX_LOG_ROWS = 300

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
  /** 已经到「最多显示 N 条」的上限，更早的记录不再继续加载。 */
  const capped = ref(false)

  const detailCache = new Map<number, LogDetail>()
  const detailLoading = new Set<number>()

  let cursor: { executedAt: number; id: number } | null = null
  let epoch = 0
  let currentTaskId: string | null = null

  function clear(): void {
    logs.value = []
    hasMore.value = false
    capped.value = false
    cursor = null
    currentTaskId = null
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

    if (reset || currentTaskId !== taskId) {
      logs.value = []
      hasMore.value = false
      capped.value = false
      cursor = null
      currentTaskId = taskId
      epoch += 1
    }

    // 已经显示到上限就不再往回翻了：再翻也只是把新加载的记录挤掉，
    // 按钮点了没反应。直接告诉用户上限，并让他去「数据库」里看更早的。
    if (older && logs.value.length >= MAX_LOG_ROWS) {
      hasMore.value = false
      capped.value = true
      return
    }

    const myEpoch = epoch
    if (older) loadingOlder.value = true
    else loading.value = true

    try {
      const data = await listLogs(taskId, {
        limit: pageSize,
        before: older && cursor ? `${cursor.executedAt}:${cursor.id}` : null,
      })
      if (myEpoch !== epoch) return

      const merged = new Map<number, LogSummary>()
      for (const row of logs.value) merged.set(row.id, row)
      for (const row of data.logs ?? []) merged.set(row.id, row)
      const sorted = [...merged.values()].sort(compareLogsDesc)
      // 超过上限时，被挤掉的是**更早**的记录（列表按新到旧排），
      // 所以"最新在最上面"的顺序不受影响。
      const overflow = sorted.length > MAX_LOG_ROWS
      logs.value = sorted.slice(0, MAX_LOG_ROWS)
      capped.value = overflow

      const oldest = logs.value[logs.value.length - 1]
      cursor = oldest ? { executedAt: oldest.executed_at, id: oldest.id } : null
      if (reset || older) hasMore.value = Boolean(data.has_more) && !overflow
      if (typeof data.retention_days === 'number') retentionDays.value = data.retention_days
    } finally {
      if (myEpoch === epoch) {
        loading.value = false
        loadingOlder.value = false
      }
    }
  }

  async function loadDetail(id: number): Promise<LogDetail | null> {
    const cached = detailCache.get(id)
    if (cached) return cached
    if (detailLoading.has(id)) return null
    detailLoading.add(id)
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
  }

  return {
    logs,
    hasMore,
    capped,
    retentionDays,
    loading,
    loadingOlder,
    clear,
    load,
    loadDetail,
  }
})
