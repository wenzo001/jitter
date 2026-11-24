import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { listTasks, reorderTasks } from '@/api/tasks'
import type { Task } from '@/types/task'

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<Task[]>([])
  const selectedId = ref<string | null>(null)
  const loading = ref(false)
  /** 每秒推进一次，用于「执行中 · 已 x 秒」徽标。 */
  const now = ref(Date.now())

  const selectedTask = computed(
    () => tasks.value.find((task) => task.id === selectedId.value) ?? null,
  )

  function select(id: string | null): void {
    if (selectedId.value === id) return
    selectedId.value = id
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const data = await listTasks()
      const next = data.tasks ?? []
      const previous = selectedId.value
      tasks.value = next
      if (previous && !next.some((task) => task.id === previous)) {
        selectedId.value = next[0]?.id ?? null
      } else if (!previous && next.length > 0) {
        selectedId.value = next[0].id
      }
    } finally {
      loading.value = false
    }
  }

  function tick(): void {
    now.value = Date.now()
  }

  async function applyOrder(ids: string[]): Promise<void> {
    const data = await reorderTasks(ids)
    tasks.value = data.tasks ?? tasks.value
  }

  return { tasks, selectedId, selectedTask, loading, now, select, load, tick, applyOrder }
})
