/**
 * 手动执行结果的「通知情况」文案。
 *
 * 目标契约（后端 /api 返回）：
 * - notifySent 仅当通知请求真实拿到 HTTP 2xx 才为 true；
 * - notifyStatus 是通知请求的 HTTP 状态码（未发出为 null）；
 * - notifyError 是通知失败原因。
 *
 * 兼容旧响应：三个字段都可能缺失，缺省时只能说「成功」，
 * 绝不能把「没有信息」渲染成「已通知」。
 */
import type { RunResult } from '@/types/task'

type T = (key: string, named?: Record<string, unknown>) => string

export function describeRunNotify(data: RunResult, t: T): string {
  if (data.notifySent === true) return t('task.runNotified')
  if (data.notifyError) return t('task.runNotifyFailed', { error: data.notifyError })
  if (typeof data.notifyStatus === 'number') {
    return t('task.runNotifyStatus', { status: data.notifyStatus })
  }
  return t('common.success')
}
