<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Task } from '@/types/task'
import { deleteTask } from '@/api/tasks'
import { useAppStore } from '@/stores/app'

const props = defineProps<{
  open: boolean
  task: Task | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  deleted: [id: string, name: string, deletedLogs: number]
}>()

const app = useAppStore()
const input = ref('')
const busy = ref(false)
const error = ref('')

const matches = computed(
  () => input.value.trim() !== '' && input.value.trim() === (props.task?.name ?? '').trim(),
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      input.value = ''
      error.value = ''
      busy.value = false
    }
  },
)

async function confirm() {
  const task = props.task
  if (!task || !matches.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const data = await deleteTask(task.id)
    app.setStatus(`已删除任务「${task.name}」及其 ${data.deleted_logs ?? 0} 条日志`)
    emit('deleted', task.id, task.name, data.deleted_logs ?? 0)
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
    title="删除任务"
    ok-text="确认删除"
    :ok-button-props="{ danger: true, disabled: !matches }"
    :confirm-loading="busy"
    @update:open="emit('update:open', $event)"
    @ok="confirm"
  >
    <p style="margin-top: 0">
      任务「<strong>{{ task?.name }}</strong>」及其全部历史日志、试跑记录将被永久删除。
    </p>
    <a-alert type="warning" show-icon message="此操作不可恢复。需要保留数据请先在「设置 → 备份」里新建备份。" />
    <div class="field" style="margin-top: 12px">
      <label class="field-label">请输入任务名称确认：<span class="mono">{{ task?.name }}</span></label>
      <a-input v-model:value="input" :placeholder="task?.name" @press-enter="confirm" />
    </div>
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 10px" />
  </a-modal>
</template>
