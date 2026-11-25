<script setup lang="ts">
import { ref } from 'vue'
import type { Task } from '@/types/task'
import TaskCard from './TaskCard.vue'

const props = defineProps<{
  tasks: Task[]
  selectedId: string | null
  now: number
  busyId?: string | null
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
  reorder: [ids: string[]]
}>()

const dragId = ref<string | null>(null)
/** 拖动时插入线所在的卡片（插到它前面）。 */
const dropBeforeId = ref<string | null>(null)
/** 插入位置在列表末尾。 */
const dropAtEnd = ref(false)

function onDragStart(event: DragEvent) {
  // 拖动由卡片里的把手发起；.task-slot 上带 data-task-id，
  // 这样不依赖 dragstart 阶段能否读到 dataTransfer。
  const slot = (event.target as HTMLElement | null)?.closest('.task-slot') as HTMLElement | null
  dragId.value = slot?.dataset.taskId || event.dataTransfer?.getData('text/plain') || null
}

/** 目标插入点在「移除拖动项之后」的数组中的下标。 */
function insertionOf(event: DragEvent, task: Task): number | null {
  const source = dragId.value
  if (!source) return null
  const rest = props.tasks.map((entry) => entry.id).filter((id) => id !== source)
  const target = rest.indexOf(task.id)
  if (target < 0) return null
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return target + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)
}

function onDragOver(event: DragEvent, task: Task) {
  if (!dragId.value || dragId.value === task.id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const insert = insertionOf(event, task)
  if (insert === null) return
  const rest = props.tasks.filter((entry) => entry.id !== dragId.value)
  if (insert >= rest.length) {
    dropBeforeId.value = null
    dropAtEnd.value = true
  } else {
    dropBeforeId.value = rest[insert].id
    dropAtEnd.value = false
  }
}

function onDrop(event: DragEvent, task: Task) {
  event.preventDefault()
  const source = dragId.value
  if (!source || source === task.id) {
    resetDrag()
    return
  }
  const insert = insertionOf(event, task)
  const ids = props.tasks.map((entry) => entry.id).filter((id) => id !== source)
  ids.splice(insert ?? ids.length, 0, source)
  resetDrag()
  emit('reorder', ids)
}

function resetDrag() {
  dragId.value = null
  dropBeforeId.value = null
  dropAtEnd.value = false
}

function moveBy(task: Task, delta: number) {
  const ids = props.tasks.map((entry) => entry.id)
  const index = ids.indexOf(task.id)
  const next = index + delta
  if (index < 0 || next < 0 || next >= ids.length) return
  ids.splice(index, 1)
  ids.splice(next, 0, task.id)
  emit('reorder', ids)
}
</script>

<template>
  <div v-if="tasks.length === 0" class="empty">
    还没有任务。点右上角「新建任务」，把 curl 粘进来，先试跑确认能通，再选择执行时间保存。
  </div>
  <div v-else class="task-list" :class="{ 'is-drop-end': dropAtEnd }" @dragend="resetDrag">
    <div
      v-for="task in tasks"
      :key="task.id"
      :data-task-id="task.id"
      :class="{
        'is-insert-before': dropBeforeId === task.id,
        'is-dragging': dragId === task.id,
      }"
      class="task-slot"
      @dragstart="onDragStart"
      @dragover="onDragOver($event, task)"
      @drop="onDrop($event, task)"
    >
      <TaskCard
        :task="task"
        :now="now"
        :selected="task.id === selectedId"
        :busy="busyId === task.id"
        @select="emit('select', $event)"
        @run="emit('run', $event)"
        @edit="emit('edit', $event)"
        @test="emit('test', $event)"
        @pause="emit('pause', $event)"
        @resume-pause="emit('resumePause', $event)"
        @stop="emit('stop', $event)"
        @start="emit('start', $event)"
        @remove="emit('remove', $event)"
        @move="moveBy"
      />
    </div>
  </div>
</template>

<style scoped>
/* 拖动排序：卡片上/下边缘的吸附指示线（从中间展开的小动画）。 */
.task-slot {
  position: relative;
}

.task-slot::before {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  top: -6px;
  height: 3px;
  border-radius: 999px;
  background: #2563eb;
  opacity: 0;
  transform: scaleX(0);
  transition: opacity 0.12s ease, transform 0.18s ease;
  pointer-events: none;
  z-index: 2;
}

.task-slot.is-insert-before::before {
  opacity: 1;
  transform: scaleX(1);
}

.task-slot.is-dragging {
  opacity: 0.5;
}

.task-list.is-drop-end::after {
  content: '';
  display: block;
  height: 3px;
  margin-top: 1px;
  border-radius: 999px;
  background: #2563eb;
  animation: drop-end-in 0.18s ease;
}

@keyframes drop-end-in {
  from {
    opacity: 0;
    transform: scaleX(0.2);
  }
  to {
    opacity: 1;
    transform: scaleX(1);
  }
}
</style>
