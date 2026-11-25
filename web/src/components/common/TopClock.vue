<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DayInfo } from '@/types/system'
import { pad } from '@/utils/format'

const props = defineProps<{
  /** 每秒推进的时间戳。 */
  now: number
  /** 今天（或服务端当前时刻）的归类。 */
  today: DayInfo | null
}>()

const emit = defineEmits<{ openCalendar: [] }>()

const { t } = useI18n()

/** 星期几：按当前语言取。 */
const WEEKDAY_KEYS = [
  'clock.sunday',
  'clock.monday',
  'clock.tuesday',
  'clock.wednesday',
  'clock.thursday',
  'clock.friday',
  'clock.saturday',
] as const

const clock = computed(() => {
  const date = new Date(props.now)
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    weekday: t(WEEKDAY_KEYS[date.getDay()]),
  }
})

/** 顶栏的今日标签：法定节假日 / 调休上班 / 休息日 / 工作日。 */
const dayTag = computed(() => {
  const today = props.today
  if (!today) return null
  switch (today.dayType) {
    case 'holiday':
      return {
        color: 'red',
        text: today.name ? t('clock.holidayNamed', { name: today.name }) : t('clock.holiday'),
        title: today.name ? t('clock.holidayTitle', { name: today.name }) : t('clock.holiday'),
      }
    case 'makeup':
      return {
        color: 'purple',
        text: today.name ? t('clock.makeupNamed', { name: today.name }) : t('clock.makeup'),
        title: today.name ? t('clock.makeupTitle', { name: today.name }) : t('clock.makeup'),
      }
    case 'weekend':
      return { color: 'blue', text: t('clock.weekend'), title: t('clock.weekendTitle') }
    default:
      return { color: 'success', text: t('clock.workday'), title: t('clock.workday') }
  }
})

const dayTitle = computed(() => {
  if (!props.today) return ''
  return props.today.authoritative ? '' : t('clock.uncertain')
})
</script>

<template>
  <button
    type="button"
    class="top-clock"
    :title="t('clock.title')"
    @click="emit('openCalendar')"
  >
    <span class="top-clock-time">{{ clock.time }}</span>
    <span class="top-clock-date">{{ clock.date }}</span>
    <span class="top-clock-weekday">{{ clock.weekday }}</span>
    <a-tag v-if="dayTag" :color="dayTag.color" class="top-clock-tag">
      {{ dayTag.text }}{{ dayTitle }}
    </a-tag>
  </button>
</template>

<style scoped>
.top-clock {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
  color: inherit;
  line-height: 1.8;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}

.top-clock:hover {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.top-clock-time {
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.top-clock-date {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.top-clock-weekday {
  font-size: 12.5px;
  color: var(--muted);
}

.top-clock-tag {
  margin-inline-end: 0;
}
</style>
