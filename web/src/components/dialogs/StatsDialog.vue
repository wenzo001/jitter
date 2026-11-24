<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'
import { formatDuration, formatRate, formatTime } from '@/utils/format'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

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
    .map((entry) => ({ ...entry, name: names.get(entry.task_id) ?? '（已删除）' }))
})

function lastText(entry: { last_error: string | null; last_status: number | null; last_kind: string | null }): string {
  if (entry.last_error !== null) return `失败：${entry.last_error}`
  if (entry.last_status !== null) return `HTTP ${entry.last_status}`
  if (entry.last_kind === 'missed') return '错过窗口'
  return '—'
}
</script>

<template>
  <a-modal :open="open" title="执行统计" :footer="null" width="min(760px, 94vw)" @update:open="emit('update:open', $event)">
    <template v-if="overview">
      <a-descriptions :column="2" size="small" bordered style="margin-bottom: 14px">
        <a-descriptions-item label="任务">{{ overview.active }} / {{ overview.tasks }} 个启用</a-descriptions-item>
        <a-descriptions-item label="正在执行">{{ overview.running }}</a-descriptions-item>
        <a-descriptions-item label="今日执行">
          {{ overview.today_runs }} 次（成功 {{ overview.today_ok }}）
        </a-descriptions-item>
        <a-descriptions-item label="近 7 天执行">{{ overview.week_runs }} 次</a-descriptions-item>
        <a-descriptions-item label="近 7 天成功率">{{ formatRate(overview.success_rate_7d) }}</a-descriptions-item>
        <a-descriptions-item label="近 7 天平均耗时">
          {{ formatDuration(overview.avg_duration_ms_7d) }}
        </a-descriptions-item>
      </a-descriptions>

      <div v-if="rows.length === 0" class="empty">近 7 天还没有执行记录。</div>
      <table v-else style="width: 100%; border-collapse: collapse; font-size: 12.5px">
        <thead>
          <tr style="text-align: left; color: var(--muted)">
            <th style="padding: 6px 8px">任务</th>
            <th style="padding: 6px 8px">执行</th>
            <th style="padding: 6px 8px">成功率</th>
            <th style="padding: 6px 8px">平均耗时</th>
            <th style="padding: 6px 8px">最近一次</th>
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
    <div v-else class="empty">统计加载中…</div>
  </a-modal>
</template>
