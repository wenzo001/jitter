<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Task } from '@/types/task'
import { pauseTask } from '@/api/tasks'
import { useAppStore } from '@/stores/app'
import { calendarDays, formatDay, formatTime, pauseStateOf } from '@/utils/format'

const props = defineProps<{
  open: boolean
  task: Task | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: [task: Task]
}>()

const MAX_PAUSE_DAYS = 15
const app = useAppStore()

const days = ref(1)
const startsToday = ref(false)
const busy = ref(false)
const error = ref('')

const isAdjust = computed(() => (props.task ? pauseStateOf(props.task) !== null : false))

const dayOptions = Array.from({ length: MAX_PAUSE_DAYS }, (_, index) => ({
  label: `${index + 1} 天`,
  value: index + 1,
}))

function interval(): { from: number; until: number } {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() + (startsToday.value ? 0 : 1))
  const until = new Date(from.getTime())
  until.setDate(until.getDate() + days.value)
  return { from: from.getTime(), until: until.getTime() }
}

const summary = computed(() => {
  if (!props.task) return ''
  const { from, until } = interval()
  const covered = days.value === 1 ? formatDay(from) : `${formatDay(from)}–${formatDay(until - 1)}`
  const lead = startsToday.value
    ? '今天起算：今天剩余时间（含尚未到达的窗口）一律不再触发，不管现在是几点。'
    : '明天起算：今天剩余时间照常执行，今天已排好的任务不会被取消。'
  return `${lead}暂停 ${days.value} 个完整自然日（${covered}）；${formatTime(
    until,
  )} 恢复，之后按原调度继续执行。`
})

watch(
  () => [props.open, props.task] as const,
  ([open, task]) => {
    if (!open || !task) return
    error.value = ''
    busy.value = false
    const current = pauseStateOf(task)
    if (current) {
      days.value = Math.min(MAX_PAUSE_DAYS, Math.max(1, calendarDays(current.from, current.until)))
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      startsToday.value = current.from <= today.getTime()
    } else {
      days.value = 1
      startsToday.value = false
    }
  },
  { immediate: true },
)

async function confirm() {
  const task = props.task
  if (!task || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const data = await pauseTask(task.id, days.value, startsToday.value)
    app.setStatus(
      isAdjust.value
        ? `任务「${task.name}」的暂停已调整为 ${days.value} 天`
        : `任务「${task.name}」已暂停 ${days.value} 天`,
    )
    emit('saved', data.task)
    emit('update:open', false)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="isAdjust ? '调整暂停' : '暂停任务'"
    :ok-text="isAdjust ? '保存调整' : '暂停任务'"
    :confirm-loading="busy"
    @update:open="emit('update:open', $event)"
    @ok="confirm"
  >
    <p v-if="task" style="margin-top: 0">
      任务「<strong>{{ task.name }}</strong>」
      <span v-if="isAdjust" class="muted">· 当前已暂停</span>
    </p>

    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">暂停天数</label>
        <a-select v-model:value="days" :options="dayOptions" style="width: 100%" />
      </div>
      <div class="field">
        <label class="field-label">从哪天开始算</label>
        <a-radio-group v-model:value="startsToday" style="display: flex; flex-direction: column; gap: 4px">
          <a-radio :value="true">今天起算</a-radio>
          <a-radio :value="false">明天起算（今天照常执行）</a-radio>
        </a-radio-group>
      </div>
    </div>

    <a-alert type="info" :message="summary" show-icon style="margin-top: 6px" />
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 10px" />
  </a-modal>
</template>
