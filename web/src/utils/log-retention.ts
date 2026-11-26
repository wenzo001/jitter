/**
 * 日志保留策略的前端共用逻辑。
 *
 * 语义（全端统一）：
 * - `null` = 跟随全局设置（设置里的「日志保留」）
 * - `0` = 永久保留（这个任务的日志永不自动删除）
 * - `N > 0` = 保留 N 天
 *
 * 表单里的下拉框要一个能表达「跟随全局」的字符串值，所以这里用
 * `'inherit'` ↔ `null` 做映射。
 */

export type LogRetentionValue = 'inherit' | number

/** 任务表单里可选的保留天数（0 表示永久保留）。 */
export const LOG_RETENTION_CHOICES = [1, 7, 30, 90, 180, 365] as const

/** 表单里的下拉选项：跟随全局 + 若干天数 + 永久保留。 */
export function logRetentionOptions(
  t: (key: string, named?: Record<string, unknown>) => string,
): { value: LogRetentionValue; label: string }[] {
  const options: { value: LogRetentionValue; label: string }[] = [
    { value: 'inherit', label: t('taskForm.logRetentionInherit') },
  ]
  for (const days of LOG_RETENTION_CHOICES) {
    options.push({ value: days, label: t('taskForm.logRetentionDays', { days }) })
  }
  options.push({ value: 0, label: t('taskForm.logRetentionForever') })
  return options
}

/** 表单模型（null / 天数）→ 下拉框的值。 */
export function logRetentionValue(days: number | null | undefined): LogRetentionValue {
  return days === null || days === undefined ? 'inherit' : days
}

/** 下拉框的值 → 表单模型（null = 跟随全局）。 */
export function parseLogRetention(value: unknown): number | null {
  if (value === 'inherit' || value === null || value === undefined) return null
  const days = Number(value)
  if (!Number.isFinite(days)) return null
  return days
}

/**
 * 这个任务实际生效的保留天数。
 *
 * 任务自己设了就用它的（0 = 永久），否则用全局的（0 = 永久）。
 */
export function effectiveRetentionDays(
  taskDays: number | null | undefined,
  globalDays: number,
): number {
  if (taskDays === null || taskDays === undefined) return globalDays
  return taskDays
}
