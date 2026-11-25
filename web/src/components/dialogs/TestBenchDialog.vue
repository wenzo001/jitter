<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TestBenchConfig, TestBenchResult, TestRunSummary } from '@/types/testbench'
import type { ConditionModel } from '@/types/form'
import { emptyCondition } from '@/types/form'
import { getTestRun, listTestRuns, runTestBench } from '@/api/testbench'
import { useAppStore } from '@/stores/app'
import { formatShortTime, formatTime } from '@/utils/format'
import { describeHostEnvironment } from '@/utils/environment'
import ConditionFields from '@/components/task/ConditionFields.vue'
import CodeBlock from '@/components/common/CodeBlock.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  apply: [config: TestBenchConfig]
}>()

const { t } = useI18n()

const app = useAppStore()

const curl = ref('')
const precheckEnabled = ref(false)
const conditions = ref<ConditionModel>(emptyCondition())
const expectStatus = ref('')
const expectBody = ref('')
const expectExpr = ref('')
const notifyEnabled = ref(false)
const notifyCurl = ref('')
const sendNotify = ref(false)
const taskId = ref<string | null>(null)
const taskName = ref('')

const running = ref(false)
const error = ref('')
const result = ref<TestBenchResult | null>(null)
const history = ref<TestRunSummary[]>([])

const summaryText = computed(() => {
  const summary = result.value?.summary
  if (!summary) return ''
  if (summary.skipped) return t('testbench.summarySkipped')
  if (summary.matched) return summary.notifySent ? t('testbench.summaryNotified') : t('testbench.summarySuccess')
  if (summary.error) return t('testbench.summaryFailed')
  return t('testbench.summaryNotMet')
})

const summaryColor = computed(() => {
  const summary = result.value?.summary
  if (!summary) return 'default'
  if (summary.skipped) return 'orange'
  if (summary.matched) return 'success'
  if (summary.error) return 'error'
  return 'orange'
})

const STEP_META: Record<string, { cls: string }> = {
  ok: { cls: 'is-ok' },
  fail: { cls: 'is-fail' },
  skip: { cls: 'is-skip' },
  info: { cls: 'is-info' },
}

const STEP_LABELS: Record<string, string> = {
  ok: 'testbench.stepOk',
  fail: 'testbench.stepFail',
  skip: 'testbench.stepSkip',
  info: 'testbench.stepInfo',
}

function stepLabel(status: string): string {
  const key = STEP_LABELS[status]
  return key ? t(key) : status
}

function stepClass(status: string): string {
  return STEP_META[status]?.cls ?? 'is-info'
}

const envText = computed(() => describeHostEnvironment(app.environment, t))

function openWith(config?: Partial<TestBenchConfig>) {
  curl.value = config?.curl ?? ''
  precheckEnabled.value = config?.precheckEnabled ?? false
  conditions.value = config?.conditions
    ? JSON.parse(JSON.stringify(config.conditions))
    : emptyCondition()
  expectStatus.value = config?.expectStatus ?? ''
  expectBody.value = config?.expectBody ?? ''
  expectExpr.value = config?.expectExpr ?? ''
  notifyEnabled.value = config?.notifyEnabled ?? false
  notifyCurl.value = config?.notifyCurl ?? ''
  sendNotify.value = false
  taskId.value = config?.taskId ?? null
  taskName.value = config?.taskName ?? ''
  result.value = null
  error.value = ''
  running.value = false
  history.value = []
  if (taskId.value) void loadHistory()
  if (!curl.value.trim()) {
    nextTick(() => {
      const node = document.querySelector<HTMLTextAreaElement>('.test-curl textarea')
      node?.focus()
    })
  }
  if (precheckEnabled.value) void app.loadEnvironment(true)
}

function close() {
  if (running.value) return
  emit('update:open', false)
}

async function loadHistory() {
  if (!taskId.value) return
  try {
    const data = await listTestRuns(taskId.value)
    history.value = data.runs ?? []
  } catch {
    history.value = []
  }
}

