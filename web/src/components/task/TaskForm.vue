<script setup lang="ts">
import type { Task } from '@/types/task'
import type { TaskFormModel, FormErrors } from '@/types/form'
import type { TaskPayload, SchedulePreviewResponse } from '@/types/task'
import { emptyFormModel, formModelFromTask } from '@/types/form'
import { createTask, updateTask, previewSchedule } from '@/api/tasks'
import { useAppStore } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'
import { formatShortTime, formatClockSecond, hhmm } from '@/utils/format'
import { headersTextToJson, requestToCurl } from '@/utils/curl'
import { describeHostEnvironment } from '@/utils/environment'
import ConditionFields from './ConditionFields.vue'
import TestBenchDialog from '@/components/dialogs/TestBenchDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TestBenchConfig } from '@/types/testbench'

const { t } = useI18n()

const app = useAppStore()
const tasksStore = useTasksStore()

const emit = defineEmits<{
  saved: [task: Task]
  close: []
}>()

const model = ref<TaskFormModel>(emptyFormModel())
const baseline = ref(JSON.stringify(model.value))
const errors = ref<FormErrors>({})
const submitting = ref(false)
const editingId = ref<string | null>(null)
const editingName = ref('')

const dirty = computed(() => JSON.stringify(model.value) !== baseline.value)

/** 弹窗底部左侧的提示文案。 */
const footerHint = computed(() => {
  if (dirty.value) return t('taskForm.footerDirty')
  if (editingId.value) return t('taskForm.footerEditing')
  return t('taskForm.footerDefault')
})

const modeOptions = computed(() => [
  { label: t('taskForm.modeCurl'), value: 'curl' },
  { label: t('taskForm.modeStructured'), value: 'structured' },
])
const scheduleOptions = computed(() => [
  { label: t('taskForm.scheduleDaily'), value: 'daily' },
  { label: t('taskForm.scheduleInterval'), value: 'interval' },
])
const dailyModeOptions = computed(() => [
  { label: t('taskForm.dailyRange'), value: 'range' },
  { label: t('taskForm.dailyExact'), value: 'exact' },
  { label: t('taskForm.dailyJitter'), value: 'jitter' },
])
const unitOptions = computed(() => [
  { label: t('taskForm.unitSecond'), value: 1 },
  { label: t('taskForm.unitMinute'), value: 60 },
  { label: t('taskForm.unitHour'), value: 3600 },
  { label: t('taskForm.unitDay'), value: 86400 },
])
const methodOptions = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => ({
  label: value,
  value,
}))

const expectOpen = ref<string[]>([])
const precheckOn = ref(false)

const preview = ref<SchedulePreviewResponse | null>(null)
let previewTimer: number | undefined
let previewEpoch = 0

const testOpen = ref(false)
const testRef = ref<InstanceType<typeof TestBenchDialog> | null>(null)

const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmContent = ref('')
const confirmOkText = ref(t('common.ok'))
let confirmAction: (() => void) | null = null

const expectSummary = computed(() => {
  const parts: string[] = []
  if (model.value.expectStatus.trim()) {
    parts.push(t('taskForm.expectSummaryStatus', { value: model.value.expectStatus.trim() }))
  }
  if (model.value.expectBody.trim()) parts.push(t('taskForm.expectSummaryBody'))
  if (model.value.expectExpr.trim()) {
    parts.push(t('taskForm.expectSummaryExpr', { value: model.value.expectExpr.trim() }))
  }
  return parts.length
    ? t('taskForm.expectSummaryCustom', { items: parts.join(' + ') })
    : t('taskForm.expectSummaryDefault')
})

const envText = computed(() => describeHostEnvironment(app.environment, t))

/** 节假日数据就绪：当年数据存在，「仅工作日 / 仅休息日」选项才可选。 */
const holidayReady = computed(() => app.holiday?.hasCurrentYear === true)

