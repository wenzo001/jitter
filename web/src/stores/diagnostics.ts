import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useIntervalFn, type UseIntervalFnReturn } from '@vueuse/core'
import { getHealth } from '@/api/system'
import { describeError } from '@/api/client'
import { translate } from '@/locales/current'
import type { HealthInfo } from '@/types/system'

/** 服务状态：正常 / 可用但有异常 / 完全连不上。 */
export type ServiceState = 'unknown' | 'ok' | 'degraded' | 'down'

/** 一次前端捕获到的异常。 */
export interface DiagnosticEntry {
  id: number
  /** 发生时间戳（毫秒）。 */
  at: number
  /** 出问题的位置说明。 */
  source: string
  message: string
  /** 解决建议。 */
  hint: string
  stack: string
}

const MAX_ENTRIES = 60
const HEALTH_INTERVAL_MS = 15_000
/** 连续失败多少次才判定为「后台没响应」。 */
const DOWN_THRESHOLD = 2

export const useDiagnosticsStore = defineStore('diagnostics', () => {
  const health = ref<HealthInfo | null>(null)
  const serviceState = ref<ServiceState>('unknown')
  const checking = ref(false)
  const entries = ref<DiagnosticEntry[]>([])
  const lastCheckedAt = ref(0)

  let failures = 0
  let healthTimer: UseIntervalFnReturn | undefined
  let nextId = 1

  const hasError = computed(() => entries.value.length > 0)

  /** 最近一条异常（诊断面板顶部展示）。 */
  const latest = computed(() => entries.value[0] ?? null)

  /** 服务状态的可读文案。 */
  const stateLabel = computed(() => {
    switch (serviceState.value) {
      case 'ok':
        return translate('diagnostics.stateOk')
      case 'degraded':
        return translate('diagnostics.stateDegraded')
      case 'down':
        return translate('diagnostics.stateDown')
      default:
        return translate('diagnostics.stateUnknown')
    }
  })

  /** 面向用户的下一步指引。 */
  const guidance = computed(() => {
    switch (serviceState.value) {
      case 'down':
        return translate('diagnostics.guidanceDown')
      case 'degraded':
        return translate('diagnostics.guidanceDegraded')
      case 'ok':
        return ''
      default:
        return ''
    }
  })

  function reportError(source: string, error: unknown): DiagnosticEntry {
    const described = describeError(error)
    const entry: DiagnosticEntry = {
      id: nextId,
      at: Date.now(),
      source,
      message: described.message,
      hint: described.hint,
      stack: error instanceof Error ? (error.stack ?? '') : '',
    }
    nextId += 1
    entries.value = [entry, ...entries.value].slice(0, MAX_ENTRIES)
    return entry
  }

  function clearEntries(): void {
    entries.value = []
  }

  /** 主动检测后台状态。 */
  async function checkHealth(): Promise<ServiceState> {
    checking.value = true
    try {
      const data = await getHealth()
      health.value = data
      failures = 0
      lastCheckedAt.value = Date.now()
      if (data.dbOk === false) {
        serviceState.value = 'degraded'
      } else if (data.lastError) {
        serviceState.value = 'degraded'
      } else {
        serviceState.value = 'ok'
      }
    } catch (error) {
      failures += 1
      lastCheckedAt.value = Date.now()
      if (failures >= DOWN_THRESHOLD) {
        serviceState.value = 'down'
        health.value = null
      }
      reportError(translate('diagnostics.sourceHealthCheckFailed'), error)
    } finally {
      checking.value = false
    }
    return serviceState.value
  }

  function startHealthPolling(intervalMs = HEALTH_INTERVAL_MS): void {
    stopHealthPolling()
    void checkHealth()
    // vueuse 的定时器：组件卸载时自动清理。
    // 注意 useIntervalFn 的 immediate 默认为 true，定时器会立刻开始跑；
    // 写成 false 的话定时器根本不会启动，「后台没响应」就永远检测不出来。
    healthTimer = useIntervalFn(
      () => void checkHealth(),
      Math.max(3_000, intervalMs),
    )
  }

  function stopHealthPolling(): void {
    healthTimer?.pause()
    healthTimer = undefined
  }

  /** 导出诊断信息：用户可以直接复制发给维护者。 */
  function buildReport(): string {
    const lines: string[] = []
    lines.push(translate('diagnostics.reportTitle'))
    lines.push(translate('diagnostics.reportGeneratedAt', { time: new Date().toLocaleString() }))
    lines.push(translate('diagnostics.reportState', { state: stateLabel.value }))
    if (health.value) {
      lines.push(translate('diagnostics.reportVersion', { value: health.value.version }))
      lines.push(
        translate('diagnostics.reportUptime', { value: Math.round(health.value.uptimeMs / 1000) }),
      )
      lines.push(translate('diagnostics.reportDatabase', { value: health.value.dbPath }))
      lines.push(
        translate('diagnostics.reportDatabaseReadable', {
          value: health.value.dbOk ? translate('common.yes') : translate('common.no'),
        }),
      )
      lines.push(translate('diagnostics.reportLogDir', { value: health.value.logDir }))
      if (health.value.lastError) {
        lines.push(
          translate('diagnostics.reportLastError', {
            time: new Date(health.value.lastError.at).toLocaleString(),
            message: health.value.lastError.message,
          }),
        )
      }
    } else {
      lines.push(translate('diagnostics.reportNoHealth'))
    }
    lines.push(translate('diagnostics.reportUserAgent', { value: navigator.userAgent }))
    if (entries.value.length) {
      lines.push(translate('diagnostics.reportEntriesTitle'))
      for (const entry of entries.value) {
        lines.push(
          translate('diagnostics.reportEntry', {
            time: new Date(entry.at).toLocaleTimeString(),
            source: entry.source,
            message: entry.message,
          }),
        )
        if (entry.hint) lines.push(translate('diagnostics.reportHint', { hint: entry.hint }))
        // 调用栈一起带上：用户把诊断信息发出来时，维护者能直接定位到代码位置。
        if (entry.stack) {
          for (const line of entry.stack.split('\n').slice(0, 12)) {
            lines.push(`  ${line.trim()}`)
          }
        }
      }
    } else {
      lines.push(translate('diagnostics.reportNoEntries'))
    }
    return lines.join('\n')
  }

  return {
    health,
    serviceState,
    checking,
    entries,
    lastCheckedAt,
    hasError,
    latest,
    stateLabel,
    guidance,
    reportError,
    clearEntries,
    checkHealth,
    startHealthPolling,
    stopHealthPolling,
    buildReport,
  }
})
