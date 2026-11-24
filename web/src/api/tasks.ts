import { request, postJson } from './client'
import type {
  LogDetailResponse,
  LogsResponse,
  RunResult,
  SchedulePreviewRequest,
  SchedulePreviewResponse,
  TaskPayload,
  TaskResponse,
  TasksResponse,
} from '@/types/task'

export function listTasks(): Promise<TasksResponse> {
  return request('/api/tasks')
}

export function getTask(id: string): Promise<TaskResponse> {
  return request(`/api/tasks/${encodeURIComponent(id)}`)
}

export function createTask(payload: TaskPayload): Promise<TaskResponse> {
  return postJson('/api/tasks', payload)
}

export function updateTask(id: string, payload: TaskPayload): Promise<TaskResponse> {
  return request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteTask(id: string): Promise<{ ok: boolean; deleted_logs: number }> {
  return request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function runTask(id: string): Promise<RunResult> {
  return request(`/api/tasks/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    timeoutMs: 60_000,
  })
}

export function stopTask(id: string): Promise<TaskResponse> {
  return request(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}

export function startTask(id: string): Promise<TaskResponse> {
  return request(`/api/tasks/${encodeURIComponent(id)}/start`, { method: 'POST' })
}

export function pauseTask(id: string, days: number, startsToday: boolean): Promise<TaskResponse> {
  return postJson(`/api/tasks/${encodeURIComponent(id)}/pause`, {
    days,
    starts_today: startsToday,
  })
}

export function resumeTask(id: string): Promise<TaskResponse> {
  return request(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
}

export function reorderTasks(ids: string[]): Promise<TasksResponse> {
  return postJson('/api/tasks/reorder', { ids })
}

export function listLogs(
  taskId: string,
  params: { limit?: number; before?: string | null } = {},
): Promise<LogsResponse> {
  const search = new URLSearchParams()
  if (params.limit) search.set('limit', String(params.limit))
  if (params.before) search.set('before', params.before)
  const suffix = search.toString()
  return request(`/api/tasks/${encodeURIComponent(taskId)}/logs${suffix ? `?${suffix}` : ''}`)
}

export function getLogDetail(id: number): Promise<LogDetailResponse> {
  return request(`/api/logs/${id}`)
}

export function previewSchedule(payload: SchedulePreviewRequest): Promise<SchedulePreviewResponse> {
  return postJson('/api/schedule/preview', payload)
}
