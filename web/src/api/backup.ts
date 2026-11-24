import { request, postJson } from './client'
import type { BackupListResponse, UpdateInfo, UpdateProgress } from '@/types/system'

export function listBackups(): Promise<BackupListResponse> {
  return request('/api/backup/list')
}

export function createBackup(): Promise<{ ok: boolean }> {
  return request('/api/backup', { method: 'POST', timeoutMs: 120_000 })
}

export function deleteBackup(name: string): Promise<{ ok: boolean }> {
  return postJson('/api/backup/delete', { name })
}

export function backupDownloadUrl(name: string): string {
  return `/api/backup/download?name=${encodeURIComponent(name)}`
}

export async function uploadBackup(file: File): Promise<{ ok: boolean }> {
  return request(`/api/backup/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream' },
    timeoutMs: 300_000,
  })
}

export function restoreBackup(name: string): Promise<{ ok: boolean; restarting?: boolean }> {
  return postJson('/api/backup/restore', { name }, 120_000)
}

export function checkUpdate(): Promise<UpdateInfo> {
  return request('/api/update/check', { timeoutMs: 30_000 })
}

export function getUpdateProgress(): Promise<UpdateProgress> {
  return request('/api/update/progress', { timeoutMs: 3_000 })
}

export function applyUpdate(): Promise<{ ok: boolean; message: string }> {
  return postJson('/api/update/apply', { confirm: true }, 300_000)
}
