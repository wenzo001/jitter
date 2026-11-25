<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Task } from '@/types/task'
import { formatElapsed, pauseStateOf } from '@/utils/format'
import { conditionRows } from '@/utils/condition'

const props = defineProps<{
  task: Task
  now: number
}>()

const { t } = useI18n()

const rows = computed(() => conditionRows(props.task, t))

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
          <strong>{{ $t('condition.badgeTitle') }}</strong>
          <span class="muted" style="font-size: 12px">{{ $t('condition.badgeSubtitle') }}</span>
        </div>
        <div v-if="rows.length" class="condition-list">
          <div v-for="row in rows" :key="row.key" class="condition-row">
            <span class="condition-label">{{ row.label }}</span>
            <span class="condition-value" :class="{ mono: row.mono }">{{ row.value }}</span>
          </div>
        </div>
        <div v-else class="condition-empty">{{ $t('condition.badgeEmpty') }}</div>
        <p class="condition-note">{{ $t('condition.badgeNote') }}</p>
      </div>
    </template>
    <a-tag color="blue" class="condition-trigger" tabindex="0">{{ $t('condition.badgeTitle') }}</a-tag>
  </a-popover>

  <a-tooltip v-if="task.schedule_error" :title="task.schedule_error">
    <a-tag color="error">{{ $t('condition.invalidSchedule') }}</a-tag>
  </a-tooltip>

  <a-tag v-if="task.status !== 'active'" color="default">{{ $t('condition.disabled') }}</a-tag>
  <a-tag v-else-if="pause" :color="pause.started ? 'orange' : 'gold'">
    {{ pause.started ? $t('condition.paused') : $t('condition.pendingPause') }}
  </a-tag>
  <a-tag v-else color="success">{{ $t('condition.scheduling') }}</a-tag>

  <a-tag v-if="task.running" color="processing">
    {{ $t('condition.runningTag', { value: formatElapsed(now - (task.running_since ?? now)) }) }}
  </a-tag>

  <a-tag v-if="task.run_on_startup === 1" color="default">
    {{ $t('condition.runOnStartupTag') }}
  </a-tag>
  <a-tag v-if="insecure" color="warning">{{ $t('condition.skipTls') }}</a-tag>
</template>
