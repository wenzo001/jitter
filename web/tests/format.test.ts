import { describe, expect, it } from 'vitest'
import {
  calendarDays,
  formatBytes,
  formatDuration,
  formatElapsed,
  formatInterval,
  formatRate,
  formatRelative,
  formatTime,
  formatTimeout,
  fromDateTimeLocal,
  pauseStateOf,
  prettyJson,
  toDateTimeLocal,
} from '@/utils/format'
import { formatSchedule, formatWindow, isCrossMidnight, scheduleKindOf } from '@/utils/schedule'
import type { Task } from '@/types/task'

describe('utils/format', () => {
  it('formatTime 对空值返回占位符', () => {
    expect(formatTime(null)).toBe('—')
    expect(formatTime(undefined)).toBe('—')
  })

  it('formatRelative 按时间差给出不同措辞', () => {
    const now = new Date('2026-11-25T12:00:00').getTime()
    expect(formatRelative(now - 30_000, now)).toBe('刚刚')
    expect(formatRelative(now - 12 * 60_000, now)).toBe('12 分钟前')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelative(now - 26 * 3_600_000, now)).toContain('昨天')
    expect(formatRelative(now - 5 * 86_400_000, now)).toBe('5 天前')
    // 未来时间直接显示绝对时间
    expect(formatRelative(now + 60_000, now)).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('formatRelative 对空值返回占位符', () => {
    expect(formatRelative(null)).toBe('—')
  })

  it('formatBytes 处理非法与边界值', () => {
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB')
  })

  it('formatInterval 按整除关系选择单位', () => {
    expect(formatInterval(45)).toBe('45 秒')
    expect(formatInterval(120)).toBe('2 分钟')
    expect(formatInterval(7200)).toBe('2 小时')
    expect(formatInterval(172800)).toBe('2 天')
  })

  it('formatTimeout 只在有效时输出', () => {
    expect(formatTimeout(0)).toBe('')
    expect(formatTimeout(null)).toBe('')
    expect(formatTimeout(30000)).toBe('30s')
    expect(formatTimeout(1500)).toBe('1.5s')
  })

  it('formatElapsed 换算成秒 / 分 / 小时', () => {
    expect(formatElapsed(45_000)).toBe('45 秒')
    expect(formatElapsed(192_000)).toBe('3 分 12 秒')
    expect(formatElapsed(7_500_000)).toBe('2 小时 5 分')
    expect(formatElapsed(-5)).toBe('0 秒')
  })

  it('formatRate 与 formatDuration 处理空值', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0.5)).toBe('50%')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(250)).toBe('250 ms')
    expect(formatDuration(1500)).toBe('1.50 s')
  })

  it('prettyJson 遇到非法 JSON 原样返回', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('不是 JSON')).toBe('不是 JSON')
    expect(prettyJson('')).toBe('')
  })

  it('datetime-local 双向转换可往返', () => {
    const stamp = new Date('2026-11-25T09:30:00').getTime()
    const local = toDateTimeLocal(stamp)
    expect(local).toBe('2026-11-25T09:30')
    expect(fromDateTimeLocal(local)).toBe(stamp)
    expect(fromDateTimeLocal('')).toBeNull()
    expect(fromDateTimeLocal('乱写')).toBeNull()
  })

  it('pauseStateOf 判断暂停区间', () => {
    const now = new Date('2026-11-25T12:00:00').getTime()
    expect(pauseStateOf({ paused_from: now - 1000, paused_until: now + 1000 }, now)).toEqual({
      from: now - 1000,
      until: now + 1000,
      started: true,
    })
    expect(pauseStateOf({ paused_from: now, paused_until: now + 1000 }, now)?.started).toBe(true)
    expect(pauseStateOf({ paused_from: null, paused_until: null }, now)).toBeNull()
    expect(pauseStateOf({ paused_from: now, paused_until: now - 1 }, now)).toBeNull()
  })

  it('calendarDays 至少为 1 天', () => {
    const now = new Date('2026-11-25T12:00:00').getTime()
    expect(calendarDays(now, now)).toBe(1)
    expect(calendarDays(now, now + 86400000)).toBe(1)
    expect(calendarDays(now, now + 3 * 86400000)).toBe(3)
  })
})

function taskOf(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    name: '测试',
    status: 'active',
    schedule_kind: 'daily',
    window_start: '09:00',
    window_end: '18:00',
    daily_jitter_minutes: 0,
    interval_seconds: null,
    interval_start_at: null,
    interval_jitter_seconds: 0,
    schedule_description: null,
    ...overrides,
  } as Task
}

describe('utils/schedule', () => {
  it('默认按每天窗口处理', () => {
    const task = taskOf({})
    expect(scheduleKindOf(task)).toBe('daily')
    expect(isCrossMidnight(task)).toBe(false)
    expect(formatWindow(task)).toBe('09:00–18:00')
  })

  it('跨午夜窗口会被标出来', () => {
    const task = taskOf({ window_start: '22:00', window_end: '06:00' })
    expect(isCrossMidnight(task)).toBe(true)
    expect(formatWindow(task)).toContain('跨午夜')
  })

  it('优先使用服务端给的描述', () => {
    const task = taskOf({ schedule_description: '每天 10:00（节假日也执行）' })
    expect(formatSchedule(task)).toBe('每天 10:00（节假日也执行）')
  })

  it('间隔型任务描述包含间隔与随机抖动', () => {
    const task = taskOf({
      schedule_kind: 'interval',
      interval_seconds: 3600,
      interval_start_at: new Date('2026-11-25T09:00:00').getTime(),
      interval_jitter_seconds: 30,
    })
    const text = formatSchedule(task)
    expect(text).toContain('每 1 小时')
    expect(text).toContain('随机')
  })

  it('固定时刻且无抖动时只显示时刻', () => {
    const task = taskOf({ window_start: '10:00', window_end: '10:00' })
    expect(formatSchedule(task)).toBe('每天 10:00')
  })
})
