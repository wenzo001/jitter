import type { LogSummary } from '@/types/task'

/**
 * 一组**连续**同型的执行记录。
 *
 * 合并只为「看得舒服 + 渲染省力」，展开后每条记录都还在，一条不少。
 */
export interface LogGroup {
  /** 组标识：用组内第一条（时间最新）的记录 id。 */
  key: string
  /** 组内记录，按时间倒序（第一条最新）。 */
  items: LogSummary[]
}

/**
 * 归一化错误文本：把**第一个**时间戳换成占位符。
 *
 * 跳过原因长这样：「当前 18:55 不在执行时段 23:55–01:05（跨午夜）内；已跳过主请求 POST …」，
 * 每条只有「当前 HH:MM」在变，替换掉它就能把同因的记录归成一组；
 * 后面的时间窗（23:55–01:05）保持原样，不同的窗口不会被混为一谈。
 */
export function normalizeLogError(text: string): string {
  return text.replace(/\d{1,2}:\d{2}/, '<now>')
}

/**
 * 记录归组用的键：只有「结构性字段」完全一致才算同型。
 *
 * 刻意**不含**耗时和记录 id——它们每次都在变，带上就永远合并不了。
 */
export function logGroupKey(log: LogSummary): string {
  return [
    log.kind,
    log.run_source ?? '',
    log.request_method ?? '',
    log.request_url ?? '',
    log.response_status ?? '',
    log.matched ?? '',
    log.aborted,
    log.notify ? (log.notify.error ?? 'sent') : '',
    normalizeLogError(log.error ?? ''),
  ].join('|')
}

/**
 * 把连续同型的记录合并成组。
 *
 * 只合并**相邻**的记录：中间夹了一条别的类型，就断开分组。
 */
export function groupLogs(logs: LogSummary[]): LogGroup[] {
  const groups: LogGroup[] = []
  let currentKey = ''
  for (const log of logs) {
    const key = logGroupKey(log)
    const last = groups[groups.length - 1]
    if (last && key === currentKey) {
      last.items.push(log)
      continue
    }
    currentKey = key
    groups.push({ key: String(log.id), items: [log] })
  }
  return groups
}