const timeoutWarning = computed(() => {
  const timeout = Number(app.config.requestTimeoutMs)
  return !(Number.isFinite(timeout) && timeout > 0)
})

onMounted(() => {
  applyDefaultWindow()
  // 默认时间不算「未保存的修改」。
  baseline.value = JSON.stringify(model.value)
})

watch(
  () => app.config.defaultWindowMinutes,
  () => applyDefaultWindow(),
)

function applyDefaultWindow() {
  if (model.value.scheduleKind !== 'daily') return
  if (model.value.windowStart || model.value.windowEnd) return
  const now = new Date()
  const minutes = Number(app.config.defaultWindowMinutes)
  const end = new Date(now.getTime() + (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000)
  model.value.windowStart = hhmm(now)
  model.value.windowEnd = hhmm(end)
  if (!model.value.exactTime) model.value.exactTime = hhmm(now)
}

/* ---------------- 编辑 / 重置 ---------------- */

function askThen(title: string, content: string, okText: string, action: () => void) {
  confirmTitle.value = title
  confirmContent.value = content
  confirmOkText.value = okText
  confirmAction = action
  confirmOpen.value = true
}

function onConfirm() {
  confirmOpen.value = false
  const action = confirmAction
  confirmAction = null
  action?.()
}

/** 从任务卡进入编辑：已有未保存修改时先确认。 */
function loadTask(task: Task) {
  const apply = () => {
    model.value = formModelFromTask(task)
    editingId.value = task.id
    editingName.value = task.name
    errors.value = {}
    baseline.value = JSON.stringify(model.value)
    if (hasExpected(model.value)) expectOpen.value = ['expect']
    precheckOn.value = task.precheck_enabled === 1
    schedulePreview()
  }
  if (dirty.value) {
    askThen(
      t('taskForm.switchTargetTitle'),
      t('taskForm.switchTargetContent'),
      t('taskForm.switchTargetOk'),
      apply,
    )
    return
  }
  apply()
}

function resetForm(statusText?: string) {
  model.value = emptyFormModel()
  editingId.value = null
  editingName.value = ''
  errors.value = {}
  expectOpen.value = []
  precheckOn.value = false
  applyDefaultWindow()
  baseline.value = JSON.stringify(model.value)
  if (statusText) app.setStatus(statusText)
  schedulePreview()
}

function onCancel() {
  if (!dirty.value) {
    resetForm()
    emit('close')
    return
  }
  askThen(t('taskForm.discardTitle'), t('taskForm.discardContent'), t('taskForm.discardOk'), () => {
    resetForm()
    emit('close')
  })
}

/** 打开「新建任务」：清空上一次的编辑状态。 */
function startCreate() {
  resetForm()
}

function resetIfEditing(taskId: string) {
  if (editingId.value === taskId) resetForm(t('taskForm.taskDeleted'))
}

function hasExpected(value: TaskFormModel): boolean {
  return Boolean(value.expectStatus.trim() || value.expectBody.trim() || value.expectExpr.trim())
}

/* ---------------- 调度预览 ---------------- */

function previewPayload(): Record<string, unknown> | null {
  const value = model.value
  if (value.scheduleKind === 'daily') {
    if (value.dailyMode === 'range') {
      if (!value.windowStart || !value.windowEnd || value.windowStart === value.windowEnd) return null
      return {
        schedule_kind: 'daily',
        window_start: value.windowStart,
        window_end: value.windowEnd,
        count: 7,
      }
    }
    if (!value.exactTime) return null
    const payload: Record<string, unknown> = {
      schedule_kind: 'daily',
      window_start: value.exactTime,
      window_end: value.exactTime,
      count: 7,
    }
    if (value.dailyMode === 'jitter') {
      const jitter = Number(value.jitterMinutes)
      if (Number.isInteger(jitter) && jitter > 0) {
        payload.daily_jitter_minutes = Math.min(jitter, 60)
      }
    }
    return payload
  }
  const amount = Number(value.intervalValue)
  const unit = Number(value.intervalUnit)
  if (!Number.isInteger(amount) || amount < 1 || !unit) return null
  const seconds = amount * unit
  if (seconds > 30 * 24 * 3600) return null
  const jitterRaw = Number(value.intervalJitter)
  const jitter = Number.isInteger(jitterRaw) && jitterRaw >= 0 ? Math.min(jitterRaw, seconds) : 0
  const payload: Record<string, unknown> = {
    schedule_kind: 'interval',
    interval_seconds: seconds,
    interval_jitter_seconds: jitter,
    count: 7,
  }
  const startAt = value.intervalStart ? new Date(value.intervalStart).getTime() : NaN
  if (Number.isFinite(startAt)) payload.interval_start_at = startAt
  return payload
}

function schedulePreview() {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void refreshPreview(), 300)
}

