<script setup lang="ts">
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
</script>

<template>
  <a-modal
    :open="open"
    :title="title"
    :ok-text="okText || '确定'"
    :cancel-text="cancelText || '取消'"
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
