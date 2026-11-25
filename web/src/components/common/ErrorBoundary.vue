<script setup lang="ts">
/**
 * 错误边界：某个区域渲染出错时，不让整页白屏。
 *
 * 出错后展示可读说明 + 三个动作（重试 / 复制诊断 / 打开诊断面板），
 * 并把异常记进诊断 store，用户可以随时回看。
 */
import { computed, onErrorCaptured, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClipboard } from '@vueuse/core'
import { useDiagnosticsStore } from '@/stores/diagnostics'

const props = defineProps<{ label?: string }>()
const emit = defineEmits<{ openDiagnostics: [] }>()

const { t } = useI18n()

const diagnostics = useDiagnosticsStore()
const failed = ref(false)
const message = ref('')
const hint = ref('')
const { copy } = useClipboard()

/** 区域名称：没传就用默认的「页面区域」。 */
const labelText = computed(() => props.label || t('errorBoundary.defaultLabel'))

onErrorCaptured((error, _instance, info) => {
  const entry = diagnostics.reportError(
    info
      ? t('errorBoundary.renderFailedWithInfo', { label: labelText.value, info })
      : t('errorBoundary.renderFailed', { label: labelText.value }),
    error,
  )
  failed.value = true
  message.value = entry.message
  hint.value = entry.hint
  // 返回 false：不再往上冒泡，避免触发 app.config.errorHandler 造成重复记录。
  return false
})

function retry(): void {
  failed.value = false
  message.value = ''
  hint.value = ''
}

async function copyDetails(): Promise<void> {
  const text = t('errorBoundary.copyText', {
    label: labelText.value,
    message: message.value,
    hint: hint.value,
  })
  // 剪贴板不可用时静默失败，用户仍可在诊断面板里看。
  await copy(text)
}
</script>

<template>
  <div v-if="failed" class="error-boundary">
    <a-result
      status="error"
      :title="t('errorBoundary.title', { label: labelText })"
      :sub-title="message"
    >
      <template #extra>
        <p v-if="hint" class="error-boundary-hint">{{ hint }}</p>
        <div class="error-boundary-actions">
          <a-button type="primary" @click="retry">{{ $t('errorBoundary.retry') }}</a-button>
          <a-button @click="emit('openDiagnostics')">
            {{ $t('errorBoundary.openDiagnostics') }}
          </a-button>
          <a-button @click="copyDetails">{{ $t('errorBoundary.copyDetails') }}</a-button>
        </div>
        <p class="error-boundary-note">{{ $t('errorBoundary.note') }}</p>
      </template>
    </a-result>
  </div>
  <slot v-else />
</template>

<style scoped>
.error-boundary {
  padding: 24px 16px;
}

.error-boundary-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted, #6b7787);
  line-height: 1.7;
}

.error-boundary-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}

.error-boundary-note {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--muted, #6b7787);
}
</style>
