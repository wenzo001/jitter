<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStorage } from '@vueuse/core'
import type { LogSummary } from '@/types/task'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { useAppStore } from '@/stores/app'
import { formatTime } from '@/utils/format'
import { formatSchedule } from '@/utils/schedule'
import { groupLogs } from '@/utils/log-merge'
import LogRow from './LogRow.vue'
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

/** 合并连续的同型记录（默认开）：省渲染，也更好读。 */
const mergeEnabled = useStorage('jitter.mergeLogs', true)
/** 已展开的合并组（存组 key）。 */
const expandedGroups = ref<string[]>([])

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
    // 换任务时收起展开的组，别把上一个任务的展开状态带过来。
    expandedGroups.value = []
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

/** 合并后的分组：关掉合并时每条记录自成一组。 */
const groups = computed(() =>
  mergeEnabled.value
    ? groupLogs(logs.logs)
    : logs.logs.map((log) => ({ key: String(log.id), items: [log] })),
)

function isExpanded(key: string): boolean {
  return expandedGroups.value.includes(key)
}

function toggleGroup(key: string) {
  expandedGroups.value = isExpanded(key)
    ? expandedGroups.value.filter((item) => item !== key)
    : [...expandedGroups.value, key]
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
        <label class="logs-merge-toggle" :title="$t('logs.mergeHint')">
          <a-switch size="small" :checked="mergeEnabled" @change="mergeEnabled = $event" />
          <span class="muted">{{ $t('logs.mergeToggle') }}</span>
        </label>
        <a-button size="small" type="text" @click="emit('cleanup')">{{ $t('logs.cleanup') }}</a-button>
        <a-button size="small" type="text" @click="refresh">{{ $t('common.refresh') }}</a-button>
      </div>
    </div>

    <div v-if="logs.logs.length === 0" class="empty">
      {{ logs.loading ? $t('common.loading') : emptyText }}
    </div>
    <div v-else class="log-list">
      <div v-for="group in groups" :key="group.key" class="log-group">
        <LogRow
          :log="group.items[0]"
          :merge-count="group.items.length"
          :expanded="isExpanded(group.key)"
          @select="openDetail(group.items[0])"
          @toggle="toggleGroup(group.key)"
        />
        <div v-if="group.items.length > 1 && isExpanded(group.key)" class="log-group-body">
          <LogRow
            v-for="log in group.items.slice(1)"
            :key="log.id"
            class="log-item-sub"
            :log="log"
            @select="openDetail(log)"
          />
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
