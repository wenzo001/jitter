<script setup lang="ts">
/**
 * 代码 / 结构化内容展示组件。
 *
 * 用 `highlight.js` 按内容类型高亮：
 * - 能解析成 JSON 的，先缩进排版（2 空格）再按 JSON 高亮；
 * - 脚本类内容（curl、bash、shell、python…）按对应语言高亮；
 * - 其余按纯文本显示，但仍然是等宽字体。
 *
 * 语言识别顺序：调用方显式指定 > JSON 解析 > 内容特征猜测 > 纯文本。
 * 高亮输出由 highlight.js 自己转义，不会把正文当 HTML 注入。
 */
import { computed } from 'vue'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { prettyJson } from '@/utils/format'
import 'highlight.js/styles/github.css'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const props = defineProps<{
  /** 原始文本。 */
  text: string | null | undefined
  /** 语言提示（如 'bash'）；给了就优先按它高亮。 */
  language?: string | null
  /** 文本为空时显示的内容。 */
  empty?: string
}>()

/** 语言名 → highlight.js 的语言 id。 */
const LANG_ALIAS: Record<string, string> = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  powershell: 'powershell',
  ps1: 'powershell',
  python: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  xml: 'xml',
  html: 'xml',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  ini: 'ini',
  conf: 'ini',
  dockerfile: 'dockerfile',
}

/** 猜语言：按内容特征，猜不准就当纯文本。 */
function guessLanguage(raw: string): string {
  const text = raw.trim()
  if (!text) return 'plaintext'
  if (text.startsWith('#!')) {
    if (/bash|sh\b|zsh/i.test(text.split('\n')[0])) return 'bash'
    if (/python/i.test(text.split('\n')[0])) return 'python'
    if (/powershell/i.test(text.split('\n')[0])) return 'powershell'
  }
  if (/^curl\s/i.test(text) || /^\s*curl\s+/i.test(text)) return 'bash'
  if (/^<\?xml/i.test(text)) return 'xml'
  if (/^<(!doctype|html|head|body)\b/i.test(text)) return 'xml'
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(text)) return 'sql'
  if (/^\s*(def|class|import|from|if __name__)\b/m.test(text)) return 'python'
  if (/^\s*[{[]/.test(text)) return 'json'
  return 'plaintext'
}

/** 是不是合法 JSON。 */
function isJson(raw: string): boolean {
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

interface Rendered {
  /** 高亮后的 HTML。 */
  html: string
  /** 展示用的文本（JSON 会是缩进后的）。 */
  text: string
  /** 实际用的语言。 */
  language: string
}

/** 有没有内容可展示。 */
const hasContent = computed(
  () => props.text !== null && props.text !== undefined && props.text.trim() !== '',
)

const rendered = computed<Rendered>(() => {
  const raw = props.text
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { html: '', text: props.empty ?? '', language: 'plaintext' }
  }

  const hinted = props.language ? LANG_ALIAS[props.language.toLowerCase()] : undefined
  let language = hinted
  let body = raw

  // JSON：先缩进排版再高亮——原始响应通常是一整行，不排版根本没法读。
  if (!language) {
    if (isJson(raw)) {
      language = 'json'
      body = prettyJson(raw)
    } else {
      language = guessLanguage(raw)
    }
  } else if (language === 'json') {
    body = prettyJson(raw)
  }

  if (language === 'plaintext' || !hljs.getLanguage(language)) {
    return { html: escapeHtml(body), text: body, language: 'plaintext' }
  }
  return {
    html: hljs.highlight(body, { language, ignoreIllegals: true }).value,
    text: body,
    language,
  }
})

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
</script>

<template>
  <pre v-if="hasContent" class="code-block"><code v-html="rendered.html" /></pre>
  <p v-else class="code-empty muted">{{ props.empty ?? '' }}</p>
</template>

<style scoped>
.code-block {
  margin: 0;
  max-height: 460px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f6f8fa;
  border: 1px solid #e6e9ef;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  tab-size: 2;
  /* 长行折行显示，不留横向滚动条（内容不能被藏在右边看不见）。 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code-block :deep(.hljs-keyword),
.code-block :deep(.hljs-selector-tag),
.code-block :deep(.hljs-literal),
.code-block :deep(.hljs-section),
.code-block :deep(.hljs-link) {
  color: #cf222e;
}

.code-block :deep(.hljs-string),
.code-block :deep(.hljs-title),
.code-block :deep(.hljs-name),
.code-block :deep(.hljs-type),
.code-block :deep(.hljs-attribute),
.code-block :deep(.hljs-symbol),
.code-block :deep(.hljs-bullet),
.code-block :deep(.hljs-addition) {
  color: #0a3069;
}

.code-block :deep(.hljs-comment),
.code-block :deep(.hljs-quote),
.code-block :deep(.hljs-deletion),
.code-block :deep(.hljs-meta) {
  color: #6e7781;
}

.code-block :deep(.hljs-number),
.code-block :deep(.hljs-regexp),
.code-block :deep(.hljs-variable),
.code-block :deep(.hljs-template-variable) {
  color: #0550ae;
}

.code-block :deep(.hljs-built_in),
.code-block :deep(.hljs-builtin-name) {
  color: #8250df;
}

.code-empty {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f6f8fa;
  border: 1px solid #e6e9ef;
  font-size: 12px;
}
</style>
