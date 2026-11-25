import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, describeError, isApiError, request } from '@/api/client'

/** 造一个 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('api/client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功时返回解析后的 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, value: 7 }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await request<{ ok: boolean; value: number }>('/api/x')
    expect(data).toEqual({ ok: true, value: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('4xx 报错时带上服务端消息与处理建议', async () => {
    // 每次都造一个新的 Response：Response 的 body 只能读一次。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ error: '任务不存在', hint: '先刷新列表' }, 404)),
    )

    await expect(request('/api/x')).rejects.toBeInstanceOf(ApiError)
    const error = await request<ApiError>('/api/x').catch((e) => e as ApiError)
    expect(error.message).toBe('任务不存在')
    expect(error.hint).toBe('先刷新列表')
    expect(error.status).toBe(404)
    expect(error.kind).toBe('http')
    expect(isApiError(error)).toBe(true)
  })

  it('5xx 归类为服务端错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ error: '内部错误' }, 500)),
    )
    const error = await request<ApiError>('/api/x').catch((e) => e as ApiError)
    expect(error.kind).toBe('server')
    expect(error.status).toBe(500)
  })

  it('网络断开归类为 network，并且 GET 会自动重试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const error = await request<ApiError>('/api/x', { retries: 2 }).catch((e) => e as ApiError)
    expect(error.kind).toBe('network')
    expect(error.message).toContain('连不上后台服务')
    // 首次 + 2 次重试
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('POST 不做重试，避免重复提交', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      request('/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) }),
    ).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('重试后成功时返回正常结果', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await request<{ ok: boolean }>('/api/x', { retries: 2 })
    expect(data.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('中止请求归类为 timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    )
    const error = await request<ApiError>('/api/x', { retries: 0 }).catch((e) => e as ApiError)
    expect(error.kind).toBe('timeout')
  })

  it('返回体不是 JSON 时给出可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>hi</html>', { status: 200 })),
    )
    const error = await request<ApiError>('/api/x').catch((e) => e as ApiError)
    expect(error.kind).toBe('parse')
  })

  it('describeError 在服务端没给建议时补上默认指引', () => {
    const described = describeError(new ApiError('断了', 0, { kind: 'network' }))
    expect(described.hint).toContain('Jitter')
    expect(described.kind).toBe('network')
  })

  it('describeError 能处理非 Error 的抛出值', () => {
    const described = describeError('字符串错误')
    expect(described.message).toBe('字符串错误')
    expect(described.kind).toBe('unknown')
  })
})
