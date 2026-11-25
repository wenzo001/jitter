import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import zhCN from '@/locales/zh-CN'
import enUS from '@/locales/en-US'

/**
 * 用 vue-i18n 自己的消息编译器检查每条文案。
 *
 * 为什么必须有这条测试：
 * vue-i18n 的消息语法里 `|` 是复数分隔符，文案里出现裸的 `|`（比如逻辑或 `||`）
 * 会被当成复数写法，编译时直接抛 "Plural must have messages"，
 * 组件渲染就炸——而且只有在切换语言、真正用到那条文案时才暴露。
 */
function flatten(node: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (typeof node === 'string') {
    out.push([prefix, node])
    return out
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      flatten(value, path, out)
    }
  }
  return out
}

function compileFailures(tree: unknown, locale: string): string[] {
  const failures: string[] = []
  for (const [key, message] of flatten(tree)) {
    try {
      baseCompile(message, {
        onError(error: Error) {
          throw error
        },
      })
    } catch (error) {
      failures.push(`${locale}:${key} -> ${(error as Error).message}`)
    }
  }
  return failures
}

describe('文案能被 vue-i18n 编译', () => {
  it('中文文案全部可编译', () => {
    expect(compileFailures(zhCN, 'zh-CN')).toEqual([])
  })

  it('英文文案全部可编译', () => {
    expect(compileFailures(enUS, 'en-US')).toEqual([])
  })

  it('文案里不出现裸的竖线（会被当成复数分隔符）', () => {
    const bad: string[] = []
    for (const [locale, tree] of [
      ['zh-CN', zhCN],
      ['en-US', enUS],
    ] as const) {
      for (const [key, message] of flatten(tree)) {
        if (message.includes('|')) bad.push(`${locale}:${key}`)
      }
    }
    expect(bad).toEqual([])
  })
})
