/**
 * 执行结果的通知展示语义（目标契约）：
 * - notifySent 仅在后端确认真实 HTTP 2xx 时为 true；
 * - notifyStatus / notifyError 需要透传展示；
 * - 旧响应缺少这些字段时，绝不能报「已通知」。
 */
import { describe, expect, it } from 'vitest'
import { describeRunNotify } from '@/utils/run-result'
import type { RunResult } from '@/types/task'

const t = (key: string, named?: Record<string, unknown>) =>
  named ? `${key}|${JSON.stringify(named)}` : key

function base(): RunResult {
  return {
    ok: true,
    status: 200,
    matched: 1,
    skipped: 0,
    error: null,
    aborted: false,
    durationMs: 10,
  } as unknown as RunResult
}

describe('describeRunNotify', () => {
  it('notifySent=true 时报「已通知」', () => {
    expect(describeRunNotify({ ...base(), notifySent: true }, t)).toBe('task.runNotified')
  })

  it('notifyError 存在时报失败并带错误内容', () => {
    const text = describeRunNotify(
      { ...base(), notifySent: false, notifyError: '连接被拒绝' },
      t,
    )
    expect(text).toContain('task.runNotifyFailed')
    expect(text).toContain('连接被拒绝')
  })

  it('notifyStatus 为数字且未发送时报状态码', () => {
    const text = describeRunNotify(
      { ...base(), notifySent: false, notifyStatus: 404 },
      t,
    )
    expect(text).toContain('task.runNotifyStatus')
    expect(text).toContain('404')
  })

  it('旧响应缺字段（notifySent=false 无其他信息）不得报已通知', () => {
    const text = describeRunNotify(
      { ...base(), notifySent: false } as RunResult,
      t,
    )
    expect(text).not.toContain('runNotified')
    expect(text).toBe('common.success')
  })

  it('完全没有通知字段也不得报已通知', () => {
    expect(describeRunNotify(base(), t)).toBe('common.success')
  })
})
