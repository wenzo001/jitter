<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MenuInfo, MenuProps } from 'antdv-next'
import type { Task } from '@/types/task'
import ConditionBadge from './ConditionBadge.vue'
import {
  formatTime,
  formatDay,
  formatElapsed,
  formatRelative,
  formatTimeout,
  pauseStateOf,
  calendarDays,
} from '@/utils/format'
import { formatSchedule, isCrossMidnight } from '@/utils/schedule'
import { conditionSummary } from '@/utils/condition'

const props = defineProps<{
  task: Task
  now: number
  selected: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  run: [task: Task]
  edit: [task: Task]
  test: [task: Task]
  pause: [task: Task]
  resumePause: [task: Task]
  stop: [task: Task]
  start: [task: Task]
  remove: [task: Task]
  move: [task: Task, delta: number]
}>()

const { t } = useI18n()

const pause = computed(() => (props.task.status === 'active' ? pauseStateOf(props.task) : null))

/**
 * 上一次执行：成功 / 失败 / 未满足成功条件。
 *
 * 卡面上只留「结果 + 多久之前」一行，其余细节（准确时间、触发方式、
 * 状态码、耗时）放进 title 提示，鼠标悬停才看——这样卡片密度低、一眼扫得完。
 */
const lastRun = computed(() => {
  const run = props.task.last_run
  if (!run) return null
  const meta =
    run.outcome === 'success'
      ? { color: 'success', text: t('task.lastSuccess') }
      : run.outcome === 'condition_miss'
        ? { color: 'warning', text: t('task.lastConditionMiss') }
        : { color: 'error', text: t('task.lastFailed') }
  const source =
    run.runSource === 'manual'
      ? t('task.sourceManual')
      : run.runSource === 'startup'
        ? t('task.sourceStartup')
        : t('task.sourceScheduled')
  return { ...run, ...meta, source }
})

/** 悬停提示：把「上次执行」的完整信息一次性给全。 */
const lastRunTitle = computed(() => {
  const run = lastRun.value
  if (!run) return ''
  const parts = [formatTime(run.executedAt), run.source]
  if (run.status !== null) parts.push(`HTTP ${run.status}`)
  if (run.durationMs !== null) parts.push(`${run.durationMs} ms`)
  return parts.join(' · ')
})

const timeoutText = computed(() => {
  try {
    const options = JSON.parse(props.task.request_options ?? '{}') as { timeoutMs?: number }
    return options.timeoutMs ? formatTimeout(options.timeoutMs) : ''
  } catch {
    return ''
  }
})

const footText = computed(() => {
  const task = props.task
  if (task.status !== 'active') return t('task.footDisabled')
  const current = pause.value
  if (!current) return t('task.footNext', { time: formatTime(task.next_run_at) })
  if (current.started) {
    return t('task.footPaused', {
      days: calendarDays(current.from, current.until),
      from: formatDay(current.from),
      until: formatTime(current.until),
    })
  }
  return t('task.footPausedFrom', {
    days: calendarDays(current.from, current.until),
    from: formatDay(current.from),
    until: formatTime(current.until),
  })
})

function act(name: 'run' | 'edit' | 'test' | 'pause' | 'resumePause' | 'stop' | 'start' | 'remove') {
  switch (name) {
    case 'run':
      emit('run', props.task)
      break
    case 'edit':
      emit('edit', props.task)
      break
    case 'test':
      emit('test', props.task)
      break
    case 'pause':
      emit('pause', props.task)
      break
    case 'resumePause':
      emit('resumePause', props.task)
      break
    case 'stop':
      emit('stop', props.task)
      break
    case 'start':
      emit('start', props.task)
      break
    case 'remove':
      emit('remove', props.task)
      break
  }
}

const menu = computed<MenuProps>(() => {
  const task = props.task
  const items: NonNullable<MenuProps['items']> = [{ key: 'test', label: t('task.menuTest') }]
  if (task.status === 'active') {
    items.push({ key: 'pause', label: pause.value ? t('task.menuAdjustPause') : t('task.menuPause') })
    if (pause.value) items.push({ key: 'resumePause', label: t('task.menuResumePause') })
  }
  items.push({ type: 'divider' })
  items.push(
    task.status === 'active'
      ? { key: 'stop', label: t('task.menuStop') }
      : { key: 'start', label: t('task.menuStart') },
  )
  items.push({ type: 'divider' })
  items.push({ key: 'remove', label: t('task.menuRemove'), danger: true })
  return { items, onClick: onMenuClick }
})

