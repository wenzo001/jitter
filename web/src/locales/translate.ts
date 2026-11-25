/**
 * 极简翻译工具：给「组件之外」的代码（store / 工具函数 / 接口层）用。
 *
 * 这里刻意不依赖 vue-i18n 实例：
 * - 工具函数（如 formatRelative）可以在单元测试里直接调用，不需要挂载组件；
 * - 避免 utils 反向依赖应用单例，产生循环引用。
 *
 * 组件里请用 `useI18n()` 的 `t`，两边的文案来自同一份 messages，结果一致。
 */

/** 翻译函数签名：key 为点分层级路径，named 为 `{name}` 占位符。 */
export type TranslateFn = (key: string, named?: Record<string, unknown>) => string

/**
 * 把 `{name}` 占位符替换成实际值；未提供的占位符保持原样。
 *
 * 字面量花括号按 vue-i18n 的写法转义：`{'{'}` → `{`，`{'}'}` → `}`。
 */
export function interpolate(template: string, named?: Record<string, unknown>): string {
  const escaped = template.replace(/\{'([{}])'\}/g, '$1')
  if (!named) return escaped
  return escaped.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = named[name]
    return value === undefined || value === null ? match : String(value)
  })
}

/** 按点分层级路径取出文案；取不到返回 undefined。 */
export function resolveMessage(messages: unknown, key: string): string | undefined {
  let node: unknown = messages
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/** 用一份 messages 生成翻译函数。 */
export function createTranslate(messages: unknown): TranslateFn {
  return (key, named) => {
    const template = resolveMessage(messages, key)
    if (template === undefined) return key
    return interpolate(template, named)
  }
}
