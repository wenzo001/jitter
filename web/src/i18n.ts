/**
 * vue-i18n 实例与语言切换。
 *
 * - 默认简体中文（zh-CN），英文（en-US）可切换；
 * - 语言记在 localStorage（`jitter-locale`），隐私模式下读写失败也不影响使用；
 * - 切换时同步更新 `<html lang>`，方便屏幕阅读器与浏览器语言判断。
 */
import { createI18n } from 'vue-i18n'
// 注册 dayjs 的中文语言包。
//
// antdv-next 的日历头（年/月/日选择器）里的月份名与星期名来自 dayjs：
// `dayjs().locale('zh-cn').localeData().monthsShort()`。
// 不注册语言包时 dayjs 会静默回退到英文，于是中文界面里出现
// “Jan Feb Mar…” 和 “Su Mo Tu…”。这里只注册，不改全局 locale。
import 'dayjs/locale/zh-cn'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  activeLocale,
  setActiveLocale,
  type Locale,
} from './locales/current'

export type { Locale }
export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY }

/** 组件之外的翻译入口（store / 接口层）。 */
export { translate } from './locales/current'

/** 文案树：叶子是字符串，节点是对象。 */
type MessageTree = { [key: string]: string | MessageTree }

const initialLocale = activeLocale()

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLocale,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    'zh-CN': zhCN as unknown as MessageTree,
    'en-US': enUS as unknown as MessageTree,
  },
})

/** 当前语言。 */
export function currentLocale(): Locale {
  return activeLocale()
}

/** 切换语言：立即生效，并持久化到 localStorage。 */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  // setActiveLocale 内部会写回 localStorage（useStorage 负责异常兜底）。
  setActiveLocale(locale)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = initialLocale
}
