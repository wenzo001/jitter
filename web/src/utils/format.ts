import { zhTranslate, type TranslateFn } from '@/locales/current'

export function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function hhmm(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTime(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return '—'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatShortTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

export function formatClockSecond(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

/** epoch ms → `<input type="datetime-local">` 的本地值。 */
export function toDateTimeLocal(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** `datetime-local` 值 → epoch ms；空/非法返回 null。 */
export function fromDateTimeLocal(value: string): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp)
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === new Date().getFullYear()
    ? monthDay
    : `${date.getFullYear()}-${monthDay}`
}

/** 暂停区间 [paused_from, paused_until)；started=false 表示明天起算。 */
export function pauseStateOf(
  task: { paused_from: number | null; paused_until: number | null },
  now = Date.now(),
): { from: number; until: number; started: boolean } | null {
  const until = task.paused_until
  if (until === null || until === undefined || until <= now) return null
  const from = task.paused_from ?? now
  return { from, until, started: from <= now }
}

export function calendarDays(from: number, until: number): number {
  const a = new Date(from)
  a.setHours(0, 0, 0, 0)
  const b = new Date(until)
  b.setHours(0, 0, 0, 0)
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000))
}

/**
 * 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 09:30 / 2026-10-01。
 *
 * 翻译函数可选：默认按中文输出（保持既有行为），组件里传入当前语言的翻译函数即可。
 */
export function formatRelative(
  timestamp: number | null | undefined,
  now = Date.now(),
  t: TranslateFn = zhTranslate,
): string {
  if (timestamp === null || timestamp === undefined) return '—'
  const diff = now - timestamp
  if (diff < 0) return formatTime(timestamp)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('relative.justNow')
  if (minutes < 60) return t('relative.minutesAgo', { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('relative.hoursAgo', { hours })
  const days = Math.floor(hours / 24)
  if (days === 1) return t('relative.yesterday', { time: formatTime(timestamp).slice(11, 16) })
  if (days < 30) return t('relative.daysAgo', { days })
  return formatTime(timestamp)
}

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const text =
    unit === 0 ? String(Math.round(size)) : size >= 100 ? size.toFixed(0) : size.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 间隔描述：2 天 / 3 小时 / 15 分钟 / 45 秒。 */
export function formatInterval(seconds: number, t: TranslateFn = zhTranslate): string {
  const value = Number(seconds) || 0
  if (value > 0 && value % 86400 === 0) return t('duration.days', { value: value / 86400 })
  if (value > 0 && value % 3600 === 0) return t('duration.hours', { value: value / 3600 })
  if (value > 0 && value % 60 === 0) return t('duration.minutes', { value: value / 60 })
  return t('duration.seconds', { value })
}

export function formatTimeout(ms: number | null | undefined): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const seconds = value / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}

/** 执行中的耗时：45 秒 / 3 分 12 秒 / 2 小时 5 分。 */
export function formatElapsed(ms: number, t: TranslateFn = zhTranslate): string {
  const value = Math.max(0, Number(ms) || 0)
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return t('duration.seconds', { value: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('duration.minutesSeconds', { minutes, seconds: seconds % 60 })
  const hours = Math.floor(minutes / 60)
  return t('duration.hoursMinutes', { hours, minutes: minutes % 60 })
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

export function prettyJson(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
