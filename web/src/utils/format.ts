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

export function formatInterval(seconds: number): string {
  const value = Number(seconds) || 0
  if (value > 0 && value % 86400 === 0) return `${value / 86400} 天`
  if (value > 0 && value % 3600 === 0) return `${value / 3600} 小时`
  if (value > 0 && value % 60 === 0) return `${value / 60} 分钟`
  return `${value} 秒`
}

export function formatTimeout(ms: number | null | undefined): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return ''
  const seconds = value / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}

/** 执行中的耗时：45 秒 / 3 分 12 秒 / 2 小时 5 分。 */
export function formatElapsed(ms: number): string {
  const value = Math.max(0, Number(ms) || 0)
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
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
