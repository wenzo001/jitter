import { request, postJson } from './client'
import type {
  AppConfig,
  CleanupPreview,
  CleanupResult,
  HealthInfo,
  HolidayMonthResponse,
  HolidayStatus,
  HostEnvironment,
  LogFileChunk,
  LogFilesResponse,
  Settings,
  SystemInfo,
} from '@/types/system'

export function getConfig(): Promise<AppConfig> {
  return request('/api/config')
}

export function getSettings(): Promise<Settings> {
  return request('/api/settings')
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return postJson('/api/settings', patch)
}

export function getSystemInfo(): Promise<SystemInfo> {
  return request('/api/system', { timeoutMs: 5_000 })
}

export function getEnvironment(): Promise<HostEnvironment> {
  return request('/api/system/environment', { timeoutMs: 5_000 })
}

export function getHolidayStatus(): Promise<HolidayStatus> {
  return request('/api/system/holiday', { timeoutMs: 8_000 })
}

/** 手动拉取节假日数据（去年 / 今年 / 明年三年，成功的覆盖本地）。 */
export function refreshHolidayStatus(): Promise<HolidayStatus> {
  return postJson('/api/system/holiday/refresh', {}, 90_000)
}

/** 某年某月的逐日归类（日历面板：工作日 / 休息日 / 法定节假日 / 调休）。 */
export function getHolidayMonth(year: number, month: number): Promise<HolidayMonthResponse> {
  return request(`/api/system/holiday/month?year=${year}&month=${month}`, { timeoutMs: 8_000 })
}

export function setAutostart(enabled: boolean): Promise<{ ok: boolean; autostart: boolean }> {
  return postJson('/api/system/autostart', { enabled })
}

export function quitApp(): Promise<{ ok: boolean }> {
  return request('/api/quit', { method: 'POST' })
}

export function health(): Promise<{ ok: boolean; now: number }> {
  return request('/api/health', { timeoutMs: 3_000 })
}

/** 详细健康检查：版本、运行时长、数据库与日志路径、最近一次错误。 */
export function getHealth(): Promise<HealthInfo> {
  return request('/api/health', { timeoutMs: 5_000 })
}

/** 运行日志文件列表。 */
export function listRuntimeLogs(): Promise<LogFilesResponse> {
  return request('/api/system/logs', { timeoutMs: 8_000 })
}

/** 读取某个运行日志的一段内容（大文件按字节偏移分页）。 */
export function readRuntimeLog(name: string, offset = 0, limit = 64 * 1024): Promise<LogFileChunk> {
  return request(
    `/api/system/logs/${encodeURIComponent(name)}?offset=${offset}&limit=${limit}`,
    { timeoutMs: 15_000 },
  )
}

export function cleanupPreview(): Promise<CleanupPreview> {
  return request('/api/logs/cleanup/preview')
}

export function cleanupLogs(body: unknown): Promise<CleanupResult> {
  return postJson('/api/logs/cleanup', body, 600_000)
}
