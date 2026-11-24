import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getConfig, getEnvironment, getSystemInfo } from '@/api/system'
import { getMetrics } from '@/api/metrics'
import type {
  AppConfig,
  HostEnvironment,
  MetricsReport,
  SystemInfo,
} from '@/types/system'

const CONFIG_DEFAULTS: AppConfig = {
  logsPageSize: 50,
  defaultWindowMinutes: 5,
  pollIntervalMs: 4000,
  logBodyLimitBytes: 100 * 1024,
  requestTimeoutMs: 30_000,
  logRetentionDays: 30,
}

const UPGRADE_PENDING_KEY = 'jitter-upgrade-pending'

interface UpgradePending {
  from: string
  expected: string | null
  at: number
}

function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const strip = (value?: string | null) => String(value ?? '').trim().replace(/^v/i, '')
  return strip(a) === strip(b)
}

function versionLabel(version?: string | null): string {
  const text = String(version ?? '').trim()
  if (!text) return 'v?'
  return text.startsWith('v') ? text : `v${text}`
}

function readPending(): UpgradePending | null {
  try {
    const raw = localStorage.getItem(UPGRADE_PENDING_KEY)
    return raw ? (JSON.parse(raw) as UpgradePending) : null
  } catch {
    return null
  }
}

function writePending(value: UpgradePending | null): void {
  try {
    if (value) localStorage.setItem(UPGRADE_PENDING_KEY, JSON.stringify(value))
    else localStorage.removeItem(UPGRADE_PENDING_KEY)
  } catch {
    // 隐私模式下只在本页生效
  }
}

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig>({ ...CONFIG_DEFAULTS })
  const system = ref<SystemInfo | null>(null)
  const metrics = ref<MetricsReport | null>(null)
  const environment = ref<HostEnvironment | null>(null)

  /** 顶栏状态行：短暂成功提示或持续错误提示。 */
  const status = ref({ text: '就绪', error: false })
  let statusTimer: number | undefined

  /** 升级结果横幅（刷新后仍保留，直到用户关闭）。 */
  const banner = ref<{ kind: 'success' | 'error'; text: string } | null>(null)

  const version = computed(() => system.value?.version ?? '')

  function setStatus(text: string, error = false): void {
    status.value = { text, error }
    window.clearTimeout(statusTimer)
    if (!error) {
      statusTimer = window.setTimeout(() => {
        status.value = { text: '就绪', error: false }
      }, 5000)
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const data = await getConfig()
      config.value = { ...CONFIG_DEFAULTS, ...(data ?? {}) }
    } catch {
      config.value = { ...CONFIG_DEFAULTS }
    }
  }

  async function loadSystem(): Promise<SystemInfo | null> {
    try {
      system.value = await getSystemInfo()
      settleUpgradeBanner()
      return system.value
    } catch {
      return null
    }
  }

  async function refreshMetrics(): Promise<void> {
    try {
      metrics.value = await getMetrics()
    } catch {
      // 统计是装饰性的：失败时保留上一次数据
    }
  }

  async function loadEnvironment(refresh = false): Promise<HostEnvironment | null> {
    if (environment.value && !refresh) return environment.value
    try {
      environment.value = await getEnvironment()
    } catch {
      environment.value = null
    }
    return environment.value
  }

  /** 页面加载时收尾「升级中/已完成」的记录。 */
  function settleUpgradeBanner(): void {
    const pending = readPending()
    const current = system.value?.version
    if (!pending || !current) return
    if (pending.expected && sameVersion(current, pending.expected)) {
      banner.value = {
        kind: 'success',
        text: `升级成功：已从 ${versionLabel(pending.from)} 升级到 ${versionLabel(current)}，页面数据已同步。`,
      }
      return
    }
    if (pending.expected && !sameVersion(current, pending.expected)) {
      banner.value = {
        kind: 'error',
        text: `升级未完成：当前仍是 ${versionLabel(current)}（目标是 ${versionLabel(
          pending.expected,
        )}）。请在「设置 → 检查更新」里重试。`,
      }
    }
  }

  function dismissBanner(): void {
    banner.value = null
    writePending(null)
  }

  return {
    config,
    system,
    metrics,
    environment,
    status,
    banner,
    version,
    setStatus,
    loadConfig,
    loadSystem,
    refreshMetrics,
    loadEnvironment,
    settleUpgradeBanner,
    dismissBanner,
    sameVersion,
    versionLabel,
    readPending,
    writePending,
  }
})
