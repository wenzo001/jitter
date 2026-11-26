/**
 * 日志清理的范围逻辑。
 *
 * 清理弹窗有两种范围：
 * - `task`：只清当前选中的那个任务；
 * - `all`：清全部任务的日志。
 *
 * 两个入口的默认范围不同：任务面板进来默认 `task`，设置里进来默认 `all`。
 */

export type CleanupScope = 'task' | 'all'

/** 打开弹窗时的默认范围：有任务就默认只清这个任务，否则清全部。 */
export function defaultCleanupScope(taskId?: string | null): CleanupScope {
  return taskId ? 'task' : 'all'
}

/**
 * 实际生效的任务范围。
 *
 * 选「全部任务」时不带 task_id（后端按全部任务处理）；
 * 选「当前任务」时带上它（没有任务 id 则退回全部任务）。
 */
export function effectiveCleanupTaskId(
  scope: CleanupScope,
  taskId?: string | null,
): string | null {
  if (scope !== 'task') return null
  return taskId ?? null
}

/** 清理请求体：范围 + 保留档位。 */
export function cleanupRequestBody(
  scope: CleanupScope,
  taskId: string | null,
  selection: number | 'all',
  cutoff?: number | null,
): Record<string, unknown> {
  const body: Record<string, unknown> =
    selection === 'all'
      ? { all: true, confirm: 'DELETE_ALL' }
      : { days: selection, confirm: true }
  const scoped = effectiveCleanupTaskId(scope, taskId)
  if (scoped) body.task_id = scoped
  if (selection !== 'all' && typeof cutoff === 'number' && Number.isInteger(cutoff)) {
    body.cutoff = cutoff
  }
  return body
}
