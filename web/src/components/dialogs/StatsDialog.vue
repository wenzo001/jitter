<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'
import { formatDuration, formatRate, formatTime } from '@/utils/format'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const app = useAppStore()
const tasks = useTasksStore()

watch(
  () => props.open,
  (open) => {
    if (open) void app.refreshMetrics()
  },
)

const overview = computed(() => app.metrics?.overview ?? null)

const rows = computed(() => {
  const names = new Map(tasks.tasks.map((task) => [task.id, task.name]))
  return (app.metrics?.tasks ?? [])
    .filter((entry) => entry.runs > 0)
    .sort((a, b) => (b.success_rate ?? -1) - (a.success_rate ?? -1) || b.runs - a.runs)
    .map((entry) => ({ ...entry, name: names.get(entry.task_id) ?? t('stats.deleted') }))
})

function lastText(entry: { last_error: string | null; last_status: number | null; last_kind: string | null }): string {
  if (entry.last_error !== null) return t('stats.lastFailed', { error: entry.last_error })
  if (entry.last_status !== null) return `HTTP ${entry.last_status}`
  if (entry.last_kind === 'missed') return t('stats.lastMissed')
  return '—'
}
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('stats.title')"
    :footer="null"
    width="min(760px, 94vw)"
    @update:open="emit('update:open', $event)"
  >
    <template v-if="overview">
      <a-descriptions :column="2" size="small" bordered style="margin-bottom: 14px">
        <a-descriptions-item :label="$t('stats.labelTasks')">
          {{ $t('stats.tasksEnabled', { active: overview.active, total: overview.tasks }) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('stats.labelRunning')">
          {{ overview.running }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('stats.labelToday')">
          {{ $t('stats.todayRuns', { count: overview.today_runs, ok: overview.today_ok }) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('stats.labelWeek')">
          {{ $t('stats.weekRuns', { count: overview.week_runs }) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('stats.labelSuccessRate')">
          {{ formatRate(overview.success_rate_7d) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('stats.labelAvgDuration')">
          {{ formatDuration(overview.avg_duration_ms_7d) }}
        </a-descriptions-item>
      </a-descriptions>

      <div v-if="rows.length === 0" class="empty">{{ $t('stats.empty') }}</div>
      <table v-else style="width: 100%; border-collapse: collapse; font-size: 12.5px">
        <thead>
          <tr style="text-align: left; color: var(--muted)">
            <th style="padding: 6px 8px">{{ $t('stats.columnTask') }}</th>
            <th style="padding: 6px 8px">{{ $t('stats.columnRuns') }}</th>
            <th style="padding: 6px 8px">{{ $t('stats.columnSuccessRate') }}</th>
            <th style="padding: 6px 8px">{{ $t('stats.columnAvgDuration') }}</th>
            <th style="padding: 6px 8px">{{ $t('stats.columnLast') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in rows" :key="entry.task_id" style="border-top: 1px solid var(--border)">
            <td style="padding: 6px 8px">{{ entry.name }}</td>
            <td style="padding: 6px 8px">{{ entry.runs }}</td>
            <td style="padding: 6px 8px">{{ formatRate(entry.success_rate) }}</td>
            <td style="padding: 6px 8px">{{ formatDuration(entry.avg_duration_ms) }}</td>
            <td style="padding: 6px 8px">
              {{ entry.last_executed_at ? formatTime(entry.last_executed_at) : '—' }} · {{ lastText(entry) }}
            </td>
          </tr>
        </tbody>
      </table>
    </template>
    <div v-else class="empty">{{ $t('stats.loading') }}</div>
  </a-modal>
</template>