function buildPayload(): Record<string, unknown> | null {
  const value = curl.value.trim()
  if (!value) {
    error.value = t('testbench.errNoCurl')
    return null
  }
  const payload: Record<string, unknown> = {
    curl: value,
    precheck_enabled: precheckEnabled.value,
    notify_enabled: notifyEnabled.value,
    send_notify: sendNotify.value,
  }
  if (taskId.value) payload.task_id = taskId.value

  if (precheckEnabled.value) {
    const cond = conditions.value
    if (cond.weekdays.length > 0) payload.precheck_weekdays = cond.weekdays
    if (cond.timeStart || cond.timeEnd) {
      if (!cond.timeStart || !cond.timeEnd) {
        error.value = t('testbench.errTimeRange')
        return null
      }
      if (cond.timeStart === cond.timeEnd) {
        error.value = t('testbench.errTimeSame')
        return null
      }
      payload.precheck_time_start = cond.timeStart
      payload.precheck_time_end = cond.timeEnd
    }
    if (cond.curl.trim()) payload.precheck_curl = cond.curl.trim()
    if (cond.ipPattern.trim()) payload.precheck_ip_pattern = cond.ipPattern.trim()
    if (cond.requireAc) payload.precheck_require_ac = true
    if (cond.dayType) payload.precheck_day_type = cond.dayType
    const rawStatus = cond.expectStatus.trim()
    const expr = cond.expr.trim()
    if (!cond.curl.trim() && (rawStatus || expr)) {
      error.value = t('testbench.errCondStatusOrExpr')
      return null
    }
    if (rawStatus) {
      const status = Number(rawStatus)
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        error.value = t('testbench.errCondStatusRange')
        return null
      }
      payload.precheck_expect_status = status
    }
    if (expr) payload.precheck_expr = expr
    const hasAny =
      cond.weekdays.length > 0 ||
      Boolean(cond.timeStart) ||
      cond.requireAc ||
      Boolean(cond.ipPattern.trim()) ||
      Boolean(cond.dayType) ||
      Boolean(cond.curl.trim())
    if (!hasAny) {
      error.value = t('testbench.errCondAny')
      return null
    }
  }

  if (expectStatus.value.trim()) {
    const status = Number(expectStatus.value)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      error.value = t('testbench.errExpectStatusRange')
      return null
    }
    payload.expect_status = status
  }
  if (expectBody.value !== '') payload.expect_body = expectBody.value
  if (expectExpr.value.trim() !== '') payload.expect_expr = expectExpr.value.trim()

  if (notifyEnabled.value) {
    if (!notifyCurl.value.trim()) {
      error.value = t('testbench.errNoNotifyCurl')
      return null
    }
    payload.notify_curl = notifyCurl.value.trim()
  }

  return payload
}

async function send() {
  if (running.value) return
  error.value = ''
  const payload = buildPayload()
  if (!payload) return

  running.value = true
  result.value = null
  try {
    const data = await runTestBench(payload as never)
    result.value = data.result
    app.setStatus(t('testbench.statusDone', { summary: summaryText.value }))
    if (taskId.value) void loadHistory()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    running.value = false
  }
}

async function showRun(id: number) {
  try {
    const data = await getTestRun(id)
    if (data.run) {
      result.value = { steps: data.run.steps, summary: data.run.summary }
      app.setStatus(t('testbench.statusView', { time: formatTime(data.run.created_at) }))
    }
  } catch (err) {
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  }
}

function apply() {
  const config: TestBenchConfig = {
    curl: curl.value.trim(),
    precheckEnabled: precheckEnabled.value,
    conditions: JSON.parse(JSON.stringify(conditions.value)),
    expectStatus: expectStatus.value,
    expectBody: expectBody.value,
    expectExpr: expectExpr.value,
    notifyEnabled: notifyEnabled.value,
    notifyCurl: notifyCurl.value,
    taskId: taskId.value,
    taskName: taskName.value,
  }
  emit('apply', config)
  emit('update:open', false)
}

defineExpose({ openWith })
</script>