async function refreshPreview() {
  const payload = previewPayload()
  if (!payload) {
    preview.value = null
    return
  }
  const epoch = (previewEpoch += 1)
  try {
    const data = await previewSchedule(payload as never)
    if (epoch === previewEpoch) preview.value = data
  } catch {
    if (epoch === previewEpoch) preview.value = null
  }
}

watch(
  () => [
    model.value.scheduleKind,
    model.value.dailyMode,
    model.value.windowStart,
    model.value.windowEnd,
    model.value.exactTime,
    model.value.jitterMinutes,
    model.value.intervalValue,
    model.value.intervalUnit,
    model.value.intervalJitter,
    model.value.intervalStart,
  ],
  schedulePreview,
)

function previewLabel(timestamp: number): string {
  const data = preview.value
  if (data && data.kind === 'daily' && data.window && !data.window.instant) {
    return `${formatShortTime(timestamp)}–${data.window.end}`
  }
  return data?.kind === 'daily' ? formatShortTime(timestamp) : formatClockSecond(timestamp)
}

const previewNote = computed(() => {
  const data = preview.value
  if (!data) return ''
  if (data.kind === 'daily') {
    if (data.window?.instant) return t('taskForm.previewNoteInstant')
    if ((data.jitter_minutes ?? 0) > 0) {
      return t('taskForm.previewNoteJitter', {
        time: model.value.exactTime,
        minutes: data.jitter_minutes,
      })
    }
    return t('taskForm.previewNoteWindow')
  }
  return (model.value.intervalJitter ?? 0) > 0
    ? t('taskForm.previewNoteIntervalJitter', { seconds: model.value.intervalJitter })
    : ''
})

/* ---------------- 校验 ---------------- */

function validate(): FormErrors {
  const value = model.value
  const result: FormErrors = {}

  if (!value.name.trim()) result.name = t('taskForm.errName')

  if (value.mode === 'curl') {
    if (!value.curl.trim()) result.curl = t('taskForm.errCurl')
  } else {
    const url = value.url.trim()
    if (!url) result.url = t('taskForm.errUrl')
    else if (!/^https?:\/\//i.test(url)) result.url = t('taskForm.errUrlScheme')
  }

  if (value.scheduleKind === 'daily') {
    if (value.dailyMode === 'range') {
      if (!value.windowStart || !value.windowEnd) {
        result.windowStart = t('taskForm.errWindow')
      } else if (value.windowStart === value.windowEnd) {
        result.windowStart = t('taskForm.errWindowSame')
      }
    } else {
      if (!value.exactTime) result.exactTime = t('taskForm.errExactTime')
      if (value.dailyMode === 'jitter') {
        const jitter = Number(value.jitterMinutes)
        if (!Number.isInteger(jitter) || jitter < 0 || jitter > 60) {
          result.jitterMinutes = t('taskForm.errJitterMinutes')
        }
      }
    }
  } else {
    const amount = Number(value.intervalValue)
    const unit = Number(value.intervalUnit)
    if (!Number.isInteger(amount) || amount < 1) {
      result.intervalValue = t('taskForm.errIntervalValue')
    } else if (amount * unit > 30 * 24 * 3600) {
      result.intervalValue = t('taskForm.errIntervalTooLong')
    }
    const jitter = Number(value.intervalJitter || 0)
    if (!Number.isInteger(jitter) || jitter < 0) {
      result.intervalJitter = t('taskForm.errIntervalJitter')
    } else if (amount * unit && jitter > amount * unit) {
      result.intervalJitter = t('taskForm.errJitterTooLarge')
    }
  }

  if (value.notifyEnabled && !value.notifyCurl.trim()) {
    result.notifyCurl = t('taskForm.errNotifyCurl')
  }

  const expectStatus = value.expectStatus.trim()
  if (expectStatus) {
    const status = Number(expectStatus)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      result.expectStatus = t('taskForm.errExpectStatus')
    }
  }

  const cond = value.conditions
  if (precheckOn.value) {
    validateConditions(cond, result)
  }

  return result
}

