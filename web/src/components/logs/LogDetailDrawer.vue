<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LogDetail, LogSummary } from '@/types/task'
import { useLogsStore } from '@/stores/logs'
import JsonViewer from '@/components/common/JsonViewer.vue'

const props = defineProps<{
  open: boolean
  logId: number | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const { t } = useI18n()

const logs = useLogsStore()
const detail = ref<LogDetail | null>(null)
const loading = ref(false)
const error = ref('')

const title = computed(() =>
  detail.value
    ? t('logDetail.titleWithId', { id: detail.value.id })
    : props.logId
      ? t('logDetail.titleWithId', { id: props.logId })
      : t('logDetail.title'),
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
      else error.value = t('logDetail.loadFailed')
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
        <a-tag v-if="detail.matched" color="success">{{ $t('logDetail.matched') }}</a-tag>
        <a-tag v-else-if="detail.matched === 0" color="default">{{ $t('logDetail.notMatched') }}</a-tag>
      </div>

      <div v-if="summaryOf(detail)" class="detail-block">
        <h4>{{ $t('logDetail.request') }}</h4>
        <pre>{{ summaryOf(detail) }}</pre>
      </div>
      <div v-if="detail.error" class="detail-block">
        <h4>{{ $t('logDetail.error') }}</h4>
        <pre style="color: var(--err)">{{ detail.error }}</pre>
      </div>
      <div v-if="detail.request_headers" class="detail-block">
        <h4>{{ $t('logDetail.requestHeaders') }}</h4>
        <JsonViewer :text="detail.request_headers" />
      </div>
      <div v-if="detail.request_body !== null" class="detail-block">
        <h4>{{ $t('logDetail.requestBody') }}</h4>
        <JsonViewer :text="detail.request_body" :empty="$t('logDetail.empty')" />
      </div>
      <div v-if="detail.response_status !== null" class="detail-block">
        <h4>{{ $t('logDetail.responseStatus') }}</h4>
        <pre>{{ detail.response_status }}</pre>
      </div>
      <div v-if="detail.response_headers" class="detail-block">
        <h4>{{ $t('logDetail.responseHeaders') }}</h4>
        <JsonViewer :text="detail.response_headers" />
      </div>
      <div v-if="detail.response_body !== null" class="detail-block">
        <h4>{{ $t('logDetail.responseBody') }}</h4>
        <JsonViewer :text="detail.response_body" :empty="$t('logDetail.empty')" />
      </div>

      <!-- 通知是另一条独立的请求，放到最后并单独分区，别和任务执行混在一起。 -->
      <section v-if="detail.notify" class="notify-section">
        <div class="notify-head">
          <span class="notify-title">{{ $t('logDetail.notifySectionTitle') }}</span>
          <a-tag :color="detail.notify.error ? 'error' : 'success'" class="notify-state">
            {{ detail.notify.error ? $t('logDetail.notifyStateFailed') : $t('logDetail.notifyStateSent') }}
          </a-tag>
          <span class="notify-hint muted">{{ $t('logDetail.notifySectionHint') }}</span>
        </div>
        <div v-if="notifySummary(detail.notify)" class="detail-block">
          <h4>{{ $t('logDetail.notifyRequest') }}</h4>
          <pre>{{ notifySummary(detail.notify) }}</pre>
        </div>
        <div v-if="detail.notify.error" class="detail-block">
          <h4>{{ $t('logDetail.notifyError') }}</h4>
          <pre style="color: var(--err)">{{ detail.notify.error }}</pre>
        </div>
        <div v-if="detail.notify.response_status !== null" class="detail-block">
          <h4>{{ $t('logDetail.notifyResponse') }}</h4>
          <pre>{{ detail.notify.response_status }} · {{ detail.notify.duration_ms ?? 0 }} ms</pre>
        </div>
        <div v-if="detail.notify.response_body !== null && detail.notify.response_body !== undefined" class="detail-block">
          <h4>{{ $t('logDetail.notifyBody') }}</h4>
          <JsonViewer :text="detail.notify.response_body" :empty="$t('logDetail.empty')" />
        </div>
      </section>
    </template>
  </a-drawer>
</template>

<style scoped>
/* 通知分区：跟上面的任务执行记录明确分开。 */
.notify-section {
  margin-top: 18px;
  padding: 12px 14px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fbfbfd;
}

.notify-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.notify-title {
  font-size: 13px;
  font-weight: 650;
}

.notify-hint {
  font-size: 12px;
  line-height: 1.6;
}
</style>
