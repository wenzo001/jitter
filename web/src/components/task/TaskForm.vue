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
import type { TestBenchConfig } from '@/types/testbench'

const app = useAppStore()
const tasksStore = useTasksStore()

const emit = defineEmits<{
  saved: [task: Task]
}>()

const model = ref<TaskFormModel>(emptyFormModel())
const baseline = ref(JSON.stringify(model.value))
const errors = ref<FormErrors>({})
const submitting = ref(false)
const editingId = ref<string | null>(null)
const editingName = ref('')

const dirty = computed(() => JSON.stringify(model.value) !== baseline.value)

const modeOptions = [
  { label: '粘贴 curl', value: 'curl' },
  { label: '手动填写', value: 'structured' },
]
const scheduleOptions = [
  { label: '每天一次', value: 'daily' },
  { label: '每隔一段时间', value: 'interval' },
]
const dailyModeOptions = [
  { label: '时段内随机', value: 'range' },
  { label: '固定时间', value: 'exact' },
  { label: '固定时间 + 浮动', value: 'jitter' },
]
const unitOptions = [
  { label: '秒', value: 1 },
  { label: '分钟', value: 60 },
  { label: '小时', value: 3600 },
  { label: '天', value: 86400 },
]
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
const confirmOkText = ref('确定')
let confirmAction: (() => void) | null = null

const expectSummary = computed(() => {
  const parts: string[] = []
  if (model.value.expectStatus.trim()) parts.push(`状态码 ${model.value.expectStatus.trim()}`)
  if (model.value.expectBody.trim()) parts.push('响应体相等')
  if (model.value.expectExpr.trim()) parts.push(`表达式 ${model.value.expectExpr.trim()}`)
  return parts.length ? `已自定义：${parts.join(' + ')}` : '默认：任意 2xx 视为成功'
})

const envText = computed(() => describeHostEnvironment(app.environment))

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
      '切换编辑目标？',
      '当前表单还有未保存的修改，切换后会丢失。',
      '丢弃并切换',
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
    resetForm(editingId.value ? '已取消编辑' : undefined)
    return
  }
  askThen('放弃未保存的修改？', '当前填写的内容还没有保存，取消后会清空。', '放弃修改', () => {
    resetForm(editingId.value ? '已取消编辑' : '已重置表单')
  })
}

function resetIfEditing(taskId: string) {
  if (editingId.value === taskId) resetForm('任务已删除，编辑状态已清除')
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
    if (data.window?.instant) return '每天固定这个时刻'
    if ((data.jitter_minutes ?? 0) > 0) {
      return `基准 ${model.value.exactTime}，前后各 ${data.jitter_minutes} 分钟随机`
    }
    return '窗口内随机，具体时刻执行前才确定'
  }
  return (model.value.intervalJitter ?? 0) > 0
    ? `每次再加 0–${model.value.intervalJitter} 秒抖动`
    : ''
})

/* ---------------- 校验 ---------------- */