/** 条件区校验，直接写入 result。 */
function validateConditions(cond: TaskFormModel['conditions'], result: FormErrors) {
  const hasTime = Boolean(cond.timeStart) || Boolean(cond.timeEnd)
  if (hasTime) {
    if (!cond.timeStart || !cond.timeEnd) {
      result.condTime = t('taskForm.errCondTime')
    } else if (cond.timeStart === cond.timeEnd) {
      result.condTime = t('taskForm.errCondTimeSame')
    }
  }
  const rawStatus = cond.expectStatus.trim()
  let status: number | null = null
  if (rawStatus) {
    status = Number(rawStatus)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      result.condStatus = t('taskForm.errCondStatus')
    }
  }
  const curl = cond.curl.trim()
  if (!curl && (status !== null || cond.expr.trim())) {
    result.condCurl = t('taskForm.errCondCurl')
  }
  const hasAny =
    cond.weekdays.length > 0 ||
    hasTime ||
    cond.requireAc ||
    Boolean(cond.ipPattern.trim()) ||
    Boolean(cond.dayType) ||
    Boolean(curl)
  if (!hasAny) {
    result.condAny = t('taskForm.errCondAny')
  }
}

/* ---------------- 提交 ---------------- */

function buildPayload(): TaskPayload {
  const value = model.value
  const payload: TaskPayload = {
    name: value.name.trim(),
    schedule_kind: value.scheduleKind,
    mode: value.mode,
    notify_enabled: value.notifyEnabled,
    precheck_enabled: precheckOn.value,
    run_on_startup: value.runOnStartup,
  }

  if (value.scheduleKind === 'daily') {
    if (value.dailyMode === 'range') {
      payload.window_start = value.windowStart
      payload.window_end = value.windowEnd
    } else {
      payload.window_start = value.exactTime
      payload.window_end = value.exactTime
      if (value.dailyMode === 'jitter') {
        const jitter = Number(value.jitterMinutes)
        if (jitter > 0) payload.daily_jitter_minutes = jitter
      }
    }
  } else {
    payload.interval_seconds = Number(value.intervalValue) * Number(value.intervalUnit)
    payload.interval_jitter_seconds = Number(value.intervalJitter || 0)
    const startAt = value.intervalStart ? new Date(value.intervalStart).getTime() : NaN
    if (Number.isFinite(startAt)) payload.interval_start_at = startAt
  }

  if (value.mode === 'curl') {
    payload.curl = value.curl.trim()
  } else {
    payload.url = value.url.trim()
    payload.method = value.method
    payload.headers = value.headers
    if (value.body !== '') payload.body = value.body
  }

  const cond = value.conditions
  if (precheckOn.value) {
    if (cond.weekdays.length > 0) payload.precheck_weekdays = cond.weekdays
    if (cond.timeStart && cond.timeEnd) {
      payload.precheck_time_start = cond.timeStart
      payload.precheck_time_end = cond.timeEnd
    }
    if (cond.curl.trim()) payload.precheck_curl = cond.curl.trim()
    if (cond.ipPattern.trim()) payload.precheck_ip_pattern = cond.ipPattern.trim()
    if (cond.requireAc) payload.precheck_require_ac = true
    if (cond.dayType) payload.precheck_day_type = cond.dayType
    const status = cond.expectStatus.trim()
    if (status) payload.precheck_expect_status = Number(status)
    if (cond.expr.trim()) payload.precheck_expr = cond.expr.trim()
  }

  if (value.notifyEnabled) payload.notify_curl = value.notifyCurl.trim()

  if (value.expectStatus.trim()) payload.expect_status = Number(value.expectStatus.trim())
  if (value.expectBody !== '') payload.expect_body = value.expectBody
  if (value.expectExpr.trim() !== '') payload.expect_expr = value.expectExpr.trim()

  return payload
}