<template>
  <a-modal
    :open="open"
    :title="taskName ? $t('testbench.titleWithTask', { name: taskName }) : $t('testbench.title')"
    width="min(760px, 96vw)"
    :footer="null"
    @update:open="!$event && close()"
    @cancel="close"
  >
    <p class="field-hint" style="margin-top: 0">
      {{ $t('testbench.intro') }}
    </p>

    <div class="field test-curl">
      <label class="field-label">{{ $t('testbench.curlLabel') }} <span class="req">*</span></label>
      <a-textarea
        v-model:value="curl"
        :auto-size="{ minRows: 5, maxRows: 12 }"
        class="mono"
        placeholder="curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' -d '{&quot;ok&quot;:true}'"
      />
    </div>

    <a-divider style="margin: 10px 0">{{ $t('testbench.sectionCondition') }}</a-divider>
    <a-switch v-model:checked="precheckEnabled" size="small" />
    <span style="margin-left: 8px">{{ $t('testbench.simulateCondition') }}</span>
    <ConditionFields
      v-if="precheckEnabled"
      v-model="conditions"
      :env-text="envText"
      style="margin-top: 10px"
    />

    <a-divider style="margin: 10px 0">{{ $t('testbench.sectionSuccess') }}</a-divider>
    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">{{ $t('testbench.expectStatus') }}</label>
        <a-input v-model:value="expectStatus" :placeholder="t('testbench.expectStatusPlaceholder')" />
      </div>
      <div class="field">
        <label class="field-label">{{ $t('testbench.expectBody') }}</label>
        <a-textarea v-model:value="expectBody" :auto-size="{ minRows: 1, maxRows: 4 }" class="mono" />
      </div>
    </div>
    <div class="field">
      <label class="field-label">{{ $t('testbench.expectExpr') }}</label>
      <a-textarea v-model:value="expectExpr" :auto-size="{ minRows: 1, maxRows: 4 }" class="mono" />
    </div>

    <a-divider style="margin: 10px 0">{{ $t('testbench.sectionNotify') }}</a-divider>
    <a-switch v-model:checked="notifyEnabled" size="small" />
    <span style="margin-left: 8px">{{ $t('testbench.notifyOnSuccess') }}</span>
    <div v-if="notifyEnabled" style="margin-top: 8px">
      <a-textarea
        v-model:value="notifyCurl"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        class="mono"
        :placeholder="t('testbench.notifyCurlPlaceholder')"
      />
      <a-checkbox v-model:checked="sendNotify" style="margin-top: 6px">
        {{ $t('testbench.notifyActuallySend') }}
      </a-checkbox>
    </div>

    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 12px" />

    <div style="display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; flex-wrap: wrap">
      <a-button :disabled="!curl.trim()" @click="apply">{{ $t('testbench.applyToForm') }}</a-button>
      <div style="display: flex; gap: 8px">
        <a-button @click="close">{{ $t('testbench.close') }}</a-button>
        <a-button type="primary" :loading="running" @click="send">{{ $t('testbench.start') }}</a-button>
      </div>
    </div>

    <div v-if="history.length" style="margin-top: 14px">
      <div class="field-label">{{ $t('testbench.historyTitle') }}</div>
      <div class="test-history">
        <a-button
          v-for="run in history"
          :key="run.id"
          size="small"
          @click="showRun(run.id)"
        >
          {{ formatShortTime(run.created_at) }}
          {{ run.ok ? $t('testbench.historySuccess') : $t('testbench.historyFail') }}
        </a-button>
      </div>
    </div>

    <template v-if="result">
      <a-divider style="margin: 16px 0 12px">{{ $t('testbench.resultTitle') }}</a-divider>
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
        <a-tag :color="summaryColor">{{ summaryText }}</a-tag>
        <span class="muted">{{ $t('testbench.totalDuration', { value: result.summary.totalMs ?? 0 }) }}</span>
      </div>
      <ul style="list-style: none; padding: 0; margin: 0">
        <li
          v-for="(step, index) in result.steps"
          :key="step.key"
          class="test-step"
          :class="stepClass(step.status)"
        >
          <div class="test-step-head">
            <span class="test-step-index">{{ index + 1 }}</span>
            <span class="test-step-title">{{ step.title }}</span>
            <a-tag>{{ stepLabel(step.status) }}</a-tag>
            <span v-if="step.durationMs !== null && step.durationMs !== undefined" class="muted">
              {{ step.durationMs }} ms
            </span>
          </div>
          <div class="test-step-detail">{{ step.detail }}</div>
          <details v-if="step.request || step.response" style="margin-top: 6px">
            <summary class="muted" style="cursor: pointer; font-size: 12px">
              {{ $t('testbench.detailToggle') }}
            </summary>
            <div style="margin-top: 6px">
              <div v-if="step.request" class="detail-block">
                <h4>{{ $t('testbench.request') }}</h4>
                <pre>{{ step.request.method }} {{ step.request.url }}</pre>
              </div>
              <div
                v-if="step.request && Object.keys(step.request.headers ?? {}).length"
                class="detail-block"
              >
                <h4>{{ $t('testbench.requestHeaders') }}</h4>
                <pre>{{
                  Object.entries(step.request.headers)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')
                }}</pre>
              </div>
              <div v-if="step.request?.body" class="detail-block">
                <h4>{{ $t('testbench.requestBody') }}</h4>
                <pre>{{ step.request.body }}</pre>
              </div>
              <div v-if="step.response" class="detail-block">
                <h4>{{ $t('testbench.responseStatus') }}</h4>
                <pre>{{ step.response.status ?? $t('testbench.noResponse') }}</pre>
              </div>
              <div
                v-if="step.response && Object.keys(step.response.headers ?? {}).length"
                class="detail-block"
              >
                <h4>{{ $t('testbench.responseHeaders') }}</h4>
                <pre>{{
                  Object.entries(step.response.headers ?? {})
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')
                }}</pre>
              </div>
              <div v-if="step.response" class="detail-block">
                <h4>{{ $t('testbench.responseBody') }}</h4>
                <CodeBlock :text="step.response.body" :empty="$t('testbench.emptyBody')" />
                <div v-if="step.response.truncated" class="muted" style="font-size: 12px">
                  {{ $t('testbench.truncated') }}
                </div>
              </div>
            </div>
          </details>
        </li>
      </ul>
    </template>
  </a-modal>
</template>
