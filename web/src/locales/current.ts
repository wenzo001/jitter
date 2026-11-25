/**
 * 当前语言的无组件翻译入口。
 *
 * store / 工具函数 / 接口层这些「拿不到组件实例」的地方用这里的 `translate()`，
 * 组件里请用 `useI18n()` 的 `t`。两者读的是同一份 messages，结果一致。
 *
 * 为什么不直接用 vue-i18n 实例：
 * - 工具函数（formatRelative 等）在单元测试里直接调用，不该依赖应用单例；
 * - 避免 utils 反向依赖应用入口产生循环引用。
 */
import { ref } from 'vue'
import { useStorage } from '@vueuse/core'
import zhCN from './zh-CN'
import enUS from './en-US'
import { createTranslate, type TranslateFn } from './translate'

export type { TranslateFn }

export type Locale = 'zh-CN' | 'en-US'

export const DEFAULT_LOCALE: Locale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'jitter-locale'

const translators: Record<Locale, TranslateFn> = {
  'zh-CN': createTranslate(zhCN),
  'en-US': createTranslate(enUS),
}

function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en-US'
}

/**
 * 持久化的语言选择。
 *
 * 用 vueuse 的 useStorage：隐私模式下 localStorage 抛异常、跨标签页同步、
 * 写入失败降级，这些都由它处理，不用自己 try/catch 一堆分支。
 * 序列化保持成原始字符串（不套 JSON），和早期版本存的内容一致。
 */
export const localeStorage = useStorage<string>(LOCALE_STORAGE_KEY, DEFAULT_LOCALE, undefined, {
  serializer: {
    read: (raw: string) => raw,
    write: (raw: string) => raw,
  },
  onError: () => {
    // 隐私模式 / 磁盘配额满：忽略，本次会话仍然可用。
  },
})

let activeName: Locale = isLocale(localeStorage.value)
  ? localeStorage.value
  : DEFAULT_LOCALE

/**
 * 固定的中文翻译函数。
 *
 * 工具函数（formatRelative、formatSchedule 等）把它作为默认翻译器：
 * 不传翻译函数时保持中文行为，现有的中文单元测试断言不受影响。
 */
export const zhTranslate: TranslateFn = translators['zh-CN']

/**
 * 语言版本号：切换语言后自增。
 *
 * `translate()` 会读它，所以写在 computed 里的翻译结果会跟着语言切换重新计算。
 */
export const localeRevision = ref(0)

/** 当前语言。 */
export function activeLocale(): Locale {
  return activeName
}

/** 切换底层翻译器（由 i18n.ts 在切换语言时调用）。 */
export function setActiveLocale(locale: string): void {
  activeName = isLocale(locale) ? locale : DEFAULT_LOCALE
  // 持久化交给 useStorage，写失败它自己兜底。
  localeStorage.value = activeName
  localeRevision.value += 1
}

/** 翻译文案；跟随当前语言。 */
export function translate(key: string, named?: Record<string, unknown>): string {
  // 读一下版本号：让调用方写在 computed 里时能跟着语言切换重算。
  void localeRevision.value
  return translators[activeName](key, named)
}
