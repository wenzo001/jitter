<script setup lang="ts">
/**
 * 诊断面板：告诉用户「现在是什么状态、哪里出了问题、下一步该做什么」。
 *
 * 内容分三块：
 * 1. 服务状态（后台是否响应、版本、运行时长、数据库与日志路径）；
 * 2. 页面捕获到的异常（含解决建议）；
 * 3. 服务端最近一次错误。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import { useDiagnosticsStore } from '@/stores/diagnostics'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; openLogs: [] }>()

const { t } = useI18n()

const diagnostics = useDiagnosticsStore()
// vueuse 的 useClipboard：自带「已复制」状态（1.5 秒后自动复位），
// 权限受限时自动降级，不会抛异常。
const { copy, copied } = useClipboard()

const stateType = computed(() => {
  switch (diagnostics.serviceState) {
    case 'ok':
      return 'success'
    case 'degraded':
      return 'warning'
    case 'down':
      return 'error'
    default:
      return 'info'
  }
})

const uptimeText = computed(() => {
  const ms = diagnostics.health?.uptimeMs ?? 0
  if (!ms) return '—'
  const seconds = Math.floor(ms / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return t('diagnostics.uptimeDays', { days, hours })
  if (hours > 0) return t('diagnostics.uptimeHours', { hours, minutes })
  return t('diagnostics.uptimeMinutes', { minutes, seconds: seconds % 60 })
})

const serverErrorText = computed(() => {
  const last = diagnostics.health?.lastError
  if (!last) return ''
  return `${new Date(last.at).toLocaleString()} · ${last.message}`
})

async function copyReport(): Promise<void> {
  await copy(diagnostics.buildReport())
}

watch(
  () => props.open,
  (open) => {
    if (open) void diagnostics.checkHealth()
  },
)
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('diagnostics.title')"
    width="min(760px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <a-alert :type="stateType" show-icon style="margin-bottom: 14px">
      <template #message>
        <strong>{{ diagnostics.stateLabel }}</strong>
        <span v-if="diagnostics.guidance" style="margin-left: 8px">{{ diagnostics.guidance }}</span>
      </template>
    </a-alert>

    <a-descriptions size="small" bordered :column="1" style="margin-bottom: 16px">
      <a-descriptions-item :label="$t('diagnostics.labelVersion')">
        <span class="mono">{{ diagnostics.health?.version || '—' }}</span>
      </a-descriptions-item>
      <a-descriptions-item :label="$t('diagnostics.labelUptime')">
        {{ uptimeText }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('diagnostics.labelDatabase')">
        <span class="mono diag-path">{{ diagnostics.health?.dbPath || '—' }}</span>
        <a-tag
          v-if="diagnostics.health"
          :color="diagnostics.health.dbOk ? 'green' : 'red'"
          style="margin-left: 8px"
        >
          {{ diagnostics.health.dbOk ? $t('diagnostics.dbWritable') : $t('diagnostics.dbUnavailable') }}
        </a-tag>
      </a-descriptions-item>
      <a-descriptions-item :label="$t('diagnostics.labelLogDir')">
        <span class="mono diag-path">{{ diagnostics.health?.logDir || '—' }}</span>
      </a-descriptions-item>
      <a-descriptions-item :label="$t('diagnostics.labelLastCheck')">
        {{ diagnostics.lastCheckedAt ? new Date(diagnostics.lastCheckedAt).toLocaleTimeString() : '—' }}
      </a-descriptions-item>
      <a-descriptions-item :label="$t('diagnostics.labelServerError')">
        <span v-if="serverErrorText" class="diag-err">{{ serverErrorText }}</span>
        <span v-else class="muted">{{ $t('diagnostics.none') }}</span>
      </a-descriptions-item>
    </a-descriptions>

    <div class="diag-section-head">
      <h3>{{ $t('diagnostics.entriesTitle', { count: diagnostics.entries.length }) }}</h3>
      <div class="diag-section-actions">
        <a-button size="small" @click="diagnostics.checkHealth()">
          {{ $t('common.recheck') }}
        </a-button>
        <a-button size="small" @click="copyReport">
          {{ copied ? $t('common.copied') : $t('diagnostics.copyReport') }}
        </a-button>
        <a-button size="small" @click="emit('openLogs')">
          {{ $t('common.viewRuntimeLogs') }}
        </a-button>
        <a-button size="small" danger :disabled="!diagnostics.entries.length" @click="diagnostics.clearEntries()">
          {{ $t('diagnostics.clear') }}
        </a-button>
      </div>
    </div>

    <div v-if="diagnostics.entries.length" class="diag-list">
      <div v-for="entry in diagnostics.entries" :key="entry.id" class="diag-item">
        <div class="diag-item-head">
          <span class="mono diag-time">{{ new Date(entry.at).toLocaleTimeString() }}</span>
          <span class="diag-source">{{ entry.source }}</span>
        </div>
        <div class="diag-message">{{ entry.message }}</div>
        <div v-if="entry.hint" class="diag-hint">
          {{ $t('diagnostics.hintPrefix', { hint: entry.hint }) }}
        </div>
        <details v-if="entry.stack" class="diag-details">
          <summary>{{ $t('diagnostics.techDetails') }}</summary>
          <pre class="diag-stack">{{ entry.stack }}</pre>
        </details>
      </div>
    </div>
    <div v-else class="empty">{{ $t('diagnostics.empty') }}</div>
  </a-modal>
</template>

<style scoped>
.diag-path {
  font-size: 12px;
  word-break: break-all;
}

.diag-err {
  color: var(--err);
}

.diag-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 4px 0 10px;
}

.diag-section-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.diag-section-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.diag-list {
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.diag-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.diag-item:last-child {
  border-bottom: none;
}

.diag-item-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.diag-time {
  color: var(--muted);
}

.diag-source {
  color: var(--accent);
  font-weight: 600;
}

.diag-message {
  margin-top: 3px;
  font-size: 13px;
  color: var(--text);
  word-break: break-word;
}

.diag-hint {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}

.diag-details {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}

.diag-details summary {
  cursor: pointer;
  user-select: none;
}

.diag-stack {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  background: var(--bg-subtle, #f5f6f8);
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
