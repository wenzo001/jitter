<script setup lang="ts">
import { computed } from 'vue'
import type { MenuInfo, MenuProps } from 'antdv-next'
import type { Task } from '@/types/task'
import ConditionBadge from './ConditionBadge.vue'
import { formatTime, formatDay, formatElapsed, formatTimeout, pauseStateOf, calendarDays } from '@/utils/format'
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

const pause = computed(() => (props.task.status === 'active' ? pauseStateOf(props.task) : null))

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
  if (task.status !== 'active') return '调度已停用，历史记录保留'
  const current = pause.value
  if (!current) return `下次 ${formatTime(task.next_run_at)}`
  if (current.started) {
    return `已暂停 ${calendarDays(current.from, current.until)} 天（${formatDay(
      current.from,
    )} 起），${formatTime(current.until)} 恢复`
  }
  return `${formatDay(current.from)} 00:00 起暂停 ${calendarDays(
    current.from,
    current.until,
  )} 天，${formatTime(current.until)} 恢复`
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
  const items: NonNullable<MenuProps['items']> = [{ key: 'test', label: '试跑（不记录）' }]
  if (task.status === 'active') {
    items.push({ key: 'pause', label: pause.value ? '调整暂停' : '暂停几天' })
    if (pause.value) items.push({ key: 'resumePause', label: '取消暂停' })
  }
  items.push({ type: 'divider' })
  items.push(
    task.status === 'active'
      ? { key: 'stop', label: '停止调度' }
      : { key: 'start', label: '启用调度' },
  )
  items.push({ type: 'divider' })
  items.push({ key: 'remove', label: '删除任务', danger: true })
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
    :aria-label="`任务 ${task.name}`"
    :aria-current="selected ? 'true' : undefined"
    title="点击查看这个任务的执行记录"
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
          title="拖动排序；也可聚焦后按 ↑ / ↓"
          aria-label="拖动调整任务顺序"
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
          title="上一次执行还没结束"
        >
          执行中…
        </a-button>
        <a-button
          v-else
          type="primary"
          size="small"
          :loading="busy"
          title="真实执行一次：会发请求，满足成功条件会发通知，并写入执行记录"
          @click="act('run')"
        >
          立即执行
        </a-button>
        <a-button size="small" @click="act('edit')">编辑</a-button>

        <a-dropdown :trigger="['click']" :menu="menu" placement="bottomRight">
          <a-button size="small" @click.stop>更多</a-button>
        </a-dropdown>
      </div>
    </div>

    <div class="task-meta">
      <ConditionBadge :task="task" :now="now" />
      <a-tag v-if="isCrossMidnight(task)" color="purple">跨午夜</a-tag>
      <a-tag v-if="timeoutText" color="default">超时 {{ timeoutText }}</a-tag>
      <span>
        <span class="muted">调度 </span>{{ formatSchedule(task) }}
      </span>
    </div>

    <div class="task-request" :title="`${task.request_method} ${task.request_url}`">
      {{ task.request_method }} {{ task.request_url }}
    </div>

    <div class="task-foot">
      <span>{{ footText }}</span>
      <span class="sep">·</span>
      <span>{{ task.notify_enabled ? '通知：成功时发送' : '通知：未开启' }}</span>
      <span class="sep">·</span>
      <span>{{ conditionSummary(task) }}</span>
      <span v-if="task.running" class="sep">·</span>
      <span v-if="task.running" class="muted">
        已运行 {{ formatElapsed(now - (task.running_since ?? now)) }}
      </span>
    </div>
  </article>
</template>
