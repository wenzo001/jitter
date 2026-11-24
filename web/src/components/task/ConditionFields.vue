<script setup lang="ts">
import { computed } from 'vue'
import type { ConditionModel } from '@/types/form'
import { WEEKDAYS } from '@/utils/condition'

const props = defineProps<{
  modelValue: ConditionModel
  envText?: string
  errors?: Record<string, string>
  /** 节假日数据就绪：否则「工作日 / 休息日」选项禁用。 */
  holidayReady?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: ConditionModel]
}>()

const weekdayOptions = WEEKDAYS.map((day) => ({ label: `周${day.label}`, value: day.value }))

const weekdays = computed({
  get: () => props.modelValue.weekdays,
  set: (value: number[]) => patch('weekdays', value),
})

function patch<K extends keyof ConditionModel>(key: K, value: ConditionModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function error(key: string): string {
  return props.errors?.[key] ?? ''
}

/** TimePicker 配了 value-format 时运行时是字符串，类型上仍可能是 Dayjs。 */
function timeValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
</script>

<template>
  <div class="condition-fields">
    <div class="field">
      <label class="field-label">允许执行的星期</label>
      <a-checkbox-group v-model:value="weekdays" :options="weekdayOptions" />
      <p class="field-hint" style="margin-top: 4px">不选 = 每天都执行。</p>
    </div>

    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">执行时段开始</label>
        <a-time-picker
          :value="modelValue.timeStart"
          format="HH:mm"
          value-format="HH:mm"
          placeholder="例如 09:00"
          style="width: 100%"
          @update:value="patch('timeStart', timeValue($event))"
        />
        <div v-if="error('timeStart')" class="field-error">{{ error('timeStart') }}</div>
      </div>
      <div class="field">
        <label class="field-label">执行时段结束</label>
        <a-time-picker
          :value="modelValue.timeEnd"
          format="HH:mm"
          value-format="HH:mm"
          placeholder="例如 18:00"
          style="width: 100%"
          @update:value="patch('timeEnd', timeValue($event))"
        />
        <div v-if="error('timeEnd')" class="field-error">{{ error('timeEnd') }}</div>
      </div>
    </div>
    <p class="field-hint">结束早于开始表示跨午夜；开始和结束要同时填写，且不能相同。</p>

    <div class="field">
      <a-checkbox
        :checked="modelValue.requireAc"
        @change="patch('requireAc', ($event.target as HTMLInputElement).checked)"
      >
        只在接通电源（AC）时执行
      </a-checkbox>
    </div>

    <div class="field">
      <label class="field-label">执行日期类型</label>
      <a-radio-group
        :value="modelValue.dayType"
        :disabled="!holidayReady"
        @update:value="patch('dayType', ($event as '' | 'workday' | 'offday') ?? '')"
      >
        <a-radio value="">不限</a-radio>
        <a-radio value="workday">仅工作日</a-radio>
        <a-radio value="offday">仅休息日</a-radio>
      </a-radio-group>
      <p v-if="!holidayReady" class="field-hint warn" style="margin-top: 4px">
        节假日数据未就绪，暂时无法按工作日 / 休息日判断；可在「设置 → 节假日数据」里手动拉取。
        判断当天数据缺失时，该条件会被跳过。
      </p>
      <p v-else-if="modelValue.dayType" class="field-hint" style="margin-top: 4px">
        依据中国法定节假日数据（含调休上班日）判断；数据每年更新，失败时跳过该条件。
      </p>
    </div>

    <div class="field">
      <label class="field-label">只在本地 IP 匹配时执行</label>
      <a-input
        :value="modelValue.ipPattern"
        placeholder="例如 10.1.* 或 192.168.*,10.*"
        allow-clear
        @update:value="patch('ipPattern', $event)"
      />
      <p class="field-hint">
        <code>*</code> 匹配任意数字或点；多个范围用逗号分隔，任意一个匹配即可。
        <span v-if="envText" class="muted">（{{ envText }}）</span>
      </p>
    </div>

    <div class="field">
      <label class="field-label">条件检查 curl</label>
      <a-textarea
        :value="modelValue.curl"
        :auto-size="{ minRows: 2, maxRows: 5 }"
        placeholder="curl -X GET 'https://example.com/status' -H 'Authorization: Bearer …'"
        @update:value="patch('curl', $event)"
      />
      <p class="field-hint">先发这个请求，再按下面的状态码 / 表达式判断是否继续。</p>
    </div>

    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">条件检查期望状态码</label>
        <a-input
          :value="modelValue.expectStatus"
          placeholder="例如 200"
          :status="error('expectStatus') ? 'error' : undefined"
          @update:value="patch('expectStatus', $event)"
        />
        <div v-if="error('expectStatus')" class="field-error">{{ error('expectStatus') }}</div>
      </div>
      <div class="field">
        <label class="field-label">条件检查表达式</label>
        <a-input
          :value="modelValue.expr"
          placeholder="例如 data.pending=0"
          @update:value="patch('expr', $event)"
        />
      </div>
    </div>

    <div v-if="error('curl')" class="field-error">{{ error('curl') }}</div>
    <div v-if="error('any')" class="field-error">{{ error('any') }}</div>
    <p class="field-hint" style="margin-top: 6px">
      以上条件至少配置一项；只填状态码或表达式时，必须同时填写条件检查 curl。
    </p>
  </div>
</template>