async function submit() {
  if (submitting.value) return
  const found = validate()
  errors.value = found
  const keys = Object.keys(found)
  if (keys.length > 0) {
    app.setStatus(t('taskForm.needFix', { count: keys.length }), true)
    await nextTick()
    focusFirstError(keys[0])
    return
  }

  submitting.value = true
  const wasEditing = editingId.value
  try {
    const payload = buildPayload()
    const data = wasEditing
      ? await updateTask(wasEditing, payload)
      : await createTask(payload)
    const task = data.task
    app.setStatus(
      !wasEditing
        ? t('taskForm.created', { name: task.name })
        : task.status === 'active'
          ? t('taskForm.savedActive', { name: task.name })
          : t('taskForm.savedInactive', { name: task.name }),
      false,
    )
    resetForm()
    await tasksStore.load()
    tasksStore.select(task.id)
    emit('saved', task)
    emit('close')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    app.setStatus(message, true)
  } finally {
    submitting.value = false
  }
}

function focusFirstError(key: string) {
  window.requestAnimationFrame(() => {
    const node = document.querySelector(`[data-error-key="${key}"]`)
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const input = node.querySelector('input, textarea, button') as HTMLElement | null
      input?.focus()
    }
  })
}

/* ---------------- 试跑 ---------------- */

function currentCurl(): string {
  const value = model.value
  if (value.mode === 'curl') return value.curl.trim()
  const url = value.url.trim()
  if (!url) return ''
  return requestToCurl(value.method, url, headersTextToJson(value.headers), value.body || null)
}

function openTest() {
  const value = model.value
  const config: TestBenchConfig = {
    curl: currentCurl(),
    precheckEnabled: precheckOn.value,
    conditions: JSON.parse(JSON.stringify(value.conditions)),
    expectStatus: value.expectStatus,
    expectBody: value.expectBody,
    expectExpr: value.expectExpr,
    notifyEnabled: value.notifyEnabled,
    notifyCurl: value.notifyCurl,
    taskId: editingId.value,
    taskName: editingName.value,
  }
  testOpen.value = true
  nextTick(() => testRef.value?.openWith(config))
}

function applyTest(config: TestBenchConfig) {
  model.value.mode = 'curl'
  model.value.curl = config.curl
  model.value.conditions = config.conditions
  model.value.expectStatus = config.expectStatus
  model.value.expectBody = config.expectBody
  model.value.expectExpr = config.expectExpr
  model.value.notifyEnabled = config.notifyEnabled
  model.value.notifyCurl = config.notifyCurl
  precheckOn.value = config.precheckEnabled
  app.setStatus(t('taskForm.testConfigApplied'))
}

defineExpose({
  loadTask,
  resetIfEditing,
  isDirty: dirty,
  applyTestConfig: applyTest,
  startCreate,
  requestClose: onCancel,
  submit,
  submitting,
  editingId,
  footerHint,
})
</script>

