<script setup lang="ts">
/**
 * 运行日志面板：后台的运行日志按天落盘，这里可以随时回看、复制内容。
 *
 * 大文件按字节偏移分页读取（服务端限制单次最多 512KB），
 * 「加载更多」继续往后读，「回到开头」重新读第一段。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import { listRuntimeLogs, readRuntimeLog } from '@/api/system'
import type { LogFileInfo } from '@/types/system'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()
const { copy } = useClipboard()

const CHUNK_BYTES = 64 * 1024

const dir = ref('')
const retentionDays = ref(0)
const files = ref<LogFileInfo[]>([])
const current = ref('')
const content = ref('')
const nextOffset = ref(0)
const totalSize = ref(0)
const loading = ref(false)
const reading = ref(false)
const error = ref('')

const currentFile = computed(() => files.value.find((file) => file.name === current.value) ?? null)

const hasMore = computed(() => nextOffset.value > 0 && nextOffset.value < totalSize.value)

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

async function loadFiles(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const data = await listRuntimeLogs()
    dir.value = data.dir ?? ''
    retentionDays.value = data.retentionDays ?? 0
    files.value = data.files ?? []
    if (!files.value.find((file) => file.name === current.value)) {
      current.value = files.value[0]?.name ?? ''
    }
    if (current.value) await readFrom(0)
    else {
      content.value = ''
      nextOffset.value = 0
      totalSize.value = 0
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function readFrom(offset: number): Promise<void> {
  if (!current.value) return
  reading.value = true
  error.value = ''
  try {
    const chunk = await readRuntimeLog(current.value, offset, CHUNK_BYTES)
    content.value = offset === 0 ? chunk.content : content.value + chunk.content
    nextOffset.value = chunk.next_offset
    totalSize.value = chunk.size
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    reading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore.value) return
  await readFrom(nextOffset.value)
}

async function reload(): Promise<void> {
  await loadFiles()
}

async function copyAll(): Promise<void> {
  // 剪贴板不可用时忽略：内容仍在框里，用户可以手动选中。
  await copy(content.value)
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadFiles()
  },
)

watch(current, (name, previous) => {
  if (!name || name === previous) return
  content.value = ''
  nextOffset.value = 0
  void readFrom(0)
})

/** 下拉框的值可能是 undefined，统一转成字符串。 */
function onSelectChange(value: unknown): void {
  current.value = typeof value === 'string' ? value : ''
}
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('runtimeLogs.title')"
    width="min(980px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <div class="log-toolbar">
      <a-select
        :value="current"
        :options="files.map((file) => ({ value: file.name, label: `${file.name}（${formatSize(file.size)}）` }))"
        :placeholder="t('runtimeLogs.placeholder')"
        style="min-width: 260px"
        :loading="loading"
        :disabled="!files.length"
        @update:value="onSelectChange"
      />
      <span class="muted">
        {{ $t('runtimeLogs.summary', { count: files.length, days: retentionDays }) }}
        <template v-if="currentFile">
          · {{ $t('runtimeLogs.lastModified', { time: formatTime(currentFile.modified_at) }) }}
        </template>
      </span>
      <div class="log-toolbar-actions">
        <a-button size="small" @click="reload">{{ $t('common.refresh') }}</a-button>
        <a-button size="small" :disabled="!content" @click="copyAll">
          {{ $t('runtimeLogs.copyContent') }}
        </a-button>
      </div>
    </div>

    <div class="log-dir muted">
      <span class="mono">{{ $t('runtimeLogs.logDir', { dir: dir || '—' }) }}</span>
    </div>

    <a-alert v-if="error" type="error" show-icon :message="error" style="margin-bottom: 10px" />

    <a-spin :spinning="loading || reading">
      <pre class="log-view">{{ content || $t('runtimeLogs.empty') }}</pre>
    </a-spin>

    <div class="log-footer">
      <span class="muted">
        {{ $t('runtimeLogs.readProgress', { read: formatSize(nextOffset), total: formatSize(totalSize) }) }}
      </span>
      <a-button size="small" :disabled="!hasMore" :loading="reading" @click="loadMore">
        {{ $t('runtimeLogs.loadMore') }}
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.log-toolbar-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.log-dir {
  font-size: 12px;
  margin-bottom: 10px;
  word-break: break-all;
}

.log-view {
  margin: 0;
  max-height: calc(100vh - 340px);
  overflow: auto;
  padding: 12px 14px;
  background: #0f172a;
  color: #dbe4f0;
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.log-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
</style>