function onMenuClick(info: MenuInfo) {
  act(String(info.key) as 'test' | 'pause' | 'resumePause' | 'stop' | 'start' | 'remove')
}

function onDragStart(event: DragEvent) {
  event.dataTransfer?.setData('text/plain', props.task.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <article
    class="task-card"
    :class="{ 'is-selected': selected }"
    tabindex="0"
    :aria-label="$t('task.cardAria', { name: task.name })"
    :aria-current="selected ? 'true' : undefined"
    :title="$t('task.cardTitle')"
    @click="emit('select', task.id)"
    @keydown.enter.prevent="emit('select', task.id)"
    @keydown.space.prevent="emit('select', task.id)"
  >
    <div class="task-head">
      <div class="task-title">
        <button
          class="drag-handle"
          type="button"
          draggable="true"
          :title="$t('task.dragTitle')"
          :aria-label="$t('task.dragAria')"
          @click.stop
          @dragstart="onDragStart"
          @keydown.up.prevent.stop="emit('move', task, -1)"
          @keydown.down.prevent.stop="emit('move', task, 1)"
        >
          ⠿
        </button>
        <h3 class="task-name" :title="task.name">{{ task.name }}</h3>
      </div>

      <div class="task-actions" @click.stop>
        <a-button
          v-if="task.running"
          size="small"
          disabled
          :title="$t('task.runningTitle')"
        >
          {{ $t('task.running') }}
        </a-button>
        <a-button
          v-else
          type="primary"
          size="small"
          :loading="busy"
          :title="$t('task.runNowTitle')"
          @click="act('run')"
        >
          {{ $t('task.runNow') }}
        </a-button>
        <a-button size="small" @click="act('edit')">{{ $t('task.edit') }}</a-button>

        <a-dropdown :trigger="['click']" :menu="menu" placement="bottomRight">
          <a-button size="small" @click.stop>{{ $t('task.more') }}</a-button>
        </a-dropdown>
      </div>
    </div>

    <div
      class="task-last"
      :class="lastRun ? `is-${lastRun.outcome}` : 'is-empty'"
      :title="lastRunTitle"
    >
      <template v-if="lastRun">
        <a-tag :color="lastRun.color" class="task-last-tag">{{ lastRun.text }}</a-tag>
        <span class="task-last-rel">{{ formatRelative(lastRun.executedAt, now, t) }}</span>
      </template>
      <template v-else>
        <a-tag color="default" class="task-last-tag">{{ $t('task.neverRun') }}</a-tag>
        <span class="muted">{{ $t('task.noRunRecord') }}</span>
      </template>
    </div>

    <div class="task-meta">
      <ConditionBadge :task="task" :now="now" />
      <a-tag v-if="isCrossMidnight(task)" color="purple">{{ $t('task.crossMidnight') }}</a-tag>
      <a-tag v-if="timeoutText" color="default">{{ $t('task.timeoutTag', { value: timeoutText }) }}</a-tag>
      <span class="task-meta-schedule">
        <span class="muted task-meta-label">{{ $t('task.scheduleLabel') }}</span>{{ formatSchedule(task, t) }}
      </span>
    </div>

    <div class="task-request" :title="`${task.request_method} ${task.request_url}`">
      {{ task.request_method }} {{ task.request_url }}
    </div>

    <div class="task-foot">
      <span>{{ footText }}</span>
      <span class="sep">·</span>
      <span>{{ task.notify_enabled ? $t('task.notifyOn') : $t('task.notifyOff') }}</span>
      <span class="sep">·</span>
      <span>{{ conditionSummary(task, t) }}</span>
      <span v-if="task.running" class="sep">·</span>
      <span v-if="task.running" class="muted">
        {{ $t('task.runningElapsed', { value: formatElapsed(now - (task.running_since ?? now)) }) }}
      </span>
    </div>
  </article>
</template>
