<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs, { type Dayjs } from 'dayjs'
import { getHolidayMonth } from '@/api/system'
import type { DayInfo, HolidayMonthResponse } from '@/types/system'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const value = ref<Dayjs>(dayjs())
const data = ref<HolidayMonthResponse | null>(null)
const loading = ref(false)
const error = ref('')

/** 按日期建索引：日历格子渲染时直接查。 */
const dayMap = computed(() => {
  const map = new Map<string, DayInfo>()
  for (const day of data.value?.days ?? []) map.set(day.date, day)
  return map
})

function infoOf(date: Dayjs): DayInfo | undefined {
  return dayMap.value.get(date.format('YYYY-MM-DD'))
}

/** 格子里的角标：法定节假日写节日名，其余写短标签。 */
function cellLabel(date: Dayjs): string {
  const info = infoOf(date)
  if (!info) return ''
  if (info.dayType === 'holiday') return info.name || t('calendar.cellHoliday')
  if (info.dayType === 'makeup') {
    return info.name ? t('calendar.cellMakeup', { name: info.name }) : t('calendar.cellMakeupShort')
  }
  if (info.dayType === 'weekend') return t('calendar.cellWeekend')
  return t('calendar.cellWorkday')
}

function cellClass(date: Dayjs): string {
  const info = infoOf(date)
  if (!info) return 'is-plain'
  if (!info.authoritative) return 'is-uncertain'
  return `is-${info.dayType}`
}

function isToday(date: Dayjs): boolean {
  return date.format('YYYY-MM-DD') === dayjs().format('YYYY-MM-DD')
}

const summary = computed(() => {
  const days = data.value?.days ?? []
  const count = (type: string) => days.filter((day) => day.dayType === type).length
  return {
    workday: count('workday'),
    weekend: count('weekend'),
    holiday: count('holiday'),
    makeup: count('makeup'),
  }
})

async function load(date: Dayjs): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    data.value = await getHolidayMonth(date.year(), date.month() + 1)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    data.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load(value.value)
  },
)

// 日历翻月 / 选月后重新拉取该月数据（同一月内只改选中日期时不再请求）。
watch(value, (date) => {
  if (!props.open || !date) return
  if (data.value && data.value.year === date.year() && data.value.month === date.month() + 1) {
    return
  }
  void load(date)
})

const monthTitle = computed(() =>
  data.value
    ? t('calendar.monthTitle', { year: data.value.year, month: data.value.month })
    : t('calendar.monthTitle', { year: value.value.year(), month: value.value.month() + 1 }),
)

function shiftMonth(delta: number): void {
  value.value = value.value.add(delta, 'month')
}
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('calendar.title')"
    width="min(880px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <div class="cal-head">
      <div class="cal-nav">
        <a-button size="small" @click="shiftMonth(-1)">{{ $t('calendar.prevMonth') }}</a-button>
        <span class="cal-title">{{ monthTitle }}</span>
        <a-button size="small" @click="shiftMonth(1)">{{ $t('calendar.nextMonth') }}</a-button>
        <a-button size="small" type="text" @click="value = dayjs()">
          {{ $t('calendar.backToday') }}
        </a-button>
      </div>
      <div class="cal-legend">
        <a-tag color="success">{{ $t('calendar.legendWorkday', { count: summary.workday }) }}</a-tag>
        <a-tag color="blue">{{ $t('calendar.legendWeekend', { count: summary.weekend }) }}</a-tag>
        <a-tag color="red">{{ $t('calendar.legendHoliday', { count: summary.holiday }) }}</a-tag>
        <a-tag color="purple">{{ $t('calendar.legendMakeup', { count: summary.makeup }) }}</a-tag>
      </div>
    </div>

    <a-alert v-if="error" type="error" show-icon :message="error" style="margin-bottom: 10px" />

    <a-spin :spinning="loading">
      <a-calendar v-model:value="value" :fullscreen="true" class="cal-panel">
        <template #fullCellRender="{ date }">
          <div class="cal-cell" :class="[cellClass(date), { 'is-today': isToday(date) }]">
            <span class="cal-cell-day">{{ date.date() }}</span>
            <span v-if="cellLabel(date)" class="cal-cell-label">{{ cellLabel(date) }}</span>
          </div>
        </template>
      </a-calendar>
    </a-spin>

    <p class="field-hint" style="margin: 12px 0 0">
      {{ $t('calendar.hint') }}
    </p>
  </a-modal>
</template>

<style scoped>
.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.cal-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cal-title {
  font-size: 14px;
  font-weight: 650;
  min-width: 108px;
  text-align: center;
}

.cal-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.cal-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  min-height: 56px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
}

.cal-cell-day {
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.cal-cell-label {
  font-size: 11px;
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cal-cell.is-workday .cal-cell-label {
  color: var(--ok);
}

.cal-cell.is-weekend .cal-cell-label {
  color: #2b6cb0;
}

.cal-cell.is-holiday {
  background: #fff1f0;
  border-color: #ffccc7;
}

.cal-cell.is-holiday .cal-cell-label {
  color: var(--err);
  font-weight: 600;
}

.cal-cell.is-makeup {
  background: #f6f0ff;
  border-color: #d9c7ff;
}

.cal-cell.is-makeup .cal-cell-label {
  color: #722ed1;
  font-weight: 600;
}

.cal-cell.is-uncertain {
  opacity: 0.55;
}

.cal-cell.is-today {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.cal-panel :deep(.ant-picker-cell-inner) {
  width: 100%;
}
</style>
