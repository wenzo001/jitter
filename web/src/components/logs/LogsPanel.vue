<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LogSummary } from '@/types/task'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { useAppStore } from '@/stores/app'
import { formatTime } from '@/utils/format'
import { formatSchedule } from '@/utils/schedule'
import LogDetailDrawer from './LogDetailDrawer.vue'

const emit = defineEmits<{
  cleanup: []
}>()

const logs = useLogsStore()
const tasks = useTasksStore()
const app = useAppStore()

const detailOpen = ref(false)
const detailId = ref<number | null>(null)

const selectedTask = computed(() => tasks.selectedTask)

const meta = computed(() => {
  const task = selectedTask.value
  if (!task) return ''
  const window =
    logs.retentionDays > 0 ? ` · 仅显示最近 ${logs.retentionDays} 天` : ''
  return `${formatSchedule(task)} · 下次 ${formatTime(task.next_run_at)}${
    task.running ? ' · 执行中' : ''
  }${window}`
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
  if (kind === 'missed') return '错过'
  if (kind === 'skipped') return '跳过'
  return '任务'
}

function statusInfo(log: LogSummary): { text: string; color: string } {
  if (log.kind === 'missed') return { text: '未执行', color: 'orange' }
  if (log.kind === 'skipped') return { text: '已跳过', color: 'orange' }
  if (log.error && log.error.startsWith('请求超时')) return { text: '超时', color: 'orange' }
  if (log.aborted) return { text: '已中断', color: 'error' }
  if (log.error) return { text: '错误', color: 'error' }
  if (log.response_status === null) return { text: '无响应', color: 'default' }
  const status = log.response_status
  const color = status >= 200 && status < 300 ? 'success' : status < 400 ? 'warning' : 'error'
  return { text: String(status), color }
}

const emptyText = computed(() => {
  if (!tasks.selectedId) {
    return tasks.tasks.length === 0
      ? '创建任务后，这里会显示每次执行的结果。'
      : '点击任意任务卡片查看执行记录'
  }
  return '这个任务还没有执行记录。定时触发后会出现在这里。'
})
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <h2 class="panel-title">
        执行记录
        <small v-if="selectedTask">· {{ selectedTask.name }}</small>
      </h2>
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
        <span v-if="meta" class="muted" style="font-size: 12px">{{ meta }}</span>
        <a-button size="small" type="text" @click="emit('cleanup')">清理日志</a-button>
        <a-button size="small" type="text" @click="refresh">刷新</a-button>
      </div>
    </div>

    <div v-if="logs.logs.length === 0" class="empty">
      {{ logs.loading ? '加载中…' : emptyText }}
    </div>
    <div v-else class="log-list">
      <div v-for="log in logs.logs" :key="log.id" class="log-item" @click="openDetail(log)">
        <div class="log-head">
          <a-tag :color="log.kind === 'missed' || log.kind === 'skipped' ? 'orange' : 'default'">
            {{ kindLabel(log.kind) }}
          </a-tag>
          <span>{{ formatTime(log.executed_at) }}</span>
          <a-tag :color="statusInfo(log).color">{{ statusInfo(log).text }}</a-tag>
          <span v-if="log.duration_ms !== null" class="muted">{{ log.duration_ms }} ms</span>
          <a-tag v-if="log.kind === 'task' && log.matched !== null" :color="log.matched ? 'success' : 'default'">
            {{ log.matched ? '成功' : '未成功' }}
          </a-tag>
          <a-tag v-if="log.notify" :color="log.notify.error ? 'error' : 'blue'" class="notify-tag">
            {{ log.notify.error ? '通知失败' : '已通知' }}
          </a-tag>
          <a-tag v-if="log.run_source === 'manual'" color="default">手动</a-tag>
          <a-tag v-if="log.run_source === 'startup'" color="default">开机</a-tag>
          <span style="margin-left: auto" class="muted">详情 ›</span>
        </div>
        <div v-if="log.request_url" class="log-request">
          {{ log.request_method }} {{ log.request_url }}
        </div>
        <div v-if="log.error" class="log-error">{{ log.error }}</div>
        <div v-else-if="log.notify && log.notify.error" class="log-error">
          通知失败：{{ log.notify.error }}
        </div>
      </div>
    </div>

    <div v-if="logs.hasMore || logs.loadingOlder" class="logs-footer">
      <a-button size="small" type="text" :loading="logs.loadingOlder" @click="loadOlder">
        加载更早的记录
      </a-button>
    </div>

    <LogDetailDrawer v-model:open="detailOpen" :log-id="detailId" />
  </div>
</template>
