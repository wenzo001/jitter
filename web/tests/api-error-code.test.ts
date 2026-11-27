/**
 * api/client.ts 对后端错误的稳定消费方式：
 * - ApiError 透传后端 payload 里的 code（跨语言稳定标识）；
 * - localizeBackendMessage 把后端写死的中文错误映射到界面 i18n，
 *   未知文案原样返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, localizeBackendMessage, request } from '@/api/client'
import { setActiveLocale } from '@/locales/current'

describe('ApiError 携带后端错误 code', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    setActiveLocale('zh-CN')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    setActiveLocale('zh-CN')
  })

  it('从 payload 读取 code 与 hint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: '任务不存在', code: 'task_not_found', hint: '刷新列表试试' }),
        { status: 404 },
      ),
    ) as unknown as typeof fetch

    const err = (await request('/api/tasks/nope').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('任务不存在')
    expect(err.code).toBe('task_not_found')
    expect(err.hint).toBe('刷新列表试试')
  })

  it('payload 无 code 时 code 为 undefined', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 400 }),
    ) as unknown as typeof fetch

    const err = (await request('/api/x', { method: 'POST' }).catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBeUndefined()
  })
})

describe('localizeBackendMessage', () => {
  afterEach(() => {
    setActiveLocale('zh-CN')
  })

  it('已知文案在英文界面下翻译成英文', () => {
    setActiveLocale('en-US')
    const out = localizeBackendMessage('任务不存在')
    expect(out).not.toBe('任务不存在')
    expect(out.toLowerCase()).toContain('task')
  })

  it('未知文案原样返回', () => {
    setActiveLocale('en-US')
    expect(localizeBackendMessage('某条没见过的后端提示')).toBe('某条没见过的后端提示')
  })

  it('空串/非字符串安全返回', () => {
    expect(localizeBackendMessage('')).toBe('')
    expect(localizeBackendMessage(undefined as unknown as string)).toBe('')
  })
})
