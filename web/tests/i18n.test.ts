import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useI18n } from 'vue-i18n'
import zhCN from '@/locales/zh-CN'
import enUS from '@/locales/en-US'
import { createTranslate, interpolate, resolveMessage } from '@/locales/translate'
import { setActiveLocale, translate, zhTranslate } from '@/locales/current'
import { LOCALE_STORAGE_KEY, currentLocale, i18n, setLocale } from '@/i18n'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

/** 把嵌套的文案树拍平成 `key -> 文案`。 */
function flatten(node: unknown, prefix = ''): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof node === 'string') {
    map.set(prefix, node)
    return map
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key
      for (const [childKey, childValue] of flatten(value, path)) {
        map.set(childKey, childValue)
      }
    }
  }
  return map
}

/** 取出文案里的 `{name}` 占位符名。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

/** 给文案里的每个占位符都准备一个值。 */
function fillPlaceholders(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of placeholders(text)) values[name] = 'X'
  return values
}

const zh = flatten(zhCN)
const en = flatten(enUS)
const tZh = createTranslate(zhCN)
const tEn = createTranslate(enUS)

describe('locales', () => {
  it('中英文的 key 集合完全一致', () => {
    expect([...zh.keys()].sort()).toEqual([...en.keys()].sort())
  })

  it('没有空文案', () => {
    for (const [key, value] of zh) {
      expect(value.trim(), `zh-CN:${key}`).not.toBe('')
    }
    for (const [key, value] of en) {
      expect(value.trim(), `en-US:${key}`).not.toBe('')
    }
  })

  it('没有 undefined 的文案', () => {
    for (const key of zh.keys()) {
      expect(resolveMessage(zhCN, key), key).toBeTypeOf('string')
      expect(resolveMessage(enUS, key), key).toBeTypeOf('string')
    }
  })

  it('占位符在两种语言里一一对应', () => {
    for (const [key, value] of zh) {
      const translated = en.get(key)
      expect(translated, key).toBeTypeOf('string')
      expect(placeholders(translated as string), key).toEqual(placeholders(value))
    }
  })

  it('具体 key 的中英文内容', () => {
    expect(zh.get('topbar.statistics')).toBe('统计')
    expect(en.get('topbar.statistics')).toBe('Stats')
    expect(zh.get('common.cancel')).toBe('取消')
    expect(en.get('common.cancel')).toBe('Cancel')
    expect(zh.get('task.menuRemove')).toBe('删除任务')
    expect(en.get('task.menuRemove')).toBe('Delete task')
    expect(zh.get('logs.panelTitle')).toBe('执行记录')
    expect(en.get('logs.panelTitle')).toBe('Execution records')
    expect(zh.get('status.ready')).toBe('就绪')
    expect(en.get('status.ready')).toBe('Ready')
  })

  it('文案里不残留未替换的占位符', () => {
    for (const [key, value] of zh) {
      const filled = interpolate(value, fillPlaceholders(value))
      expect(filled, `zh-CN:${key}`).not.toMatch(/\{\w+\}/)
      const translated = en.get(key) as string
      expect(interpolate(translated, fillPlaceholders(translated)), `en-US:${key}`).not.toMatch(/\{\w+\}/)
    }
  })
})

describe('locales/translate', () => {
  it('按点分层级取文案', () => {
    expect(resolveMessage(zhCN, 'topbar.statistics')).toBe('统计')
    expect(resolveMessage(zhCN, 'not.exists')).toBeUndefined()
  })

  it('替换命名占位符', () => {
    expect(tZh('task.runDone', { name: '签到' })).toBe('任务「签到」已执行一次')
    expect(tEn('task.runDone', { name: 'check-in' })).toBe('Task “check-in” ran once')
  })

  it('未提供的占位符保持原样', () => {
    expect(interpolate('{a} 和 {b}', { a: '1' })).toBe('1 和 {b}')
  })

  it('字面量花括号按 vue-i18n 的写法还原', () => {
    expect(tZh('taskForm.expectBodyPlaceholder')).toBe('例如 {"code":0}')
    expect(tEn('taskForm.expectBodyPlaceholder')).toBe('e.g. {"code":0}')
  })

  it('默认的中文翻译器与中文文案一致', () => {
    expect(zhTranslate('relative.justNow')).toBe('刚刚')
    expect(zhTranslate('relative.minutesAgo', { minutes: 12 })).toBe('12 分钟前')
  })
})

