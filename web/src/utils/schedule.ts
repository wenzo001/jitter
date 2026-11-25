import type { Task } from '@/types/task'
import { zhTranslate, type TranslateFn } from '@/locales/current'
import { formatInterval, formatShortTime } from './format'

export type ScheduleKind = 'daily' | 'interval'

export function scheduleKindOf(task: Task): ScheduleKind {
  return task.schedule_kind === 'interval' ? 'interval' : 'daily'
}

export function isCrossMidnight(task: Task): boolean {
  return scheduleKindOf(task) === 'daily' && task.window_end < task.window_start
}

/** 时间窗口：09:00–18:00（跨午夜）。 */
export function formatWindow(task: Task, t: TranslateFn = zhTranslate): string {
  const cross = task.window_end < task.window_start
  return `${task.window_start}–${task.window_end}${cross ? t('schedule.crossMidnight') : ''}`
}

/**
 * 任务卡 / 日志标题用的简短调度描述（优先使用服务端描述）。
 *
 * 服务端给出的 `schedule_description` 是后端数据，原样展示，不做翻译。
 */
export function formatSchedule(task: Task, t: TranslateFn = zhTranslate): string {
  if (task.schedule_description) return task.schedule_description
  if (scheduleKindOf(task) === 'interval') {
    const base = t('schedule.every', { value: formatInterval(task.interval_seconds ?? 0, t) })
    const anchor = task.interval_start_at
      ? t('schedule.fromTime', { time: formatShortTime(task.interval_start_at) })
      : ''
    const jitter =
      task.interval_jitter_seconds > 0
        ? t('schedule.randomJitter', { seconds: task.interval_jitter_seconds })
        : ''
    return `${base}${anchor}${jitter}`
  }
  if (task.window_start === task.window_end) {
    const jitter = task.daily_jitter_minutes ?? 0
    return jitter > 0
      ? t('schedule.dailyJitter', { time: task.window_start, minutes: jitter })
      : t('schedule.daily', { time: task.window_start })
  }
  return t('schedule.dailyWindow', { window: formatWindow(task, t) })
}
