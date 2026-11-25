import type { Task } from '@/types/task'
import { zhTranslate, type TranslateFn } from '@/locales/current'
import { precheckCurlOf } from './curl'

/**
 * 星期几的可选项。
 *
 * `localeKey` 是 locale 文件里的键后缀（condition.weekdayMon 等），
 * 展示文案按当前语言取，不在这里写死。
 */
export const WEEKDAYS = [
  { value: 1, localeKey: 'weekday.mon' },
  { value: 2, localeKey: 'weekday.tue' },
  { value: 3, localeKey: 'weekday.wed' },
  { value: 4, localeKey: 'weekday.thu' },
  { value: 5, localeKey: 'weekday.fri' },
  { value: 6, localeKey: 'weekday.sat' },
  { value: 0, localeKey: 'weekday.sun' },
] as const

export interface ConditionRow {
  key: string
  label: string
  value: string
  mono?: boolean
}

function weekdayText(raw: string | null, t: TranslateFn): string {
  if (!raw) return ''
  const days = raw
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
  if (days.length === 0) return ''
  if (days.length === 7) return t('weekday.every')
  const labelOf = (value: number) => {
    const day = WEEKDAYS.find((entry) => entry.value === value)
    return day ? t(day.localeKey) : ''
  }
  // 周一..周日 的顺序展示，更符合中文习惯
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((value) => days.includes(value))
    .map((value) => labelOf(value))
    .join(t('common.listSeparator'))
}

function curlSummary(raw: string): string {
  const first = raw.split('\n')[0]?.trim() ?? ''
  return first.length > 110 ? `${first.slice(0, 110)}…` : first
}

/** 任务已配置的执行条件，用于卡片浮层逐项展示。 */
export function conditionRows(task: Task, t: TranslateFn = zhTranslate): ConditionRow[] {
  const rows: ConditionRow[] = []
  const weekdays = weekdayText(task.precheck_weekdays, t)
  if (weekdays) rows.push({ key: 'weekdays', label: t('condition.labelWeekdays'), value: weekdays })

  if (task.precheck_time_start && task.precheck_time_end) {
    const cross = task.precheck_time_end < task.precheck_time_start
    rows.push({
      key: 'time',
      label: t('condition.labelTime'),
      value: `${task.precheck_time_start}–${task.precheck_time_end}${
        cross ? t('schedule.crossMidnight') : ''
      }`,
    })
  }

  if (task.precheck_require_ac === 1) {
    rows.push({ key: 'ac', label: t('condition.labelPower'), value: t('condition.valueAc') })
  }

  if (task.precheck_require_network === 1) {
    rows.push({
      key: 'network',
      label: t('condition.labelNetwork'),
      value: t('condition.valueNetwork'),
    })
  }

  if (task.precheck_ip_pattern) {
    rows.push({
      key: 'ip',
      label: t('condition.labelIp'),
      value: task.precheck_ip_pattern,
      mono: true,
    })
  }

  if (task.precheck_day_type === 'workday' || task.precheck_day_type === 'offday') {
    rows.push({
      key: 'dayType',
      label: t('condition.labelDayType'),
      value:
        task.precheck_day_type === 'workday'
          ? t('condition.valueWorkday')
          : t('condition.valueOffday'),
    })
  }

  const curl = precheckCurlOf(task)
  if (curl) {
    rows.push({ key: 'curl', label: t('condition.labelCurl'), value: curlSummary(curl), mono: true })
  }

  if (task.precheck_expect_status !== null && task.precheck_expect_status !== undefined) {
    rows.push({
      key: 'status',
      label: t('condition.labelExpectStatus'),
      value: String(task.precheck_expect_status),
      mono: true,
    })
  }

  if (task.precheck_expr) {
    rows.push({
      key: 'expr',
      label: t('condition.labelExpr'),
      value: task.precheck_expr,
      mono: true,
    })
  }

  return rows
}

export function hasConfiguredConditions(task: Task): boolean {
  return conditionRows(task).length > 0
}

/** 卡片底部的短描述。 */
export function conditionSummary(task: Task, t: TranslateFn = zhTranslate): string {
  if (task.precheck_enabled !== 1) return t('condition.summaryNone')
  const rows = conditionRows(task, t)
  if (rows.length === 0) return t('condition.summaryEnabled')
  return t('condition.summaryList', {
    items: rows.map((row) => row.label).join(t('common.listSeparator')),
  })
}
