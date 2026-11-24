<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CleanupPreview, CleanupResult } from '@/types/system'
import { cleanupLogs, cleanupPreview } from '@/api/system'
import { useAppStore } from '@/stores/app'
import { formatBytes, formatTime } from '@/utils/format'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  done: []
}>()

const app = useAppStore()

const view = ref<'loading' | 'content' | 'error' | 'running' | 'result'>('loading')
const preview = ref<CleanupPreview | null>(null)
const selected = ref<number | 'all' | null>(null)
const confirmed = ref(false)
const allInput = ref('')
const error = ref('')
const result = ref<CleanupResult | null>(null)

const isAll = computed(() => selected.value === 'all')

const selectedOption = computed(() => {
  if (!preview.value || selected.value === null) return null
  if (selected.value === 'all') {
    return { count: preview.value.all.count, bytes: preview.value.all.bytes }
  }
  const option = preview.value.options.find((entry) => entry.days === selected.value)
  return option ? { count: option.count, bytes: option.bytes } : null
})

const canExecute = computed(() => {
  if (!selectedOption.value || selectedOption.value.count === 0) return false
  return isAll.value ? allInput.value.trim() === '删除全部' : confirmed.value
})

const impact = computed(() => {
  if (!selectedOption.value || !preview.value) return '请选择一个清理范围。'
  const count = selectedOption.value.count
  if (isAll.value) {
    return `将删除全部 ${count} 条日志（约 ${formatBytes(
      selectedOption.value.bytes,
    )}），清理后日志表为空。`
  }
  const remaining = Math.max(0, preview.value.total_count - count)
  return `将删除 ${count} 条日志（约 ${formatBytes(
    selectedOption.value.bytes,
  )}），保留 ${remaining} 条较新的日志。`
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    view.value = 'loading'
    preview.value = null
    selected.value = null
    confirmed.value = false
    allInput.value = ''
    error.value = ''
    result.value = null
    try {
      const data = await cleanupPreview()
      preview.value = data
      const first = data.options.find((option) => option.count > 0)
      selected.value = first ? first.days : null
      view.value = 'content'
    } catch (err) {
      error.value = `统计失败：${err instanceof Error ? err.message : String(err)}`
      view.value = 'error'
    }
  },
)

function choose(value: number | 'all') {
  selected.value = value
  confirmed.value = false
  allInput.value = ''
}

async function execute() {
  if (!preview.value || selected.value === null || !canExecute.value) return
  view.value = 'running'
  error.value = ''
  try {
    const body =
      selected.value === 'all'
        ? { all: true, confirm: 'DELETE_ALL' }
        : {
            days: selected.value,
            confirm: true,
            ...(Number.isInteger(
              preview.value.options.find((entry) => entry.days === selected.value)?.cutoff,
            )
              ? {
                  cutoff: preview.value.options.find((entry) => entry.days === selected.value)
                    ?.cutoff,
                }
              : {}),
          }
    const data = await cleanupLogs(body)
    result.value = data
    view.value = 'result'
    app.setStatus(`已删除 ${data.deleted} 条日志，释放 ${formatBytes(data.reclaimed_bytes)}`)
    emit('done')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error.value = message.includes('请求超时')
      ? '清理请求超时断开：后台可能仍在压缩数据库，稍后刷新查看占用空间再确认是否需要重试。'
      : `清理失败：${message}`
    view.value = 'error'
  }
}
</script>

