import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useStorage, useTimeoutFn } from '@vueuse/core'
import {
  getConfig,
  getEnvironment,
  getHolidayStatus,
  getSystemInfo,
  refreshHolidayStatus,
} from '@/api/system'
import { getMetrics } from '@/api/metrics'
import { translate } from '@/locales/current'
import type {
  AppConfig,
  HolidayStatus,
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

/**
 * 升级中的记录（localStorage）。
 * 用 vueuse 的 useStorage：隐私模式写不进去、跨标签页同步都由它兜底。
 */
const pendingStorage = useStorage<UpgradePending | null>(
  UPGRADE_PENDING_KEY,
  null,
  undefined,
  {
    serializer: {
      read: (raw: string) => {
        try {
          return raw ? (JSON.parse(raw) as UpgradePending) : null
        } catch {
          return null
        }
      },
      write: (value: UpgradePending | null) => (value ? JSON.stringify(value) : ''),
    },
    onError: () => {
      // 隐私模式：只在本次会话生效。
    },
  },
)

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig>({ ...CONFIG_DEFAULTS })
  const system = ref<SystemInfo | null>(null)
  const metrics = ref<MetricsReport | null>(null)
  const environment = ref<HostEnvironment | null>(null)
  /** 节假日数据状态：决定「工作日 / 休息日」条件是否可选。 */
  const holiday = ref<HolidayStatus | null>(null)

  /** 顶栏状态行：短暂成功提示或持续错误提示。null 表示回到「就绪」。 */
  const statusState = ref<{ text: string; error: boolean } | null>(null)
  const statusTimer = useTimeoutFn(
    () => {
      statusState.value = null
    },
    5000,
    { immediate: false },
  )

  /** 升级结果横幅（刷新后仍保留，直到用户关闭）。 */
  const bannerState = ref<{
    kind: 'success' | 'error'
    key: string
    named?: Record<string, unknown>
  } | null>(null)

  const version = computed(() => system.value?.version ?? '')

  /** 当前实例名（`prod` / `dev` / …）。非默认实例在顶栏显示一个醒目的标记。 */
  const instance = computed(() => system.value?.instance ?? 'prod')

  /** 是否是默认（生产）实例。 */
  const isDefaultInstance = computed(() => system.value?.default_instance ?? true)

  /** 状态行文案；语言切换后「就绪」也会跟着变。 */
  const status = computed(() =>
    statusState.value ?? { text: translate('status.ready'), error: false },
  )

  /** 横幅文案；由 locale key 渲染，语言切换后同步更新。 */
  const banner = computed(() =>
    bannerState.value
      ? {
          kind: bannerState.value.kind,
          text: translate(bannerState.value.key, bannerState.value.named),
        }
      : null,
  )

  function setStatus(text: string, error = false): void {
    statusState.value = { text, error }
    if (!error) {
      // 5 秒后自动回到「就绪」。
      statusTimer.start()
    } else {
      statusTimer.stop()
    }
  }

  /** 设置横幅：只给 locale key，文字在渲染时按当前语言生成。 */
  function setBanner(
    kind: 'success' | 'error',
    key: string,
    named?: Record<string, unknown>,
  ): void {
    bannerState.value = { kind, key, named }
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

  async function loadHoliday(): Promise<HolidayStatus | null> {
    try {
      holiday.value = await getHolidayStatus()
    } catch {
      holiday.value = null
    }
    return holiday.value
  }

  /** 手动拉取节假日数据（设置页按钮）。失败静默返回 null。 */
  async function refreshHoliday(): Promise<HolidayStatus | null> {
    try {
      holiday.value = await refreshHolidayStatus()
    } catch {
      return null
    }
    return holiday.value
  }

  /** 页面加载时收尾「升级中/已完成」的记录。 */
  function settleUpgradeBanner(): void {
    const pending = pendingStorage.value
    const current = system.value?.version
    if (!pending || !current) return
    if (pending.expected && sameVersion(current, pending.expected)) {
      setBanner('success', 'app.upgradeSuccessBanner', {
        from: versionLabel(pending.from),
        to: versionLabel(current),
      })
      return
    }
    if (pending.expected && !sameVersion(current, pending.expected)) {
      setBanner('error', 'app.upgradeFailedBanner', {
        current: versionLabel(current),
        target: versionLabel(pending.expected),
      })
    }
  }

  function dismissBanner(): void {
    bannerState.value = null
    pendingStorage.value = null
  }

  return {
    config,
    system,
    metrics,
    environment,
    holiday,
    status,
    banner,
    version,
    instance,
    isDefaultInstance,
    setStatus,
    setBanner,
    loadConfig,
    loadSystem,
    refreshMetrics,
    loadEnvironment,
    loadHoliday,
    refreshHoliday,
    settleUpgradeBanner,
    dismissBanner,
    sameVersion,
    versionLabel,
    readPending: () => pendingStorage.value,
    writePending: (value: UpgradePending | null) => {
      pendingStorage.value = value
    },
  }
})
