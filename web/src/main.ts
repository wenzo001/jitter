import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'antdv-next/dist/reset.css'
import './styles.css'
import App from './App.vue'
import { useDiagnosticsStore } from '@/stores/diagnostics'
import { i18n, translate } from '@/i18n'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(i18n)

const diagnostics = useDiagnosticsStore(pinia)

/**
 * 全局错误捕获。
 *
 * 目标不是「吞掉」异常，而是把它记下来并让用户看得见：
 * 渲染错误进诊断面板，未处理的 Promise 拒绝同理，资源加载失败也会提示。
 */
app.config.errorHandler = (error, _instance, info) => {
  // 同时输出到控制台：浏览器开发者工具里能看到完整堆栈，方便用户自己排查。
  console.error('[jitter]', info ?? 'render error', error)
  diagnostics.reportError(
    info ? translate('error.renderFailedWithInfo', { info }) : translate('error.renderFailed'),
    error,
  )
}

window.addEventListener('unhandledrejection', (event) => {
  diagnostics.reportError(translate('error.unhandledRejection'), event.reason)
})

window.addEventListener('error', (event) => {
  // 资源加载失败（img / script）也会触发 error 事件，单独归类。
  const target = event.target as EventTarget | null
  if (target && target !== window) {
    const tag = (target as HTMLElement).tagName?.toLowerCase() ?? translate('error.resourceTag')
    diagnostics.reportError(
      translate('error.resourceLoadFailed', { tag }),
      event.message || translate('error.resourceRequestFailed'),
    )
    return
  }
  diagnostics.reportError(translate('error.scriptFailed'), event.error ?? event.message)
})

app.mount('#app')
