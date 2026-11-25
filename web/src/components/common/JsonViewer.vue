<script setup lang="ts">
/**
 * JSON 展示组件。
 *
 * 用成熟的 `vue-json-pretty` 渲染树状 JSON：键名/字符串/数字/布尔分色，
 * 对象和数组可以折叠展开，比一堆 `<pre>` 好看也更好读。
 *
 * 响应体不一定都是 JSON（HTML、纯文本、空 body），
 * 解析不了就退回纯文本显示，别把内容弄丢。
 */
import { computed, type Component } from 'vue'
import VueJsonPretty from 'vue-json-pretty'
import { prettyJson } from '@/utils/format'

const props = defineProps<{
  /** 原始文本（JSON 字符串）。 */
  text: string | null | undefined
  /** 文本为空时显示的内容。 */
  empty?: string
}>()

/** 组件库的默认导出同时是组件和 Vue 插件，这里只当组件用，类型上收窄一下。 */
const JsonTree = VueJsonPretty as unknown as Component

const parsed = computed<{ ok: boolean; data: unknown }>(() => {
  const raw = props.text
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: false, data: null }
  try {
    return { ok: true, data: JSON.parse(raw) }
  } catch {
    return { ok: false, data: null }
  }
})
</script>

<template>
  <span v-if="parsed.ok" class="json-viewer">
    <JsonTree
      :data="parsed.data"
      :deep="3"
      :indent="2"
      :show-length="false"
      :show-key-value-space="false"
      :show-icon="true"
      :collapsed-on-click-brackets="true"
    />
  </span>
  <pre v-else class="json-plain">{{
    props.text === null || props.text === undefined || props.text === ''
      ? (props.empty ?? '')
      : prettyJson(props.text)
  }}</pre>
</template>

<style scoped>
.json-viewer {
  display: block;
  max-height: 420px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f8fafc;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
}

.json-plain {
  margin: 0;
  max-height: 420px;
  overflow: auto;
}
</style>
