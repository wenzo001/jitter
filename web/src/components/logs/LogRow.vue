<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { LogSummary } from '@/types/task'
import { BACKEND_MARKERS } from '@/api/client'
import { formatTime } from '@/utils/format'

const props = defineProps<{
  log: LogSummary
  /** 合并后的条数；> 1 时显示「× N」并可点开。 */
  mergeCount?: number
  /** 合并组是否已展开。 */
  expanded?: boolean
}>()

const emit = defineEmits<{
  select: []
  toggle: []
}>()

const { t } = useI18n()

function kindLabel(kind: string): string {
  if (kind === 'missed') return t('logs.kindMissed')
  if (kind === 'skipped') return t('logs.kindSkipped')
  return t('logs.kindTask')
}

function statusInfo(log: LogSummary): { text: string; color: string } {
  if (log.kind === 'missed') return { text: t('logs.statusNotRun'), color: 'orange' }
  if (log.kind === 'skipped') return { text: t('logs.statusSkipped'), color: 'orange' }
  if (log.error && log.error.startsWith(BACKEND_MARKERS.timeout)) {
    return { text: t('logs.statusTimeout'), color: 'orange' }
  }
  if (log.aborted) return { text: t('logs.statusAborted'), color: 'error' }
  if (log.error) return { text: t('logs.statusError'), color: 'error' }
  if (log.response_status === null) return { text: t('logs.statusNoResponse'), color: 'default' }
  const status = log.response_status
  const color = status >= 200 && status < 300 ? 'success' : status < 400 ? 'warning' : 'error'
  return { text: String(status), color }
}
</script>

<template>
  <div class="log-item" @click="emit('select')">
    <div class="log-head">
      <a-tag :color="log.kind === 'missed' || log.kind === 'skipped' ? 'orange' : 'default'">
        {{ kindLabel(log.kind) }}
      </a-tag>
      <span>{{ formatTime(log.executed_at) }}</span>
      <span v-if="log.duration_ms !== null" class="muted">{{ log.duration_ms }} ms</span>
      <a-tag v-if="log.run_source === 'manual'" color="default">
        {{ $t('logs.sourceManual') }}
      </a-tag>
      <a-tag v-if="log.run_source === 'startup'" color="default">
        {{ $t('logs.sourceStartup') }}
      </a-tag>
      <!-- 请求地址是这一行的「内容」，状态标签统一排在它后面。 -->
      <span v-if="log.request_url" class="log-request" :title="`${log.request_method} ${log.request_url}`">
        {{ log.request_method }} {{ log.request_url }}
      </span>
      <a-tag :color="statusInfo(log).color">{{ statusInfo(log).text }}</a-tag>
      <a-tag v-if="log.kind === 'task' && log.matched !== null" :color="log.matched ? 'success' : 'default'">
        {{ log.matched ? $t('logs.matched') : $t('logs.notMatched') }}
      </a-tag>
      <a-tag v-if="log.notify" :color="log.notify.error ? 'error' : 'blue'" class="notify-tag">
        {{ log.notify.error ? $t('logs.notifyFailed') : $t('logs.notified') }}
      </a-tag>
      <a-tag
        v-if="mergeCount && mergeCount > 1"
        class="merge-tag"
        :class="{ 'is-expanded': expanded }"
        :title="expanded ? $t('logs.mergeCollapse') : $t('logs.mergeExpand')"
        @click.stop="emit('toggle')"
      >
        × {{ mergeCount }}
      </a-tag>
      <span class="log-more muted">{{ $t('logs.detailMore') }}</span>
    </div>
    <div v-if="log.error" class="log-error">{{ log.error }}</div>
    <div v-else-if="log.notify && log.notify.error" class="log-error">
      {{ $t('logs.notifyFailedDetail', { error: log.notify.error }) }}
    </div>
  </div>
</template>