<template>
  <div class="task-form-shell">
    <form class="task-form" novalidate @submit.prevent="submit">
      <!-- 1. 请求 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">1</span>
          <div>
            <h3>{{ $t('taskForm.sectionRequest') }}</h3>
            <p>{{ $t('taskForm.sectionRequestDesc') }}</p>
          </div>
        </div>

        <div class="field" data-error-key="name">
          <label class="field-label">{{ $t('taskForm.name') }} <span class="req">*</span></label>
          <a-input
            v-model:value="model.name"
            :status="errors.name ? 'error' : undefined"
            :placeholder="t('taskForm.namePlaceholder')"
            :maxlength="200"
            allow-clear
          />
          <div v-if="errors.name" class="field-error">{{ errors.name }}</div>
        </div>

        <div class="field">
          <label class="field-label">{{ $t('taskForm.modeLabel') }}</label>
          <a-segmented v-model:value="model.mode" :options="modeOptions" block />
        </div>

        <div v-if="model.mode === 'curl'" class="field" data-error-key="curl">
          <div class="field-label-row">
            <label class="field-label">{{ $t('taskForm.curlLabel') }} <span class="req">*</span></label>
            <a-button size="small" type="link" @click="openTest">{{ $t('taskForm.tryFirst') }}</a-button>
          </div>
          <a-textarea
            v-model:value="model.curl"
            :status="errors.curl ? 'error' : undefined"
            :auto-size="{ minRows: 5, maxRows: 12 }"
            class="mono"
            placeholder="curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' -d '{&quot;ok&quot;:true}'"
          />
          <div v-if="errors.curl" class="field-error">{{ errors.curl }}</div>
        </div>

        <div v-else>
          <div class="field" data-error-key="url">
            <label class="field-label">{{ $t('taskForm.urlLabel') }} <span class="req">*</span></label>
            <a-input
              v-model:value="model.url"
              :status="errors.url ? 'error' : undefined"
              placeholder="https://example.com/api"
              allow-clear
            />
            <div v-if="errors.url" class="field-error">{{ errors.url }}</div>
          </div>

          <div class="form-grid-2">
            <div class="field">
              <label class="field-label">{{ $t('taskForm.methodLabel') }}</label>
              <a-select v-model:value="model.method" :options="methodOptions" style="width: 100%" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('taskForm.headersLabel') }}</label>
              <a-textarea
                v-model:value="model.headers"
                :auto-size="{ minRows: 2, maxRows: 5 }"
                placeholder="Content-Type: application/json&#10;Authorization: Bearer …"
                class="mono"
              />
            </div>
          </div>

          <div class="field">
            <label class="field-label">{{ $t('taskForm.bodyLabel') }}</label>
            <a-textarea
              v-model:value="model.body"
              :auto-size="{ minRows: 2, maxRows: 8 }"
              placeholder='{"hello":"world"}'
              class="mono"
            />
          </div>

          <div class="field">
            <a-button size="small" @click="openTest">{{ $t('taskForm.runWithConfig') }}</a-button>
          </div>
        </div>
      </section>

      <!-- 2. 执行时间 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">2</span>
          <div>
            <h3>{{ $t('taskForm.sectionSchedule') }}</h3>
            <p>{{ $t('taskForm.sectionScheduleDesc') }}</p>
          </div>
        </div>

        <div class="field">
          <label class="field-label">{{ $t('taskForm.scheduleKindLabel') }}</label>
          <a-segmented v-model:value="model.scheduleKind" :options="scheduleOptions" block />
        </div>

        <template v-if="model.scheduleKind === 'daily'">
          <div class="field">
            <a-segmented v-model:value="model.dailyMode" :options="dailyModeOptions" block />
          </div>

          <div v-if="model.dailyMode === 'range'" class="form-grid-2" data-error-key="windowStart">
            <div class="field">
              <label class="field-label">{{ $t('taskForm.windowStart') }} <span class="req">*</span></label>
              <a-time-picker
                v-model:value="model.windowStart"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%"
                placeholder="09:00"
              />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('taskForm.windowEnd') }} <span class="req">*</span></label>
              <a-time-picker
                v-model:value="model.windowEnd"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%"
                placeholder="18:00"
              />
            </div>
            <div v-if="errors.windowStart" class="field-error" style="grid-column: 1 / -1">
              {{ errors.windowStart }}
            </div>
          </div>

          <div v-else data-error-key="exactTime">
            <div class="form-grid-2">
              <div class="field">
                <label class="field-label">{{ $t('taskForm.exactTime') }} <span class="req">*</span></label>
                <a-time-picker
                  v-model:value="model.exactTime"
                  format="HH:mm"
                  value-format="HH:mm"
                  style="width: 100%"
                  placeholder="18:00"
                />
              </div>
              <div v-if="model.dailyMode === 'jitter'" class="field">
                <label class="field-label">{{ $t('taskForm.jitterMinutes') }}</label>
                <a-input-number v-model:value="model.jitterMinutes" :min="0" :max="60" style="width: 100%" />
              </div>
            </div>
            <div v-if="errors.exactTime" class="field-error">{{ errors.exactTime }}</div>
            <div v-if="errors.jitterMinutes" class="field-error">{{ errors.jitterMinutes }}</div>
          </div>

          <p class="field-hint">
            {{
              model.dailyMode === 'range'
                ? $t('taskForm.dailyRangeHint')
                : model.dailyMode === 'exact'
                  ? $t('taskForm.dailyExactHint')
                  : $t('taskForm.dailyJitterHint')
            }}
          </p>
        </template>

        <template v-else>
          <div class="form-grid-2" data-error-key="intervalValue">
            <div class="field">
              <label class="field-label">{{ $t('taskForm.intervalEvery') }} <span class="req">*</span></label>
              <a-input-number v-model:value="model.intervalValue" :min="1" :step="1" style="width: 100%" />
            </div>
            <div class="field">
              <label class="field-label">{{ $t('taskForm.intervalUnit') }}</label>
              <a-select v-model:value="model.intervalUnit" :options="unitOptions" style="width: 100%" />
            </div>
            <div v-if="errors.intervalValue" class="field-error" style="grid-column: 1 / -1">
              {{ errors.intervalValue }}
            </div>
          </div>

          <div class="form-grid-2">
            <div class="field">
              <label class="field-label">{{ $t('taskForm.intervalStart') }}</label>
              <a-date-picker
                v-model:value="model.intervalStart"
                show-time
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm"
                style="width: 100%"
                :placeholder="t('taskForm.intervalStartPlaceholder')"
              />
            </div>
            <div class="field" data-error-key="intervalJitter">
              <label class="field-label">{{ $t('taskForm.intervalJitter') }}</label>
              <a-input-number v-model:value="model.intervalJitter" :min="0" style="width: 100%" />
              <div v-if="errors.intervalJitter" class="field-error">{{ errors.intervalJitter }}</div>
            </div>
          </div>
          <p class="field-hint">
            {{ $t('taskForm.intervalHint') }}
          </p>
        </template>

        <div v-if="preview && preview.next.length" class="field">
          <div class="field-label-row">
            <span class="field-label">{{ $t('taskForm.previewNext') }}</span>
            <span class="muted" style="font-size: 11.5px">{{ previewNote }}</span>
          </div>
          <div class="preview-list">
            <span v-for="timestamp in preview.next" :key="timestamp" class="preview-chip">
              {{ previewLabel(timestamp) }}
            </span>
          </div>
        </div>

        <p v-if="timeoutWarning" class="field-hint warn">
          {{ $t('taskForm.timeoutWarning') }}
        </p>

        <div class="field">
          <a-switch v-model:checked="model.runOnStartup" size="small" />
          <span style="margin-left: 8px">{{ $t('taskForm.runOnStartup') }}</span>
          <p class="field-hint">
            {{ $t('taskForm.runOnStartupHint') }}
          </p>
        </div>
      </section>

      <!-- 3. 成功与通知 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">3</span>
          <div>
            <h3>{{ $t('taskForm.sectionSuccess') }}</h3>
            <p>{{ $t('taskForm.sectionSuccessDesc') }}</p>
          </div>
        </div>

        <a-collapse v-model:active-key="expectOpen" ghost>
          <a-collapse-panel key="expect">
            <template #header>
              <span style="font-weight: 600; font-size: 13px">{{ $t('taskForm.successCondition') }}</span>
              <span class="muted" style="margin-left: 8px; font-size: 12px">{{ expectSummary }}</span>
            </template>
            <div class="form-grid-2">
              <div class="field" data-error-key="expectStatus">
                <label class="field-label">{{ $t('taskForm.expectStatus') }}</label>
                <a-input
                  v-model:value="model.expectStatus"
                  :placeholder="t('taskForm.expectStatusPlaceholder')"
                  :status="errors.expectStatus ? 'error' : undefined"
                />
                <div v-if="errors.expectStatus" class="field-error">{{ errors.expectStatus }}</div>
              </div>
              <div class="field">
                <label class="field-label">{{ $t('taskForm.expectBody') }}</label>
                <a-textarea
                  v-model:value="model.expectBody"
                  :auto-size="{ minRows: 2, maxRows: 4 }"
                  :placeholder="t('taskForm.expectBodyPlaceholder')"
                  class="mono"
                />
              </div>
            </div>
            <div class="field">
              <label class="field-label">{{ $t('taskForm.expectExpr') }}</label>
              <a-textarea
                v-model:value="model.expectExpr"
                :auto-size="{ minRows: 2, maxRows: 5 }"
                :placeholder="t('taskForm.expectExprPlaceholder')"
                class="mono"
              />
            </div>
            <p class="field-hint">
              {{ $t('taskForm.expectHint') }}
            </p>
          </a-collapse-panel>
        </a-collapse>

        <div class="field" style="margin-top: 8px">
          <a-switch v-model:checked="model.notifyEnabled" size="small" />
          <span style="margin-left: 8px">{{ $t('taskForm.notifyOn') }}</span>
          <p class="field-hint">{{ $t('taskForm.notifyHint') }}</p>
        </div>

        <div v-if="model.notifyEnabled" class="field" data-error-key="notifyCurl">
          <label class="field-label">{{ $t('taskForm.notifyCurl') }} <span class="req">*</span></label>
          <a-textarea
            v-model:value="model.notifyCurl"
            :status="errors.notifyCurl ? 'error' : undefined"
            :auto-size="{ minRows: 3, maxRows: 8 }"
            class="mono"
            :placeholder="t('taskForm.notifyCurlPlaceholder')"
          />
          <div v-if="errors.notifyCurl" class="field-error">{{ errors.notifyCurl }}</div>
        </div>
      </section>

      <!-- 4. 执行条件 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">4</span>
          <div>
            <h3>{{ $t('taskForm.sectionCondition') }}</h3>
            <p>{{ $t('taskForm.sectionConditionDesc') }}</p>
          </div>
        </div>

        <div class="field">
          <a-switch v-model:checked="precheckOn" size="small" />
          <span style="margin-left: 8px">{{ $t('taskForm.precheckOn') }}</span>
        </div>

        <ConditionFields
          v-if="precheckOn"
          v-model="model.conditions"
          :env-text="envText"
          :holiday-ready="holidayReady"
          :errors="{
            timeStart: errors.condTime ?? '',
            timeEnd: errors.condTime ?? '',
            expectStatus: errors.condStatus ?? '',
            curl: errors.condCurl ?? '',
            any: errors.condAny ?? '',
          }"
        />
      </section>
    </form>

    <TestBenchDialog ref="testRef" v-model:open="testOpen" @apply="applyTest" @saved-task="emit('saved', $event)" />
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :content="confirmContent"
      :ok-text="confirmOkText"
      danger
      @confirm="onConfirm"
    />
  </div>
</template>
