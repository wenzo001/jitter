<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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

const { t } = useI18n()

const MAX_PAUSE_DAYS = 15
const app = useAppStore()

const days = ref(1)
const startsToday = ref(false)
const busy = ref(false)
const error = ref('')

const isAdjust = computed(() => (props.task ? pauseStateOf(props.task) !== null : false))

const dayOptions = computed(() =>
  Array.from({ length: MAX_PAUSE_DAYS }, (_, index) => ({
    label: t('pause.daysOption', { count: index + 1 }),
    value: index + 1,
  })),
)

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
  const lead = startsToday.value ? t('pause.summaryStartToday') : t('pause.summaryStartTomorrow')
  return `${lead}${t('pause.summaryTail', {
    days: days.value,
    covered,
    until: formatTime(until),
  })}`
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
        ? t('pause.statusAdjusted', { name: task.name, days: days.value })
        : t('pause.statusPaused', { name: task.name, days: days.value }),
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
    :title="isAdjust ? $t('pause.adjustTitle') : $t('pause.title')"
    :ok-text="isAdjust ? $t('pause.adjustOkText') : $t('pause.okText')"
    :confirm-loading="busy"
    @update:open="emit('update:open', $event)"
    @ok="confirm"
  >
    <p v-if="task" style="margin-top: 0">
      {{ $t('pause.taskLineBefore') }}<strong>{{ task.name }}</strong>{{ $t('pause.taskLineAfter') }}
      <span v-if="isAdjust" class="muted">{{ $t('pause.currentlyPaused') }}</span>
    </p>

    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">{{ $t('pause.daysLabel') }}</label>
        <a-select v-model:value="days" :options="dayOptions" style="width: 100%" />
      </div>
      <div class="field">
        <label class="field-label">{{ $t('pause.startFrom') }}</label>
        <a-radio-group v-model:value="startsToday" style="display: flex; flex-direction: column; gap: 4px">
          <a-radio :value="true">{{ $t('pause.startToday') }}</a-radio>
          <a-radio :value="false">{{ $t('pause.startTomorrow') }}</a-radio>
        </a-radio-group>
      </div>
    </div>

    <a-alert type="info" :message="summary" show-icon style="margin-top: 6px" />
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 10px" />
  </a-modal>
</template>
