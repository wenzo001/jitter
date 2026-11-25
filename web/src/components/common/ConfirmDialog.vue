<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  open: boolean
  title: string
  content?: string
  okText?: string
  cancelText?: string
  danger?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

const { t } = useI18n()
</script>

<template>
  <a-modal
    :open="open"
    :title="title"
    :ok-text="okText || t('common.ok')"
    :cancel-text="cancelText || t('common.cancel')"
    :confirm-loading="loading"
    :ok-button-props="danger ? { danger: true } : undefined"
    @update:open="emit('update:open', $event)"
    @ok="emit('confirm')"
    @cancel="emit('update:open', false)"
  >
    <p v-if="content" style="margin: 0; line-height: 1.7">{{ content }}</p>
    <slot />
  </a-modal>
</template>
