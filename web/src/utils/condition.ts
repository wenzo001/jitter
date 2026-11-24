import type { Task } from '@/types/task'
import { precheckCurlOf } from './curl'

export const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const

export interface ConditionRow {
  key: string
  label: string
  value: string
  mono?: boolean
}

function weekdayText(raw: string | null): string {
  if (!raw) return ''
  const days = raw
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
  if (days.length === 0) return ''
  if (days.length === 7) return '每天'
  const labelOf = (value: number) => WEEKDAYS.find((day) => day.value === value)?.label ?? ''
  // 周一..周日 的顺序展示，更符合中文习惯
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((value) => days.includes(value))
    .map((value) => `周${labelOf(value)}`)
    .join('、')
}

function curlSummary(raw: string): string {
  const first = raw.split('\n')[0]?.trim() ?? ''
  return first.length > 110 ? `${first.slice(0, 110)}…` : first
}

/** 任务已配置的执行条件，用于卡片浮层逐项展示。 */
export function conditionRows(task: Task): ConditionRow[] {
  const rows: ConditionRow[] = []
  const weekdays = weekdayText(task.precheck_weekdays)
  if (weekdays) rows.push({ key: 'weekdays', label: '执行星期', value: weekdays })

  if (task.precheck_time_start && task.precheck_time_end) {
    const cross = task.precheck_time_end < task.precheck_time_start
    rows.push({
      key: 'time',
      label: '执行时段',
      value: `${task.precheck_time_start}–${task.precheck_time_end}${
        cross ? '（跨午夜）' : ''
      }`,
    })
  }

  if (task.precheck_require_ac === 1) {
    rows.push({ key: 'ac', label: '电源', value: '仅接通电源（AC）时执行' })
  }

  if (task.precheck_ip_pattern) {
    rows.push({
      key: 'ip',
      label: '本机 IP',
      value: task.precheck_ip_pattern,
      mono: true,
    })
  }

  if (task.precheck_day_type === 'workday' || task.precheck_day_type === 'offday') {
    rows.push({
      key: 'dayType',
      label: '执行日期',
      value: task.precheck_day_type === 'workday' ? '仅工作日（按法定节假日，含调休）' : '仅休息日（按法定节假日，含调休）',
    })
  }

  const curl = precheckCurlOf(task)
  if (curl) {
    rows.push({ key: 'curl', label: '条件检查', value: curlSummary(curl), mono: true })
  }

  if (task.precheck_expect_status !== null && task.precheck_expect_status !== undefined) {
    rows.push({
      key: 'status',
      label: '期望状态码',
      value: String(task.precheck_expect_status),
      mono: true,
    })
  }

  if (task.precheck_expr) {
    rows.push({ key: 'expr', label: '条件表达式', value: task.precheck_expr, mono: true })
  }

  return rows
}

export function hasConfiguredConditions(task: Task): boolean {
  return conditionRows(task).length > 0
}

/** 卡片底部的短描述。 */
export function conditionSummary(task: Task): string {
  if (task.precheck_enabled !== 1) return '无执行条件'
  const rows = conditionRows(task)
  if (rows.length === 0) return '执行条件已开启（未限制）'
  return `执行条件：${rows.map((row) => row.label).join('、')}`
}
