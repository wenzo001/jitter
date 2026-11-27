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
  /** 清理日志：默认只清当前选中的任务。 */
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

/** 结果筛选：全部 / 只看成功 / 只看失败 / 只看跳过。 */
const outcomeOptions = computed(() => [
  { label: t('logs.filterAll'), value: 'all' },
  { label: t('logs.filterSuccess'), value: 'success' },
  { label: t('logs.filterFailed'), value: 'failed' },
  { label: t('logs.filterSkipped'), value: 'skipped' },
])

const filtering = computed(() => logs.outcome !== 'all')

const meta = computed(() => {
  const task = selectedTask.value
  if (!task) return ''
  const parts = [formatSchedule(task, t), t('logs.next', { time: formatTime(task.next_run_at) })]
  if (task.running) parts.push(t('logs.running'))
  if (logs.retentionDays > 0) {
    parts.push(t('logs.retentionWindow', { days: logs.retentionDays }))
  }
  if (filtering.value) {
    parts.push(t('logs.filterMatched', { count: logs.matchedTotal }))
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

// 换筛选口径：重新按新口径拉一次。
// 筛选是在后端 SQL 层做的，所以这次返回的就是该口径下的全部匹配记录，
// 不需要再点「加载更早的记录」往下翻。
watch(
  () => logs.outcome,
  async () => {
    expandedGroups.value = []
    try {
      await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
    } catch (error) {
      app.setStatus(error instanceof Error ? error.message : String(error), true)
    }
  },
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

/** 切换结果筛选口径（值来自分段控件，这里做一次白名单校验）。 */
function onOutcomeChange(value: unknown) {
  if (value === 'all' || value === 'success' || value === 'failed' || value === 'skipped') {
    logs.outcome = value
  }
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
  if (filtering.value) return t('logs.emptyNoMatch')
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
        <a-segmented
          :value="logs.outcome"
          size="small"
          :options="outcomeOptions"
          class="logs-filter"
          :title="$t('logs.filterHint')"
          @change="onOutcomeChange"
        />
        <label class="logs-merge-toggle" :title="$t('logs.mergeHint')">
          <a-switch size="small" :checked="mergeEnabled" @change="mergeEnabled = $event" />
          <span class="muted">{{ $t('logs.mergeToggle') }}</span>
        </label>
        <a-button
          size="small"
          type="text"
          :disabled="!selectedTask"
          :title="selectedTask ? $t('logs.cleanupTaskLogsHint') : $t('logs.cleanupNeedSelect')"
          @click="emit('cleanup')"
        >
          {{ selectedTask ? $t('logs.cleanupTaskLogs') : $t('logs.cleanup') }}
        </a-button>
        <a-button size="small" type="text" @click="refresh">{{ $t('common.refresh') }}</a-button>
      </div>
    </div>

    <!-- 查询失败：明确说「加载失败 + 原因 + 重试」，绝不能伪装成「没有记录」。 -->
    <a-alert
      v-if="logs.error"
      class="logs-error-alert"
      type="error"
      show-icon
      style="margin: 0 12px 10px"
      :message="$t('logs.loadFailed', { error: logs.error })"
    >
      <template #action>
        <a-button size="small" :loading="logs.loading" @click="logs.retry()">
          {{ $t('common.retry') }}
        </a-button>
      </template>
    </a-alert>

    <div v-if="logs.logs.length === 0 && !logs.error" class="empty">
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
      {{ $t('logs.capHint', { count: logs.maxRows }) }}
    </p>

    <LogDetailDrawer v-model:open="detailOpen" :log-id="detailId" />
  </div>
</template>
