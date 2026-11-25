<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
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

const { t } = useI18n()

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
    app.setStatus(
      t('deleteTask.statusDeleted', { name: task.name, count: data.deleted_logs ?? 0 }),
    )
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
    :title="$t('deleteTask.title')"
    :ok-text="$t('deleteTask.okText')"
    :ok-button-props="{ danger: true, disabled: !matches }"
    :confirm-loading="busy"
    @update:open="emit('update:open', $event)"
    @ok="confirm"
  >
    <p style="margin-top: 0">
      {{ $t('deleteTask.contentBefore') }}<strong>{{ task?.name }}</strong
      >{{ $t('deleteTask.contentAfter') }}
    </p>
    <a-alert type="warning" show-icon :message="$t('deleteTask.warning')" />
    <div class="field" style="margin-top: 12px">
      <label class="field-label">
        {{ $t('deleteTask.confirmLabel') }}
        <span class="mono">{{ task?.name }}</span>
      </label>
      <a-input v-model:value="input" :placeholder="task?.name" @press-enter="confirm" />
    </div>
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 10px" />
  </a-modal>
</template>
