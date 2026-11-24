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
const overId = ref<string | null>(null)

function onDragStart(event: DragEvent) {
  dragId.value = event.dataTransfer?.getData('text/plain') || null
}

function onDragOver(event: DragEvent, task: Task) {
  if (!dragId.value || dragId.value === task.id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  overId.value = task.id
}

function onDrop(event: DragEvent, task: Task) {
  event.preventDefault()
  const source = dragId.value
  const target = task.id
  if (!source || source === target) {
    resetDrag()
    return
  }
  const ids = props.tasks.map((entry) => entry.id)
  const from = ids.indexOf(source)
  if (from < 0) {
    resetDrag()
    return
  }
  ids.splice(from, 1)
  let index = ids.indexOf(target)
  if (index < 0) index = ids.length
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (event.clientY > rect.top + rect.height / 2) index += 1
  ids.splice(index, 0, source)
  resetDrag()
  emit('reorder', ids)
}

function resetDrag() {
  dragId.value = null
  overId.value = null
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
    还没有任务。把 curl 粘到下面的表单，点「先试跑」确认能通，再选择执行时间保存。
  </div>
  <div v-else class="task-list" @dragend="resetDrag">
    <div
      v-for="task in tasks"
      :key="task.id"
      :class="{ 'is-drop': overId === task.id && dragId !== task.id }"
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
.task-slot.is-drop {
  border-radius: 10px;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.35);
}
</style>