function validate(): FormErrors {
  const value = model.value
  const result: FormErrors = {}

  if (!value.name.trim()) result.name = '请填写任务名称'

  if (value.mode === 'curl') {
    if (!value.curl.trim()) result.curl = '请粘贴 curl 命令'
  } else {
    const url = value.url.trim()
    if (!url) result.url = '请填写 URL'
    else if (!/^https?:\/\//i.test(url)) result.url = 'URL 需要以 http:// 或 https:// 开头'
  }

  if (value.scheduleKind === 'daily') {
    if (value.dailyMode === 'range') {
      if (!value.windowStart || !value.windowEnd) {
        result.windowStart = '请填写执行时段的开始和结束'
      } else if (value.windowStart === value.windowEnd) {
        result.windowStart = '开始和结束不能相同；固定时刻请选「固定时间」'
      }
    } else {
      if (!value.exactTime) result.exactTime = '请选择每天的执行时间'
      if (value.dailyMode === 'jitter') {
        const jitter = Number(value.jitterMinutes)
        if (!Number.isInteger(jitter) || jitter < 0 || jitter > 60) {
          result.jitterMinutes = '浮动分钟必须是 0–60 的整数'
        }
      }
    }
  } else {
    const amount = Number(value.intervalValue)
    const unit = Number(value.intervalUnit)
    if (!Number.isInteger(amount) || amount < 1) {
      result.intervalValue = '执行间隔必须是大于 0 的整数'
    } else if (amount * unit > 30 * 24 * 3600) {
      result.intervalValue = '执行间隔不能超过 30 天'
    }
    const jitter = Number(value.intervalJitter || 0)
    if (!Number.isInteger(jitter) || jitter < 0) {
      result.intervalJitter = '抖动必须是大于等于 0 的整数秒'
    } else if (amount * unit && jitter > amount * unit) {
      result.intervalJitter = '抖动不能大于执行间隔'
    }
  }

  if (value.notifyEnabled && !value.notifyCurl.trim()) {
    result.notifyCurl = '请填写通知 curl'
  }

  const expectStatus = value.expectStatus.trim()
  if (expectStatus) {
    const status = Number(expectStatus)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      result.expectStatus = '期望状态码必须是 100–599 的整数'
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
      result.condTime = '执行时段需要同时填写开始和结束时间'
    } else if (cond.timeStart === cond.timeEnd) {
      result.condTime = '执行时段的开始和结束不能相同'
    }
  }
  const rawStatus = cond.expectStatus.trim()
  let status: number | null = null
  if (rawStatus) {
    status = Number(rawStatus)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      result.condStatus = '条件检查的期望状态码必须是 100–599 的整数'
    }
  }
  const curl = cond.curl.trim()
  if (!curl && (status !== null || cond.expr.trim())) {
    result.condCurl = '配置了条件状态码或表达式时，必须填写条件检查 curl'
  }
  const hasAny =
    cond.weekdays.length > 0 ||
    hasTime ||
    cond.requireAc ||
    Boolean(cond.ipPattern.trim()) ||
    Boolean(curl)
  if (!hasAny) {
    result.condAny = '启用执行条件时，至少配置星期、时段、电源、本机 IP 或前置 curl 之一'
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
    app.setStatus(`还有 ${keys.length} 项需要修正`, true)
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
        ? `已创建任务「${task.name}」`
        : task.status === 'active'
          ? `已保存任务「${task.name}」，继续按新配置定时`
          : `已保存任务「${task.name}」，任务仍保持停止；如需定时请恢复`,
      false,
    )
    resetForm()
    await tasksStore.load()
    tasksStore.select(task.id)
    emit('saved', task)
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
  app.setStatus('已把试跑配置带入表单，确认后点「创建任务」或「保存修改」')
}

