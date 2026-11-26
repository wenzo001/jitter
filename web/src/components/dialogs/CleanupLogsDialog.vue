<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CleanupPreview, CleanupResult } from '@/types/system'
import { cleanupLogs, cleanupPreview } from '@/api/system'
import { BACKEND_MARKERS } from '@/api/client'
import { useAppStore } from '@/stores/app'
import { formatBytes, formatTime } from '@/utils/format'
import {
  cleanupRequestBody,
  defaultCleanupScope,
  effectiveCleanupTaskId,
  type CleanupScope,
} from '@/utils/cleanup-scope'

const props = defineProps<{
  open: boolean
  /** 限定清理某个任务；为空表示「全部任务」。 */
  taskId?: string | null
  /** 任务名（界面上显示范围用）。 */
  taskName?: string
}>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  done: []
}>()

const { t } = useI18n()

const app = useAppStore()

const view = ref<'loading' | 'content' | 'error' | 'running' | 'result'>('loading')
const preview = ref<CleanupPreview | null>(null)
const selected = ref<number | 'all' | null>(null)
const confirmed = ref(false)
const allInput = ref('')
const error = ref('')
const result = ref<CleanupResult | null>(null)
/** 清理范围：只清当前任务，还是清全部任务。 */
const scope = ref<CleanupScope>('all')
/** 打开弹窗时抑制 scope 的 watch，避免同一次打开拉两遍预检。 */
let suppressScopeWatch = false

/** 实际生效的任务范围：选「全部任务」时不带 task_id。 */
const effectiveTaskId = computed(() => effectiveCleanupTaskId(scope.value, props.taskId))

const scopeLabel = computed(() =>
  scope.value === 'task' && props.taskName
    ? t('cleanup.scopeTask', { name: props.taskName })
    : t('cleanup.scopeAll'),
)

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
  return isAll.value ? allInput.value.trim() === t('cleanup.confirmKeyword') : confirmed.value
})

const impact = computed(() => {
  if (!selectedOption.value || !preview.value) return t('cleanup.impactNone')
  const count = selectedOption.value.count
  if (isAll.value) {
    return scope.value === 'task'
      ? t('cleanup.impactAllTask', {
          count,
          size: formatBytes(selectedOption.value.bytes),
        })
      : t('cleanup.impactAll', {
          count,
          size: formatBytes(selectedOption.value.bytes),
        })
  }
  const remaining = Math.max(0, preview.value.total_count - count)
  return t('cleanup.impactSome', {
    count,
    size: formatBytes(selectedOption.value.bytes),
    remaining,
  })
})

/** 拉一次当前范围的预检。 */
async function loadPreview() {
  view.value = 'loading'
  preview.value = null
  selected.value = null
  confirmed.value = false
  allInput.value = ''
  error.value = ''
  try {
    const data = await cleanupPreview(effectiveTaskId.value)
    preview.value = data
    const first = data.options.find((option) => option.count > 0)
    selected.value = first ? first.days : null
    view.value = 'content'
  } catch (err) {
    error.value = t('cleanup.statFailed', {
      error: err instanceof Error ? err.message : String(err),
    })
    view.value = 'error'
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    // 从任务面板进来默认只清这个任务；从设置进来默认清全部任务。
    // scope 的 watch 在下一轮 flush 才跑，这里先把它压住，避免同一次打开拉两遍预检。
    suppressScopeWatch = true
    scope.value = defaultCleanupScope(props.taskId)
    result.value = null
    await nextTick()
    await loadPreview()
    suppressScopeWatch = false
  },
)

