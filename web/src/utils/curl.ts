import type { Task } from '@/types/task'

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/** 结构化字段 → curl 文本（与旧版 requestToCurl 一致）。 */
export function requestToCurl(
  method: string,
  url: string,
  headersJson: string | null,
  body: string | null,
): string {
  const parts = [`curl -X ${method} ${shellQuote(url)}`]
  if (headersJson) {
    try {
      const parsed = JSON.parse(headersJson) as Record<string, string>
      for (const [name, value] of Object.entries(parsed)) {
        parts.push(`-H ${shellQuote(`${name}: ${value}`)}`)
      }
    } catch {
      // 保留已经生成的参数
    }
  }
  if (body) parts.push(`--data-raw ${shellQuote(body)}`)
  return parts.join(' \\\n  ')
}

export function curlOf(task: Task): string {
  if (task.curl_command) return task.curl_command
  return requestToCurl(
    task.request_method,
    task.request_url,
    task.request_headers,
    task.request_body,
  )
}

export function precheckCurlOf(task: Task): string {
  if (task.precheck_curl_command) return task.precheck_curl_command
  if (!task.precheck_url) return ''
  return requestToCurl(
    task.precheck_method ?? 'GET',
    task.precheck_url,
    task.precheck_headers,
    task.precheck_body,
  )
}

/** 表单里的 Headers 文本 → JSON 字符串（无有效头时返回 null）。 */
export function headersTextToJson(text: string): string | null {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const index = trimmed.indexOf(':')
    if (index > 0) headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return Object.keys(headers).length > 0 ? JSON.stringify(headers) : null
}

/** 已存 Header（JSON 或原始文本）→ 每行一个的文本。 */
export function headersToText(raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    return Object.entries(parsed as Record<string, unknown>)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')
  } catch {
    return raw
  }
}
