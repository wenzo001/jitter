import type { Task } from '@/types/task'
import { formatInterval, formatShortTime } from './format'

export type ScheduleKind = 'daily' | 'interval'

export function scheduleKindOf(task: Task): ScheduleKind {
  return task.schedule_kind === 'interval' ? 'interval' : 'daily'
}

export function isCrossMidnight(task: Task): boolean {
  return scheduleKindOf(task) === 'daily' && task.window_end < task.window_start
}

export function formatWindow(task: Task): string {
  const cross = task.window_end < task.window_start
  return `${task.window_start}–${task.window_end}${cross ? '（跨午夜）' : ''}`
}

/** 任务卡 / 日志标题用的简短调度描述（优先使用服务端描述）。 */
export function formatSchedule(task: Task): string {
  if (task.schedule_description) return task.schedule_description
  if (scheduleKindOf(task) === 'interval') {
    const base = `每 ${formatInterval(task.interval_seconds ?? 0)}`
    const anchor = task.interval_start_at
      ? `（从 ${formatShortTime(task.interval_start_at)} 起算）`
      : ''
    const jitter =
      task.interval_jitter_seconds > 0 ? `，随机 +0–${task.interval_jitter_seconds}s` : ''
    return `${base}${anchor}${jitter}`
  }
  if (task.window_start === task.window_end) {
    const jitter = task.daily_jitter_minutes ?? 0
    return jitter > 0 ? `每天 ${task.window_start} ±${jitter} 分钟` : `每天 ${task.window_start}`
  }
  return `每天 ${formatWindow(task)}`
}
