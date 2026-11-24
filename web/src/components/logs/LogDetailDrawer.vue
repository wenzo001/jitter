<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LogDetail, LogSummary } from '@/types/task'
import { useLogsStore } from '@/stores/logs'
import { prettyJson } from '@/utils/format'

const props = defineProps<{
  open: boolean
  logId: number | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const logs = useLogsStore()
const detail = ref<LogDetail | null>(null)
const loading = ref(false)
const error = ref('')

const title = computed(() =>
  detail.value ? `执行详情 #${detail.value.id}` : props.logId ? `执行详情 #${props.logId}` : '执行详情',
)

watch(
  () => [props.open, props.logId] as const,
  async ([open, id]) => {
    if (!open || !id) return
    loading.value = true
    error.value = ''
    detail.value = null
    try {
      const data = await logs.loadDetail(id)
      if (data) detail.value = data
      else error.value = '详情加载失败，请稍后重试'
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function summaryOf(log: LogSummary): string {
  return `${log.request_method ?? ''} ${log.request_url ?? ''}`.trim()
}

function notifySummary(notify: LogSummary): string {
  return `${notify.request_method ?? ''} ${notify.request_url ?? ''}`.trim()
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="title"
    width="min(680px, 92vw)"
    @update:open="emit('update:open', $event)"
  >
    <a-spin v-if="loading" />
    <a-alert v-else-if="error" type="error" :message="error" show-icon />
    <template v-else-if="detail">
      <div class="log-head" style="margin-bottom: 12px">
        <a-tag>{{ detail.kind }}</a-tag>
        <span class="muted">{{ new Date(detail.executed_at).toLocaleString() }}</span>
        <a-tag v-if="detail.response_status !== null" color="blue">{{ detail.response_status }}</a-tag>
        <span v-if="detail.duration_ms !== null" class="muted">{{ detail.duration_ms }} ms</span>
        <a-tag v-if="detail.matched" color="success">成功</a-tag>
        <a-tag v-else-if="detail.matched === 0" color="default">未成功</a-tag>
      </div>

      <div v-if="summaryOf(detail)" class="detail-block">
        <h4>请求</h4>
        <pre>{{ summaryOf(detail) }}</pre>
      </div>
      <div v-if="detail.error" class="detail-block">
        <h4>错误</h4>
        <pre style="color: var(--err)">{{ detail.error }}</pre>
      </div>
      <template v-if="detail.notify">
        <a-divider style="margin: 4px 0 14px">{{ detail.notify.error ? '通知（失败）' : '通知（已发送）' }}</a-divider>
        <div v-if="notifySummary(detail.notify)" class="detail-block">
          <h4>通知请求</h4>
          <pre>{{ notifySummary(detail.notify) }}</pre>
        </div>
        <div v-if="detail.notify.error" class="detail-block">
          <h4>通知错误</h4>
          <pre style="color: var(--err)">{{ detail.notify.error }}</pre>
        </div>
        <div v-if="detail.notify.response_status !== null" class="detail-block">
          <h4>通知响应</h4>
          <pre>{{ detail.notify.response_status }} · {{ detail.notify.duration_ms ?? 0 }} ms</pre>
        </div>
        <div v-if="detail.notify.response_body !== null && detail.notify.response_body !== undefined" class="detail-block">
          <h4>通知响应体</h4>
          <pre>{{ detail.notify.response_body === '' ? '（空）' : prettyJson(detail.notify.response_body) }}</pre>
        </div>
      </template>
      <div v-if="detail.request_headers" class="detail-block">
        <h4>请求头</h4>
        <pre>{{ prettyJson(detail.request_headers) }}</pre>
      </div>
      <div v-if="detail.request_body !== null" class="detail-block">
        <h4>请求体</h4>
        <pre>{{ detail.request_body === '' ? '（空）' : prettyJson(detail.request_body) }}</pre>
      </div>
      <div v-if="detail.response_status !== null" class="detail-block">
        <h4>响应状态</h4>
        <pre>{{ detail.response_status }}</pre>
      </div>
      <div v-if="detail.response_headers" class="detail-block">
        <h4>响应头</h4>
        <pre>{{ prettyJson(detail.response_headers) }}</pre>
      </div>
      <div v-if="detail.response_body !== null" class="detail-block">
        <h4>响应体</h4>
        <pre>{{ detail.response_body === '' ? '（空）' : prettyJson(detail.response_body) }}</pre>
      </div>
    </template>
  </a-drawer>
</template>