<template>
  <a-modal
    :open="open"
    title="清理日志"
    width="min(680px, 94vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="view === 'loading'" class="empty">正在统计日志占用…</div>

    <template v-else-if="view === 'error'">
      <a-alert type="error" :message="error" show-icon />
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
        <a-button @click="emit('update:open', false)">关闭</a-button>
        <a-button type="primary" @click="emit('update:open', false)">知道了</a-button>
      </div>
    </template>

    <template v-else-if="view === 'running'">
      <div class="empty">正在清理并压缩数据库，可能需要一段时间…</div>
      <a-spin />
    </template>

    <template v-else-if="view === 'result' && result">
      <a-result status="success" title="清理完成" :sub-title="`已删除 ${result.deleted} 条日志`">
        <template #extra>
          <a-descriptions :column="2" size="small" bordered>
            <a-descriptions-item label="删除条数">{{ result.deleted }} 条</a-descriptions-item>
            <a-descriptions-item label="剩余条数">{{ result.remaining }} 条</a-descriptions-item>
            <a-descriptions-item label="释放空间">{{ formatBytes(result.reclaimed_bytes) }}</a-descriptions-item>
            <a-descriptions-item label="合计占用">
              {{ formatBytes(result.storage_before?.total_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.total_bytes ?? 0) }}
            </a-descriptions-item>
            <a-descriptions-item label="数据库文件">
              {{ formatBytes(result.storage_before?.db_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.db_bytes ?? 0) }}
            </a-descriptions-item>
            <a-descriptions-item label="WAL 文件">
              {{ formatBytes(result.storage_before?.wal_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.wal_bytes ?? 0) }}
            </a-descriptions-item>
          </a-descriptions>
          <a-alert
            v-if="result.vacuum_error"
            type="warning"
            show-icon
            style="margin-top: 10px"
            :message="`空间回收未完成：${result.vacuum_error}。日志行已删除，但数据库文件可能没有缩小。`"
          />
        </template>
      </a-result>
      <div style="display: flex; justify-content: flex-end">
        <a-button type="primary" @click="emit('update:open', false)">关闭</a-button>
      </div>
    </template>

    <template v-else-if="preview">
      <a-descriptions :column="2" size="small" bordered style="margin-bottom: 12px">
        <a-descriptions-item label="日志条数">{{ preview.total_count }} 条</a-descriptions-item>
        <a-descriptions-item label="日志占用">{{ formatBytes(preview.total_bytes) }}</a-descriptions-item>
        <a-descriptions-item label="数据库文件">{{ formatBytes(preview.storage.db_bytes) }}</a-descriptions-item>
        <a-descriptions-item label="WAL 文件">{{ formatBytes(preview.storage.wal_bytes) }}</a-descriptions-item>
        <a-descriptions-item label="合计占用">{{ formatBytes(preview.storage.total_bytes) }}</a-descriptions-item>
        <a-descriptions-item label="时间范围">
          <template v-if="preview.oldest_executed_at && preview.newest_executed_at">
            {{ formatTime(preview.oldest_executed_at) }} → {{ formatTime(preview.newest_executed_at) }}
          </template>
          <template v-else>没有可统计的范围</template>
        </a-descriptions-item>
      </a-descriptions>

      <div class="field">
        <label class="field-label">选择保留范围（按执行时间判断，不保留每任务最近记录）</label>
        <a-radio-group
          :value="selected"
          style="display: flex; flex-direction: column; gap: 6px; width: 100%"
          @update:value="choose($event as number | 'all')"
        >
          <a-radio
            v-for="option in preview.options"
            :key="option.days"
            :value="option.days"
            :disabled="option.count === 0"
            style="width: 100%"
          >
            保留最近 {{ option.label }}
            <span class="muted" style="margin-left: 8px">
              {{ option.count === 0 ? '无匹配日志' : `删除 ${option.count} 条 · 约 ${formatBytes(option.bytes)}` }}
            </span>
          </a-radio>
          <a-radio value="all" :disabled="preview.all.count === 0" style="width: 100%">
            全部清除
            <span class="muted" style="margin-left: 8px">
              {{ preview.all.count === 0 ? '无匹配日志' : `删除 ${preview.all.count} 条 · 约 ${formatBytes(preview.all.bytes)}` }}
            </span>
          </a-radio>
        </a-radio-group>
      </div>

      <a-alert :message="impact" :type="isAll ? 'warning' : 'info'" show-icon style="margin-top: 8px" />

      <div v-if="isAll" class="field" style="margin-top: 10px">
        <label class="field-label">输入「删除全部」确认 <span class="req">*</span></label>
        <a-input v-model:value="allInput" placeholder="删除全部" />
      </div>
      <div v-else class="field" style="margin-top: 10px">
        <a-checkbox v-model:checked="confirmed">我确认删除以上日志，此操作不可恢复</a-checkbox>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
        <a-button @click="emit('update:open', false)">取消</a-button>
        <a-button type="primary" danger :disabled="!canExecute" @click="execute">执行清理</a-button>
      </div>
    </template>
  </a-modal>
</template>
