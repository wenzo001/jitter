import { request, postJson } from './client'
import type { AppConfig, CleanupPreview, CleanupResult, HostEnvironment, Settings, SystemInfo } from '@/types/system'

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

export function setAutostart(enabled: boolean): Promise<{ ok: boolean; autostart: boolean }> {
  return postJson('/api/system/autostart', { enabled })
}

export function quitApp(): Promise<{ ok: boolean }> {
  return request('/api/quit', { method: 'POST' })
}

export function health(): Promise<{ ok: boolean; now: number }> {
  return request('/api/health', { timeoutMs: 3_000 })
}

export function cleanupPreview(): Promise<CleanupPreview> {
  return request('/api/logs/cleanup/preview')
}

export function cleanupLogs(body: unknown): Promise<CleanupResult> {
  return postJson('/api/logs/cleanup', body, 600_000)
}
