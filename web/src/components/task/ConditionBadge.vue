<script setup lang="ts">
import { computed } from 'vue'
import type { Task } from '@/types/task'
import { formatElapsed, pauseStateOf } from '@/utils/format'
import { conditionRows } from '@/utils/condition'

const props = defineProps<{
  task: Task
  now: number
}>()

const rows = computed(() => conditionRows(props.task))

const pause = computed(() => (props.task.status === 'active' ? pauseStateOf(props.task) : null))

const insecure = computed(() => {
  try {
    const options = JSON.parse(props.task.request_options ?? '{}') as { insecure?: boolean }
    return options.insecure === true
  } catch {
    return false
  }
})
</script>

<template>
  <a-popover :trigger="['hover', 'focus', 'click']" placement="bottomLeft" :mouse-enter-delay="0.1">
    <template #content>
      <div class="condition-pop">
        <div class="condition-pop-head">
          <strong>执行条件</strong>
          <span class="muted" style="font-size: 12px">仅约束定时执行</span>
        </div>
        <div v-if="rows.length" class="condition-list">
          <div v-for="row in rows" :key="row.key" class="condition-row">
            <span class="condition-label">{{ row.label }}</span>
            <span class="condition-value" :class="{ mono: row.mono }">{{ row.value }}</span>
          </div>
        </div>
        <div v-else class="condition-empty">已开启执行条件，但没有限制项：每次都会执行。</div>
        <p class="condition-note">
          任一条件不满足会跳过本次并在执行记录里写明原因。页面上的「立即执行」不受这些条件限制。
        </p>
      </div>
    </template>
    <a-tag color="blue" class="condition-trigger" tabindex="0">执行条件</a-tag>
  </a-popover>

  <a-tooltip v-if="task.schedule_error" :title="task.schedule_error">
    <a-tag color="error">调度配置无效</a-tag>
  </a-tooltip>

  <a-tag v-if="task.status !== 'active'" color="default">已停用</a-tag>
  <a-tag v-else-if="pause" :color="pause.started ? 'orange' : 'gold'">
    {{ pause.started ? '暂停中' : '待暂停' }}
  </a-tag>
  <a-tag v-else color="success">调度中</a-tag>

  <a-tag v-if="task.running" color="processing">
    执行中 · {{ formatElapsed(now - (task.running_since ?? now)) }}
  </a-tag>

  <a-tag v-if="task.run_on_startup === 1" color="default">开机执行一次</a-tag>
  <a-tag v-if="insecure" color="warning">跳过 TLS 校验</a-tag>
</template>
