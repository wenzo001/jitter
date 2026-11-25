<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CleanupPreview, CleanupResult } from '@/types/system'
import { cleanupLogs, cleanupPreview } from '@/api/system'
import { BACKEND_MARKERS } from '@/api/client'
import { useAppStore } from '@/stores/app'
import { formatBytes, formatTime } from '@/utils/format'

const props = defineProps<{ open: boolean }>()
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
    return t('cleanup.impactAll', {
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
      error.value = t('cleanup.statFailed', {
        error: err instanceof Error ? err.message : String(err),
      })
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
            {{ $t('cleanup.keepRecent', { label: option.label }) }}
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
            {{ $t('cleanup.clearAll') }}
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
