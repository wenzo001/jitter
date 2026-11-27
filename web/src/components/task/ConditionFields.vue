<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConditionModel } from '@/types/form'
import { WEEKDAYS } from '@/utils/condition'

const props = defineProps<{
  modelValue: ConditionModel
  envText?: string
  /** 当前网络（WiFi / 网线）提示：用于「已连接网络」条件下方。 */
  networkText?: string
  errors?: Record<string, string>
  /** 节假日数据就绪：否则「工作日 / 休息日」选项禁用。 */
  holidayReady?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: ConditionModel]
}>()

const { t } = useI18n()

const weekdayOptions = computed(() =>
  WEEKDAYS.map((day) => ({ label: t(day.localeKey), value: day.value })),
)

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
      <label class="field-label">{{ $t('condition.weekdayLabel') }}</label>
      <a-checkbox-group v-model:value="weekdays" :options="weekdayOptions" />
      <p class="field-hint" style="margin-top: 4px">{{ $t('condition.weekdayHint') }}</p>
    </div>

    <div class="form-grid-2" data-error-key="condTime">
      <div class="field">
        <label class="field-label">{{ $t('condition.timeStart') }}</label>
        <a-time-picker
          :value="modelValue.timeStart"
          format="HH:mm"
          value-format="HH:mm"
          :placeholder="t('condition.timeStartPlaceholder')"
          style="width: 100%"
          @update:value="patch('timeStart', timeValue($event))"
        />
        <div v-if="error('timeStart')" class="field-error">{{ error('timeStart') }}</div>
      </div>
      <div class="field">
        <label class="field-label">{{ $t('condition.timeEnd') }}</label>
        <a-time-picker
          :value="modelValue.timeEnd"
          format="HH:mm"
          value-format="HH:mm"
          :placeholder="t('condition.timeEndPlaceholder')"
          style="width: 100%"
          @update:value="patch('timeEnd', timeValue($event))"
        />
        <div v-if="error('timeEnd')" class="field-error">{{ error('timeEnd') }}</div>
      </div>
    </div>
    <p class="field-hint">{{ $t('condition.timeHint') }}</p>

    <div class="field">
      <a-checkbox
        :checked="modelValue.requireAc"
        @change="patch('requireAc', ($event.target as HTMLInputElement).checked)"
      >
        {{ $t('condition.requireAc') }}
      </a-checkbox>
    </div>

    <div class="field">
      <a-checkbox
        :checked="modelValue.requireNetwork"
        @change="patch('requireNetwork', ($event.target as HTMLInputElement).checked)"
      >
        {{ $t('condition.requireNetwork') }}
      </a-checkbox>
      <p class="field-hint">
        {{ $t('condition.requireNetworkHint') }}
        <span v-if="networkText" class="muted">（{{ networkText }}）</span>
      </p>
    </div>

    <div class="field">
      <label class="field-label">{{ $t('condition.dayType') }}</label>
      <a-radio-group
        :value="modelValue.dayType"
        :disabled="!holidayReady"
        @update:value="patch('dayType', ($event as '' | 'workday' | 'offday') ?? '')"
      >
        <a-radio value="">{{ $t('condition.dayTypeAny') }}</a-radio>
        <a-radio value="workday">{{ $t('condition.dayTypeWorkday') }}</a-radio>
        <a-radio value="offday">{{ $t('condition.dayTypeOffday') }}</a-radio>
      </a-radio-group>
      <p v-if="!holidayReady" class="field-hint warn" style="margin-top: 4px">
        {{ $t('condition.holidayNotReady') }}
      </p>
      <p v-else-if="modelValue.dayType" class="field-hint" style="margin-top: 4px">
        {{ $t('condition.holidayReady') }}
      </p>
    </div>

    <div class="field">
      <label class="field-label">{{ $t('condition.ipOnly') }}</label>
      <a-input
        :value="modelValue.ipPattern"
        :placeholder="t('condition.ipPlaceholder')"
        allow-clear
        @update:value="patch('ipPattern', $event)"
      />
      <p class="field-hint">
        {{ $t('condition.ipHint') }}
        <span v-if="envText" class="muted">（{{ envText }}）</span>
      </p>
    </div>

    <div class="field" data-error-key="condCurl">
      <label class="field-label">{{ $t('condition.curlLabel') }}</label>
      <a-textarea
        :value="modelValue.curl"
        :auto-size="{ minRows: 2, maxRows: 5 }"
        placeholder="curl -X GET 'https://example.com/status' -H 'Authorization: Bearer …'"
        @update:value="patch('curl', $event)"
      />
      <p class="field-hint">{{ $t('condition.curlHint') }}</p>
    </div>

    <div class="form-grid-2">
      <div class="field" data-error-key="condStatus">
        <label class="field-label">{{ $t('condition.expectStatus') }}</label>
        <a-input
          :value="modelValue.expectStatus"
          :placeholder="t('condition.expectStatusPlaceholder')"
          :status="error('expectStatus') ? 'error' : undefined"
          @update:value="patch('expectStatus', $event)"
        />
        <div v-if="error('expectStatus')" class="field-error">{{ error('expectStatus') }}</div>
      </div>
      <div class="field">
        <label class="field-label">{{ $t('condition.expr') }}</label>
        <a-input
          :value="modelValue.expr"
          :placeholder="t('condition.exprPlaceholder')"
          @update:value="patch('expr', $event)"
        />
      </div>
    </div>

    <div v-if="error('curl')" class="field-error">{{ error('curl') }}</div>
    <div v-if="error('any')" class="field-error" data-error-key="condAny">{{ error('any') }}</div>
    <p class="field-hint" style="margin-top: 6px">
      {{ $t('condition.atLeastOne') }}
    </p>
    <p class="field-hint" style="margin-top: 4px">
      {{ $t('condition.conjunctionHint') }}
    </p>
  </div>
</template>