describe('locales/current', () => {
  it('跟随当前语言输出文案', () => {
    setActiveLocale('en-US')
    expect(translate('topbar.statistics')).toBe('Stats')
    setActiveLocale('zh-CN')
    expect(translate('topbar.statistics')).toBe('统计')
  })
})

describe('i18n 实例', () => {
  const Probe = defineComponent({
    setup() {
      const { t } = useI18n()
      return () => h('span', { class: 'probe' }, t('topbar.statistics'))
    },
  })

  it('切换语言后界面立即变英文，切回来完全恢复', async () => {
    setLocale('zh-CN')
    const wrapper = mount(Probe, { global: { plugins: [i18n] } })
    expect(wrapper.find('.probe').text()).toBe('统计')

    setLocale('en-US')
    await nextTick()
    expect(wrapper.find('.probe').text()).toBe('Stats')
    expect(currentLocale()).toBe('en-US')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')

    setLocale('zh-CN')
    await nextTick()
    expect(wrapper.find('.probe').text()).toBe('统计')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN')
    wrapper.unmount()
  })

  it('globalInjection 提供了 $t', () => {
    setLocale('en-US')
    const globalProperties = i18n.global.locale.value
    expect(globalProperties).toBe('en-US')
    const app = mount(Probe, { global: { plugins: [i18n] } })
    const injected = app.vm.$.appContext.config.globalProperties.$t as (key: string) => string
    expect(injected('topbar.settings')).toBe('Settings')
    app.unmount()
    setLocale('zh-CN')
  })

  it('弹窗按钮文案随语言切换', async () => {
    setLocale('zh-CN')
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: '标题' },
      global: { plugins: [i18n] },
    })
    await nextTick()
    // antdv 会给两个连续的中文字之间加空格，这里去掉空白再比较。
    const buttonTexts = () =>
      Array.from(document.body.querySelectorAll('button')).map((node) =>
        (node.textContent ?? '').replace(/\s+/g, ''),
      )
    expect(buttonTexts().join('|')).toContain('确定')
    expect(buttonTexts().join('|')).toContain('取消')

    setLocale('en-US')
    await nextTick()
    expect(buttonTexts().join('|')).toContain('OK')
    expect(buttonTexts().join('|')).toContain('Cancel')

    setLocale('zh-CN')
    await nextTick()
    wrapper.unmount()
    document.body.innerHTML = ''
  })
})

/**
 * 源码文件内容（vite 直接以 ?raw 方式读进来，locale 文件本身跳过）。
 */
const sourceModules = import.meta.glob('../src/**/*.{vue,ts}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('源码里的 i18n key', () => {
  it('所有 t(...) / $t(...) 的 key 在中英文里都存在', () => {
    const missing: string[] = []
    const found: string[] = []
    const pattern = /(?<![A-Za-z0-9_$.])(?:\$t|\bt)\(\s*'([^']+)'/g
    for (const [file, text] of Object.entries(sourceModules)) {
      if (file.includes('/locales/') || file.endsWith('components.d.ts')) continue
      for (const match of text.matchAll(pattern)) {
        const key = match[1]
        found.push(key)
        if (resolveMessage(zhCN, key) === undefined) missing.push(`${file}: ${key} (zh-CN)`)
        if (resolveMessage(enUS, key) === undefined) missing.push(`${file}: ${key} (en-US)`)
      }
    }
    expect(missing).toEqual([])
    // 防止正则写错导致这条检查变成空转。
    expect(found.length).toBeGreaterThan(150)
  })

  it('动态拼接的星期 key 也存在', () => {
    for (const key of ['weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat', 'weekday.sun']) {
      expect(resolveMessage(zhCN, key), key).toBeTypeOf('string')
      expect(resolveMessage(enUS, key), key).toBeTypeOf('string')
    }
  })
})