// 切换范围要重新拉预检：两边的条数、占用都不一样。
watch(scope, async () => {
  if (!props.open || suppressScopeWatch) return
  result.value = null
  await loadPreview()
})

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
    const cutoff =
      selected.value === 'all'
        ? null
        : preview.value.options.find((entry) => entry.days === selected.value)?.cutoff
    const body = cleanupRequestBody(scope.value, effectiveTaskId.value, selected.value, cutoff)
    const data = await cleanupLogs(body)
    result.value = data
    view.value = 'result'
    app.setStatus(
      t('cleanup.deleted', {
        count: data.deleted,
        size: formatBytes(data.reclaimed_bytes),
      }),
    )
    emit('done')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error.value = message.includes(BACKEND_MARKERS.timeout)
      ? t('cleanup.timeout')
      : t('cleanup.failed', { error: message })
    view.value = 'error'
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('cleanup.title')"
    width="min(680px, 94vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="view === 'loading'" class="empty">{{ $t('cleanup.loading') }}</div>

    <template v-else-if="view === 'error'">
      <a-alert type="error" :message="error" show-icon />
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
        <a-button @click="emit('update:open', false)">{{ $t('common.close') }}</a-button>
        <a-button type="primary" @click="emit('update:open', false)">{{ $t('common.gotIt') }}</a-button>
      </div>
    </template>

    <template v-else-if="view === 'running'">
      <div class="empty">{{ $t('cleanup.running') }}</div>
      <a-spin />
    </template>

    <template v-else-if="view === 'result' && result">
      <a-result
        status="success"
        :title="$t('cleanup.resultTitle')"
        :sub-title="$t('cleanup.resultSubtitle', { count: result.deleted })"
      >
        <template #extra>
          <a-descriptions :column="2" size="small" bordered>
            <a-descriptions-item :label="$t('cleanup.labelDeleted')">
              {{ $t('common.countUnit', { count: result.deleted }) }}
            </a-descriptions-item>
            <a-descriptions-item :label="$t('cleanup.labelRemaining')">
              {{ $t('common.countUnit', { count: result.remaining }) }}
            </a-descriptions-item>
            <a-descriptions-item :label="$t('cleanup.labelReclaimed')">
              {{ formatBytes(result.reclaimed_bytes) }}
            </a-descriptions-item>
            <a-descriptions-item :label="$t('cleanup.labelTotal')">
              {{ formatBytes(result.storage_before?.total_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.total_bytes ?? 0) }}
            </a-descriptions-item>
            <a-descriptions-item :label="$t('cleanup.labelDbFile')">
              {{ formatBytes(result.storage_before?.db_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.db_bytes ?? 0) }}
            </a-descriptions-item>
            <a-descriptions-item :label="$t('cleanup.labelWalFile')">
              {{ formatBytes(result.storage_before?.wal_bytes ?? 0) }} →
              {{ formatBytes(result.storage_after?.wal_bytes ?? 0) }}
            </a-descriptions-item>
          </a-descriptions>
          <a-alert
            v-if="result.vacuum_error"
            type="warning"
            show-icon
            style="margin-top: 10px"
            :message="$t('cleanup.vacuumError', { error: result.vacuum_error })"
          />
        </template>
      </a-result>
      <div style="display: flex; justify-content: flex-end">
        <a-button type="primary" @click="emit('update:open', false)">{{ $t('common.close') }}</a-button>
      </div>
    </template>

    <template v-else-if="preview">
      <!-- 先说清楚这次清的是谁，避免误删。 -->
      <div class="field" style="margin-bottom: 12px">
        <label class="field-label">{{ $t('cleanup.scopeLabel') }}</label>
        <a-radio-group
          :value="scope"
          style="display: flex; flex-direction: column; gap: 6px; width: 100%"
          @update:value="scope = $event as 'task' | 'all'"
        >
          <a-radio value="task" :disabled="!taskId" style="width: 100%">
            {{ taskName ? $t('cleanup.scopeTask', { name: taskName }) : $t('cleanup.scopeTaskNone') }}
            <span class="muted" style="margin-left: 8px">{{ $t('cleanup.scopeTaskHint') }}</span>
          </a-radio>
          <a-radio value="all" style="width: 100%">
            {{ $t('cleanup.scopeAll') }}
            <span class="muted" style="margin-left: 8px">{{ $t('cleanup.scopeAllHint') }}</span>
          </a-radio>
        </a-radio-group>
        <a-alert :message="scopeLabel" type="info" show-icon style="margin-top: 8px" />
      </div>

      <a-descriptions :column="2" size="small" bordered style="margin-bottom: 12px">
        <a-descriptions-item :label="$t('cleanup.labelTotalCount')">
          {{ $t('common.countUnit', { count: preview.total_count }) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('cleanup.labelTotalSize')">
          {{ formatBytes(preview.total_bytes) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('cleanup.labelDbFile')">
          {{ formatBytes(preview.storage.db_bytes) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('cleanup.labelWalFile')">
          {{ formatBytes(preview.storage.wal_bytes) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('cleanup.labelTotal')">
          {{ formatBytes(preview.storage.total_bytes) }}
        </a-descriptions-item>
        <a-descriptions-item :label="$t('cleanup.labelRange')">
          <template v-if="preview.oldest_executed_at && preview.newest_executed_at">
            {{ formatTime(preview.oldest_executed_at) }} → {{ formatTime(preview.newest_executed_at) }}
          </template>
          <template v-else>{{ $t('cleanup.noRange') }}</template>
        </a-descriptions-item>
      </a-descriptions>

      <div class="field">
        <label class="field-label">{{ $t('cleanup.rangeLabel') }}</label>
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
            {{ scope === 'task'
              ? $t('cleanup.keepRecentTask', { label: option.label })
              : $t('cleanup.keepRecent', { label: option.label }) }}
            <span class="muted" style="margin-left: 8px">
              {{
                option.count === 0
                  ? $t('cleanup.noMatch')
                  : $t('cleanup.deleteSummary', {
                      count: option.count,
                      size: formatBytes(option.bytes),
                    })
              }}
            </span>
          </a-radio>
          <a-radio value="all" :disabled="preview.all.count === 0" style="width: 100%">
            {{ scope === 'task' ? $t('cleanup.clearAllTask') : $t('cleanup.clearAllAll') }}
            <span class="muted" style="margin-left: 8px">
              {{
                preview.all.count === 0
                  ? $t('cleanup.noMatch')
                  : $t('cleanup.deleteSummary', {
                      count: preview.all.count,
                      size: formatBytes(preview.all.bytes),
                    })
              }}
            </span>
          </a-radio>
        </a-radio-group>
      </div>

      <a-alert :message="impact" :type="isAll ? 'warning' : 'info'" show-icon style="margin-top: 8px" />

      <div v-if="isAll" class="field" style="margin-top: 10px">
        <label class="field-label">
          {{ $t('cleanup.confirmLabel', { keyword: t('cleanup.confirmKeyword') }) }}
          <span class="req">*</span>
        </label>
        <a-input v-model:value="allInput" :placeholder="t('cleanup.confirmPlaceholder')" />
      </div>
      <div v-else class="field" style="margin-top: 10px">
        <a-checkbox v-model:checked="confirmed">{{ $t('cleanup.confirmCheckbox') }}</a-checkbox>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
        <a-button @click="emit('update:open', false)">{{ $t('common.cancel') }}</a-button>
        <a-button type="primary" danger :disabled="!canExecute" @click="execute">
          {{ $t('cleanup.execute') }}
        </a-button>
      </div>
    </template>
  </a-modal>
</template>