defineExpose({ loadTask, resetIfEditing, isDirty: dirty, applyTestConfig: applyTest })
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <h2 class="panel-title">
        {{ editingId ? '编辑任务' : '新建任务' }}
        <small v-if="editingId">正在编辑「{{ editingName }}」</small>
      </h2>
      <span v-if="dirty" class="muted" style="font-size: 12px">有未保存的修改</span>
    </div>

    <form class="task-form" novalidate @submit.prevent="submit">
      <!-- 1. 请求 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">1</span>
          <div>
            <h3>请求</h3>
            <p>把 curl 粘进来，或手动填写 URL / 方法 / 头 / 体。不确定能否跑通？先点「先试跑」。</p>
          </div>
        </div>

        <div class="field" data-error-key="name">
          <label class="field-label">任务名称 <span class="req">*</span></label>
          <a-input
            v-model:value="model.name"
            :status="errors.name ? 'error' : undefined"
            placeholder="例如：每日签到"
            :maxlength="200"
            allow-clear
          />
          <div v-if="errors.name" class="field-error">{{ errors.name }}</div>
        </div>

        <div class="field">
          <label class="field-label">请求填写方式</label>
          <a-segmented v-model:value="model.mode" :options="modeOptions" block />
        </div>

        <div v-if="model.mode === 'curl'" class="field" data-error-key="curl">
          <div class="field-label-row">
            <label class="field-label">curl 命令 <span class="req">*</span></label>
            <a-button size="small" type="link" @click="openTest">先试跑</a-button>
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
            <label class="field-label">URL <span class="req">*</span></label>
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
              <label class="field-label">方法</label>
              <a-select v-model:value="model.method" :options="methodOptions" style="width: 100%" />
            </div>
            <div class="field">
              <label class="field-label">Headers（每行一个，可选）</label>
              <a-textarea
                v-model:value="model.headers"
                :auto-size="{ minRows: 2, maxRows: 5 }"
                placeholder="Content-Type: application/json&#10;Authorization: Bearer …"
                class="mono"
              />
            </div>
          </div>

          <div class="field">
            <label class="field-label">Body（可选）</label>
            <a-textarea
              v-model:value="model.body"
              :auto-size="{ minRows: 2, maxRows: 8 }"
              placeholder='{"hello":"world"}'
              class="mono"
            />
          </div>

          <div class="field">
            <a-button size="small" @click="openTest">用这份配置试跑</a-button>
          </div>
        </div>
      </section>

      <!-- 2. 执行时间 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">2</span>
          <div>
            <h3>执行时间</h3>
            <p>每天一次（可在时段内随机），或者每隔一段时间重复。</p>
          </div>
        </div>

        <div class="field">
          <label class="field-label">执行方式</label>
          <a-segmented v-model:value="model.scheduleKind" :options="scheduleOptions" block />
        </div>

        <template v-if="model.scheduleKind === 'daily'">
          <div class="field">
            <a-segmented v-model:value="model.dailyMode" :options="dailyModeOptions" block />
          </div>

          <div v-if="model.dailyMode === 'range'" class="form-grid-2" data-error-key="windowStart">
            <div class="field">
              <label class="field-label">时段开始 <span class="req">*</span></label>
              <a-time-picker
                v-model:value="model.windowStart"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%"
                placeholder="09:00"
              />
            </div>
            <div class="field">
              <label class="field-label">时段结束 <span class="req">*</span></label>
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
                <label class="field-label">每天执行时间 <span class="req">*</span></label>
                <a-time-picker
                  v-model:value="model.exactTime"
                  format="HH:mm"
                  value-format="HH:mm"
                  style="width: 100%"
                  placeholder="18:00"
                />
              </div>
              <div v-if="model.dailyMode === 'jitter'" class="field">
                <label class="field-label">前后浮动（分钟）</label>
                <a-input-number v-model:value="model.jitterMinutes" :min="0" :max="60" style="width: 100%" />
              </div>
            </div>
            <div v-if="errors.exactTime" class="field-error">{{ errors.exactTime }}</div>
            <div v-if="errors.jitterMinutes" class="field-error">{{ errors.jitterMinutes }}</div>
          </div>

          <p class="field-hint">
            {{
              model.dailyMode === 'range'
                ? '每天在开始~结束之间随机选一个时刻执行一次；结束早于开始表示跨午夜（例如 23:50–00:10），按开始那天计一次。'
                : model.dailyMode === 'exact'
                  ? '每天就在这个时间执行一次，不随机。'
                  : '以该时间为中心，前后各随机浮动 N 分钟内执行。'
            }}
          </p>
        </template>

        <template v-else>
          <div class="form-grid-2" data-error-key="intervalValue">
            <div class="field">
              <label class="field-label">每隔 <span class="req">*</span></label>
              <a-input-number v-model:value="model.intervalValue" :min="1" :step="1" style="width: 100%" />
            </div>
            <div class="field">
              <label class="field-label">单位</label>
              <a-select v-model:value="model.intervalUnit" :options="unitOptions" style="width: 100%" />
            </div>
            <div v-if="errors.intervalValue" class="field-error" style="grid-column: 1 / -1">
              {{ errors.intervalValue }}
            </div>
          </div>

          <div class="form-grid-2">
            <div class="field">
              <label class="field-label">第一次执行时间（可选）</label>
              <a-date-picker
                v-model:value="model.intervalStart"
                show-time
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm"
                style="width: 100%"
                placeholder="留空 = 从现在开始算"
              />
            </div>
            <div class="field" data-error-key="intervalJitter">
              <label class="field-label">随机抖动（秒，可选）</label>
              <a-input-number v-model:value="model.intervalJitter" :min="0" style="width: 100%" />
              <div v-if="errors.intervalJitter" class="field-error">{{ errors.intervalJitter }}</div>
            </div>
          </div>
          <p class="field-hint">
            每隔 N 秒 / 分钟 / 小时 / 天执行一次。第一次执行时间留空 = 从现在开始算；填了就从该时刻起对齐。抖动会给每次再加 0–N 秒随机偏移。
          </p>
        </template>

        <div v-if="preview && preview.next.length" class="field">
          <div class="field-label-row">
            <span class="field-label">接下来 7 次执行</span>
            <span class="muted" style="font-size: 11.5px">{{ previewNote }}</span>
          </div>
          <div class="preview-list">
            <span v-for="timestamp in preview.next" :key="timestamp" class="preview-chip">
              {{ previewLabel(timestamp) }}
            </span>
          </div>
        </div>

        <p v-if="timeoutWarning" class="field-hint warn">
          当前未设置请求超时（requestTimeoutMs = 0）：目标地址一直不返回时，这次执行会一直占着该任务。可在
          jitter.config.json 里设置 requestTimeoutMs（毫秒，建议 30000）。
        </p>

        <div class="field">
          <a-switch v-model:checked="model.runOnStartup" size="small" />
          <span style="margin-left: 8px">电脑启动后自动执行一次</span>
          <p class="field-hint">
            默认关闭；只对当前任务生效。Jitter 每次启动后执行一次，仍会检查执行条件，条件不满足就跳过。
          </p>
        </div>
      </section>

      <!-- 3. 成功与通知 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">3</span>
          <div>
            <h3>成功与通知</h3>
            <p>默认任意 2xx 视为成功；需要时可自定义判定，并在成功时发送通知。</p>
          </div>
        </div>

        <a-collapse v-model:active-key="expectOpen" ghost>
          <a-collapse-panel key="expect">
            <template #header>
              <span style="font-weight: 600; font-size: 13px">成功条件</span>
              <span class="muted" style="margin-left: 8px; font-size: 12px">{{ expectSummary }}</span>
            </template>
            <div class="form-grid-2">
              <div class="field" data-error-key="expectStatus">
                <label class="field-label">期望状态码（可选）</label>
                <a-input
                  v-model:value="model.expectStatus"
                  placeholder="例如 200"
                  :status="errors.expectStatus ? 'error' : undefined"
                />
                <div v-if="errors.expectStatus" class="field-error">{{ errors.expectStatus }}</div>
              </div>
              <div class="field">
                <label class="field-label">期望响应体（可选，完全相等）</label>
                <a-textarea
                  v-model:value="model.expectBody"
                  :auto-size="{ minRows: 2, maxRows: 4 }"
                  placeholder='例如 {"code":0}'
                  class="mono"
                />
              </div>
            </div>
            <div class="field">
              <label class="field-label">条件表达式（可选）</label>
              <a-textarea
                v-model:value="model.expectExpr"
                :auto-size="{ minRows: 2, maxRows: 5 }"
                placeholder="例如 data.result.remindtype=0"
                class="mono"
              />
            </div>
            <p class="field-hint">
              三项都不填 = 任意 2xx 视为成功；填了则需全部满足。只填表达式时不会额外限制 2xx。
              支持 = / == / != / &gt; / &lt;、&amp;&amp; / || / !、三元与 $status；路径取不到按不成立处理。
            </p>
          </a-collapse-panel>
        </a-collapse>

        <div class="field" style="margin-top: 8px">
          <a-switch v-model:checked="model.notifyEnabled" size="small" />
          <span style="margin-left: 8px">成功时发送通知</span>
          <p class="field-hint">只有判定成功才发送；通知失败只记录它自己的结果，不影响任务。</p>
        </div>

        <div v-if="model.notifyEnabled" class="field" data-error-key="notifyCurl">
          <label class="field-label">通知 curl <span class="req">*</span></label>
          <a-textarea
            v-model:value="model.notifyCurl"
            :status="errors.notifyCurl ? 'error' : undefined"
            :auto-size="{ minRows: 3, maxRows: 8 }"
            class="mono"
            placeholder="curl -X POST 'https://notify.example/hook' -H 'Content-Type: application/json' -d '{&quot;text&quot;:&quot;签到成功&quot;}'"
          />
          <div v-if="errors.notifyCurl" class="field-error">{{ errors.notifyCurl }}</div>
        </div>
      </section>

      <!-- 4. 执行条件 -->
      <section class="form-section">
        <div class="section-head">
          <span class="section-step">4</span>
          <div>
            <h3>执行条件（可选）</h3>
            <p>只在满足条件时执行；不满足会跳过本次并记录原因。「立即执行」不受限制。</p>
          </div>
        </div>

        <div class="field">
          <a-switch v-model:checked="precheckOn" size="small" />
          <span style="margin-left: 8px">只在满足条件时执行</span>
        </div>

        <ConditionFields
          v-if="precheckOn"
          v-model="model.conditions"
          :env-text="envText"
          :errors="{
            timeStart: errors.condTime ?? '',
            timeEnd: errors.condTime ?? '',
            expectStatus: errors.condStatus ?? '',
            curl: errors.condCurl ?? '',
            any: errors.condAny ?? '',
          }"
        />
      </section>

      <div class="sticky-actions">
        <div class="hint">
          <template v-if="dirty">有未保存的修改</template>
          <template v-else-if="editingId">保存后按新配置继续定时，任务保持原有运行状态</template>
          <template v-else>带 <span class="req">*</span> 为必填；其余可留空使用默认值</template>
        </div>
        <div class="buttons">
          <a-button @click="onCancel">{{ editingId ? '取消编辑' : '重置' }}</a-button>
          <a-button type="primary" :loading="submitting" @click="submit">
            {{ editingId ? '保存修改' : '创建任务' }}
          </a-button>
        </div>
      </div>
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
