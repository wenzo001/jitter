<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LogSummary } from '@/types/task'
import { BACKEND_MARKERS } from '@/api/client'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { useAppStore } from '@/stores/app'
import { formatTime } from '@/utils/format'
import { formatSchedule } from '@/utils/schedule'
import LogDetailDrawer from './LogDetailDrawer.vue'

const emit = defineEmits<{
  cleanup: []
}>()

const { t } = useI18n()

const logs = useLogsStore()
const tasks = useTasksStore()
const app = useAppStore()

const detailOpen = ref(false)
const detailId = ref<number | null>(null)

const selectedTask = computed(() => tasks.selectedTask)

const meta = computed(() => {
  const task = selectedTask.value
  if (!task) return ''
  const parts = [formatSchedule(task, t), t('logs.next', { time: formatTime(task.next_run_at) })]
  if (task.running) parts.push(t('logs.running'))
  if (logs.retentionDays > 0) {
    parts.push(t('logs.retentionWindow', { days: logs.retentionDays }))
  }
  return parts.join(' · ')
})

watch(
  () => tasks.selectedId,
  async (id) => {
    try {
      await logs.load(id, { reset: true, pageSize: app.config.logsPageSize })
    } catch (error) {
      app.setStatus(error instanceof Error ? error.message : String(error), true)
    }
  },
  { immediate: true },
)

async function refresh() {
  try {
    await tasks.load()
    await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

async function loadOlder() {
  try {
    await logs.load(tasks.selectedId, { older: true, pageSize: app.config.logsPageSize })
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function openDetail(log: LogSummary) {
  detailId.value = log.id
  detailOpen.value = true
}

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

const emptyText = computed(() => {
  if (!tasks.selectedId) {
    return tasks.tasks.length === 0 ? t('logs.emptyNoTask') : t('logs.emptyNoSelection')
  }
  return t('logs.emptyNoRecords')
})
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <div class="panel-head-main">
        <h2 class="panel-title">
          {{ $t('logs.panelTitle') }}
          <small v-if="selectedTask">· {{ selectedTask.name }}</small>
        </h2>
        <span v-if="meta" class="muted panel-meta">{{ meta }}</span>
      </div>
      <div class="panel-actions">
        <a-button size="small" type="text" @click="emit('cleanup')">{{ $t('logs.cleanup') }}</a-button>
        <a-button size="small" type="text" @click="refresh">{{ $t('common.refresh') }}</a-button>
      </div>
    </div>

    <div v-if="logs.logs.length === 0" class="empty">
      {{ logs.loading ? $t('common.loading') : emptyText }}
    </div>
    <div v-else class="log-list">
      <div v-for="log in logs.logs" :key="log.id" class="log-item" @click="openDetail(log)">
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
          <span class="log-more muted">{{ $t('logs.detailMore') }}</span>
        </div>
        <div v-if="log.error" class="log-error">{{ log.error }}</div>
        <div v-else-if="log.notify && log.notify.error" class="log-error">
          {{ $t('logs.notifyFailedDetail', { error: log.notify.error }) }}
        </div>
      </div>
    </div>

    <div v-if="logs.hasMore || logs.loadingOlder" class="logs-footer">
      <a-button size="small" type="text" :loading="logs.loadingOlder" @click="loadOlder">
        {{ $t('logs.loadOlder') }}
      </a-button>
    </div>
    <p v-else-if="logs.capped" class="logs-cap muted">
      {{ $t('logs.capHint') }}
    </p>

    <LogDetailDrawer v-model:open="detailOpen" :log-id="detailId" />
  </div>
</template>
