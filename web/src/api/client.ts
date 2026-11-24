export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  const headers = new Headers(options.headers)
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      cache: 'no-store',
      signal: options.signal ?? controller.signal,
    })
    const text = await response.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : text || `请求失败（HTTP ${response.status}）`
      throw new ApiError(message, response.status)
    }
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('请求超时，服务可能仍在处理，请稍后刷新')
    }
    throw new ApiError(error instanceof Error ? error.message : String(error))
  } finally {
    window.clearTimeout(timeout)
  }
}

export function postJson<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs,
  })
}
