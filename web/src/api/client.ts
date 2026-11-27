/**
 * 统一的接口调用层。
 *
 * 目标：任何失败都要能被用户看懂、能被界面处理。
 * - 区分失败类型（网络断了 / 超时 / 服务端 4xx / 服务端 5xx / 返回体不是 JSON）。
 * - 服务端返回的 `hint`（处理建议）原样带出来，界面可以直接展示给用户。
 * - 只读请求（GET）在网络抖动时自动重试，避免偶发断连就弹错误。
 */

import { translate } from '@/locales/current'

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'server' | 'parse' | 'unknown'

/**
 * 后端错误文案里的关键字。
 *
 * 这些是服务端固定写死的中文提示（见 rust/crates/jitter-core），
 * 用来把后端返回的失败原因识别成可处理的类型；它们属于后端协议而不是界面文案，
 * 所以不随界面语言变化，也不放进 locale 文件。
 */
export const BACKEND_MARKERS = {
  /** 后端执行超时时的提示前缀。 */
  timeout: '请求超时',
  /** 后端「已经是最新版本」时的提示片段。 */
  alreadyLatest: '最新版本',
} as const

export class ApiError extends Error {
  /** HTTP 状态码；网络层失败为 0。 */
  status: number
  /** 失败类型。 */
  kind: ApiErrorKind
  /** 服务端给的解决建议（没有则为空串）。 */
  hint: string
  /** 后端返回的稳定错误码（跨语言标识，旧后端可能没有）。 */
  code?: string

  constructor(
    message: string,
    status = 0,
    options: { kind?: ApiErrorKind; hint?: string; code?: string } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.kind = options.kind ?? (status >= 500 ? 'server' : status > 0 ? 'http' : 'unknown')
    this.hint = options.hint ?? ''
    this.code = options.code
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number
  /** 失败重试次数（只对 GET 生效）。 */
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRIES = 2
const RETRY_DELAY_MS = [400, 1200]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return error.kind === 'network' || error.kind === 'timeout'
}

/** 把任意异常转成「用户能看懂 + 有下一步动作」的结构。 */
export function describeError(error: unknown): { message: string; hint: string; kind: ApiErrorKind } {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      hint: error.hint || defaultHint(error),
      kind: error.kind,
    }
  }
  if (error instanceof Error) {
    return { message: error.message, hint: '', kind: 'unknown' }
  }
  return { message: String(error), hint: '', kind: 'unknown' }
}

/** 服务端没给 hint 时，按错误类型补一句用户能执行的下一步。 */
function defaultHint(error: ApiError): string {
  switch (error.kind) {
    case 'network':
      return translate('error.networkHint')
    case 'timeout':
      return translate('error.timeoutHint')
    case 'server':
      return translate('error.serverHint')
    case 'http':
      return translate('error.httpHint')
    default:
      return ''
  }
}

function readHint(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'hint' in payload) {
    const hint = (payload as { hint: unknown }).hint
    return typeof hint === 'string' ? hint : ''
  }
  return ''
}

function readCode(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const code = (payload as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * 后端写死的中文错误 → 界面语言文案的最小映射。
 *
 * 后端目前没有稳定的错误 code，只有整句中文（见 rust api 层）。
 * 这里只对已确认的原句做精确匹配，映射到 i18n key；
 * 匹配不上的原样返回（后端数据本身不做机翻式猜测）。
 * 后端将来补上 code 后，优先按 `ApiError.code` 分支，这里可逐步退役。
 */
const BACKEND_MESSAGE_KEYS: Record<string, string> = {
  任务不存在: 'error.backendTaskNotFound',
}

export function localizeBackendMessage(message: string): string {
  if (!message) return ''
  const key = BACKEND_MESSAGE_KEYS[message.trim()]
  return key ? translate(key) : message
}

async function requestOnce<T>(path: string, options: RequestOptions): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
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
          : text || translate('error.httpFailed', { status: response.status })
      throw new ApiError(message, response.status, {
        kind: response.status >= 500 ? 'server' : 'http',
        hint: readHint(payload),
        code: readCode(payload),
      })
    }
    if (text && payload === null) {
      throw new ApiError(translate('error.parseFailed'), response.status, { kind: 'parse' })
    }
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(translate('error.timeoutMessage'), 0, { kind: 'timeout' })
    }
    if (error instanceof TypeError) {
      throw new ApiError(translate('error.networkMessage'), 0, { kind: 'network' })
    }
    throw new ApiError(error instanceof Error ? error.message : String(error), 0, {
      kind: 'unknown',
    })
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const canRetry = method === 'GET' && !options.signal
  const maxRetries = canRetry ? (options.retries ?? DEFAULT_RETRIES) : 0

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestOnce<T>(path, options)
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries || !isRetryable(error)) throw error
      await sleep(RETRY_DELAY_MS[Math.min(attempt, RETRY_DELAY_MS.length - 1)])
    }
  }
  throw lastError
}

export function postJson<T>(path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs,
  })
}
