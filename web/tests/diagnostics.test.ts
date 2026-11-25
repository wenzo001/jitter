import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDiagnosticsStore } from '@/stores/diagnostics'
import { ApiError } from '@/api/client'
import type { HealthInfo } from '@/types/system'

const getHealth = vi.fn()

vi.mock('@/api/system', () => ({
  getHealth: (...args: unknown[]) => getHealth(...args),
}))

function healthOf(overrides: Partial<HealthInfo> = {}): HealthInfo {
  return {
    ok: true,
    now: Date.now(),
    version: '2.1.8',
    uptimeMs: 61_000,
    dbOk: true,
    dbPath: 'C:/data/app.db',
    logDir: 'C:/data/logs',
    lastError: null,
    ...overrides,
  }
}

describe('stores/diagnostics', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getHealth.mockReset()
  })

  it('健康检查正常时状态为 ok', async () => {
    getHealth.mockResolvedValue(healthOf())
    const diagnostics = useDiagnosticsStore()
    await diagnostics.checkHealth()
    expect(diagnostics.serviceState).toBe('ok')
    expect(diagnostics.health?.version).toBe('2.1.8')
  })

  it('数据库不可用时状态为 degraded', async () => {
    getHealth.mockResolvedValue(healthOf({ dbOk: false }))
    const diagnostics = useDiagnosticsStore()
    await diagnostics.checkHealth()
    expect(diagnostics.serviceState).toBe('degraded')
  })

  it('服务端有最近错误时状态为 degraded', async () => {
    getHealth.mockResolvedValue(
      healthOf({ lastError: { at: Date.now(), message: '数据库写入失败' } }),
    )
    const diagnostics = useDiagnosticsStore()
    await diagnostics.checkHealth()
    expect(diagnostics.serviceState).toBe('degraded')
    expect(diagnostics.health?.lastError?.message).toBe('数据库写入失败')
  })

  it('连续两次连接失败才判定后台无响应', async () => {
    getHealth.mockRejectedValue(new ApiError('连不上', 0, { kind: 'network' }))
    const diagnostics = useDiagnosticsStore()

    await diagnostics.checkHealth()
    expect(diagnostics.serviceState).not.toBe('down')

    await diagnostics.checkHealth()
    expect(diagnostics.serviceState).toBe('down')
    expect(diagnostics.guidance).toContain('Jitter')
  })

  it('捕获到的异常按时间倒序保留，并且带解决建议', () => {
    const diagnostics = useDiagnosticsStore()
    diagnostics.reportError('第一处', new Error('boom'))
    diagnostics.reportError('第二处', new ApiError('断了', 0, { kind: 'network', hint: '重启后台' }))

    expect(diagnostics.entries).toHaveLength(2)
    expect(diagnostics.entries[0].source).toBe('第二处')
    expect(diagnostics.entries[0].hint).toBe('重启后台')
    expect(diagnostics.latest?.source).toBe('第二处')
  })

  it('异常记录有上限，不会无限增长', () => {
    const diagnostics = useDiagnosticsStore()
    for (let i = 0; i < 100; i += 1) diagnostics.reportError(`第 ${i} 次`, new Error('x'))
    expect(diagnostics.entries.length).toBeLessThanOrEqual(60)
  })

  it('导出的诊断信息包含版本、路径与异常清单', async () => {
    getHealth.mockResolvedValue(healthOf())
    const diagnostics = useDiagnosticsStore()
    await diagnostics.checkHealth()
    diagnostics.reportError('测试', new Error('出错了'))

    const report = diagnostics.buildReport()
    expect(report).toContain('2.1.8')
    expect(report).toContain('C:/data/app.db')
    expect(report).toContain('C:/data/logs')
    expect(report).toContain('测试')
  })

  it('清空后异常列表为空', () => {
    const diagnostics = useDiagnosticsStore()
    diagnostics.reportError('x', new Error('y'))
    diagnostics.clearEntries()
    expect(diagnostics.entries).toHaveLength(0)
    expect(diagnostics.hasError).toBe(false)
  })

  it('开启轮询后会定时检查健康状态（后台挂掉时才能被发现）', async () => {
    vi.useFakeTimers()
    try {
      getHealth.mockResolvedValue(healthOf())
      const diagnostics = useDiagnosticsStore()
      diagnostics.startHealthPolling(3_000)

      // 开启时立即检查一次。
      await vi.advanceTimersByTimeAsync(0)
      expect(getHealth).toHaveBeenCalledTimes(1)

      // 之后按间隔继续检查。
      await vi.advanceTimersByTimeAsync(3_000)
      expect(getHealth).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(3_000)
      expect(getHealth).toHaveBeenCalledTimes(3)

      diagnostics.stopHealthPolling()
      await vi.advanceTimersByTimeAsync(6_000)
      expect(getHealth).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('轮询期间后台连续失败会切换到 down 并给出指引', async () => {
    vi.useFakeTimers()
    try {
      getHealth.mockRejectedValue(new ApiError('连不上', 0, { kind: 'network' }))
      const diagnostics = useDiagnosticsStore()
      diagnostics.startHealthPolling(3_000)

      await vi.advanceTimersByTimeAsync(0)
      expect(diagnostics.serviceState).not.toBe('down')

      await vi.advanceTimersByTimeAsync(3_000)
      expect(diagnostics.serviceState).toBe('down')
      expect(diagnostics.guidance).toContain('Jitter')

      diagnostics.stopHealthPolling()
    } finally {
      vi.useRealTimers()
    }
  })
})
