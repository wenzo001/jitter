<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { TestBenchConfig, TestBenchResult, TestRunSummary } from '@/types/testbench'
import type { ConditionModel } from '@/types/form'
import { emptyCondition } from '@/types/form'
import { getTestRun, listTestRuns, runTestBench } from '@/api/testbench'
import { useAppStore } from '@/stores/app'
import { formatShortTime, formatTime, prettyJson } from '@/utils/format'
import { describeHostEnvironment } from '@/utils/environment'
import ConditionFields from '@/components/task/ConditionFields.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  apply: [config: TestBenchConfig]
}>()

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
  if (summary.skipped) return '执行条件未满足，本次跳过'
  if (summary.matched) return summary.notifySent ? '成功，已发送通知' : '成功'
  if (summary.error) return '执行失败'
  return '未满足成功条件'
})

const summaryColor = computed(() => {
  const summary = result.value?.summary
  if (!summary) return 'default'
  if (summary.skipped) return 'orange'
  if (summary.matched) return 'success'
  if (summary.error) return 'error'
  return 'orange'
})

const stepMeta: Record<string, { label: string; cls: string }> = {
  ok: { label: '通过', cls: 'is-ok' },
  fail: { label: '失败', cls: 'is-fail' },
  skip: { label: '跳过', cls: 'is-skip' },
  info: { label: '提示', cls: 'is-info' },
}

function stepLabel(status: string): string {
  return stepMeta[status]?.label ?? status
}

function stepClass(status: string): string {
  return stepMeta[status]?.cls ?? 'is-info'
}

const envText = computed(() => describeHostEnvironment(app.environment))

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
    error.value = '请粘贴主请求 curl'
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
        error.value = '执行时段需要同时填写开始和结束时间'
        return null
      }
      if (cond.timeStart === cond.timeEnd) {
        error.value = '执行时段的开始和结束时间不能相同'
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
      error.value = '配置了条件状态码或表达式时，必须填写条件检查 curl'
      return null
    }
    if (rawStatus) {
      const status = Number(rawStatus)
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        error.value = '条件检查的期望状态码必须是 100–599 的整数'
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
      error.value = '启用执行条件时，至少配置星期、时段、电源、本机 IP 或前置 curl 之一'
      return null
    }
  }

  if (expectStatus.value.trim()) {
    const status = Number(expectStatus.value)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      error.value = '期望状态码必须是 100–599 的整数'
      return null
    }
    payload.expect_status = status
  }
  if (expectBody.value !== '') payload.expect_body = expectBody.value
  if (expectExpr.value.trim() !== '') payload.expect_expr = expectExpr.value.trim()

  if (notifyEnabled.value) {
    if (!notifyCurl.value.trim()) {
      error.value = '请填写通知 curl'
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
    app.setStatus(`测试完成：${summaryText.value}`)
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
      app.setStatus(`查看 ${formatTime(data.run.created_at)} 的测试记录`)
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
    :title="taskName ? `试跑 · ${taskName}` : '试跑 curl'"
    width="min(760px, 96vw)"
    :footer="null"
    @update:open="!$event && close()"
    @cancel="close"
  >
    <p class="field-hint" style="margin-top: 0">
      按正式执行的完整链路跑一遍：解析 → 本地条件 → 条件检查 → 主请求 → 成功判定 → 通知预览。不会写执行记录，也不会真正发送通知（除非勾选）。
    </p>

    <div class="field test-curl">
      <label class="field-label">主请求 curl <span class="req">*</span></label>
      <a-textarea
        v-model:value="curl"
        :auto-size="{ minRows: 5, maxRows: 12 }"
        class="mono"
        placeholder="curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' -d '{&quot;ok&quot;:true}'"
      />
    </div>

    <a-divider style="margin: 10px 0">执行条件</a-divider>
    <a-switch v-model:checked="precheckEnabled" size="small" />
    <span style="margin-left: 8px">模拟「只在满足条件时执行」</span>
    <ConditionFields
      v-if="precheckEnabled"
      v-model="conditions"
      :env-text="envText"
      style="margin-top: 10px"
    />

    <a-divider style="margin: 10px 0">成功条件</a-divider>
    <div class="form-grid-2">
      <div class="field">
        <label class="field-label">期望状态码（可选）</label>
        <a-input v-model:value="expectStatus" placeholder="例如 200" />
      </div>
      <div class="field">
        <label class="field-label">期望响应体（可选，完全相等）</label>
        <a-textarea v-model:value="expectBody" :auto-size="{ minRows: 1, maxRows: 4 }" class="mono" />
      </div>
    </div>
    <div class="field">
      <label class="field-label">条件表达式（可选）</label>
      <a-textarea v-model:value="expectExpr" :auto-size="{ minRows: 1, maxRows: 4 }" class="mono" />
    </div>

    <a-divider style="margin: 10px 0">通知</a-divider>
    <a-switch v-model:checked="notifyEnabled" size="small" />
    <span style="margin-left: 8px">成功时发送通知</span>
    <div v-if="notifyEnabled" style="margin-top: 8px">
      <a-textarea
        v-model:value="notifyCurl"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        class="mono"
        placeholder="通知 curl"
      />
      <a-checkbox v-model:checked="sendNotify" style="margin-top: 6px">
        这次试跑真的发送通知（默认只预览）
      </a-checkbox>
    </div>

    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-top: 12px" />

    <div style="display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; flex-wrap: wrap">
      <a-button :disabled="!curl.trim()" @click="apply">带入表单</a-button>
      <div style="display: flex; gap: 8px">
        <a-button @click="close">关闭</a-button>
        <a-button type="primary" :loading="running" @click="send">开始测试</a-button>
      </div>
    </div>

    <div v-if="history.length" style="margin-top: 14px">
      <div class="field-label">最近测试留档（点击回看）</div>
      <div class="test-history">
        <a-button
          v-for="run in history"
          :key="run.id"
          size="small"
          @click="showRun(run.id)"
        >
          {{ formatShortTime(run.created_at) }} {{ run.ok ? '成功' : '未成功' }}
        </a-button>
      </div>
    </div>

    <template v-if="result">
      <a-divider style="margin: 16px 0 12px">测试结果</a-divider>
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
        <a-tag :color="summaryColor">{{ summaryText }}</a-tag>
        <span class="muted">总耗时 {{ result.summary.totalMs ?? 0 }} ms</span>
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
            <summary class="muted" style="cursor: pointer; font-size: 12px">请求 / 响应详情</summary>
            <div style="margin-top: 6px">
              <div v-if="step.request" class="detail-block">
                <h4>请求</h4>
                <pre>{{ step.request.method }} {{ step.request.url }}</pre>
              </div>
              <div
                v-if="step.request && Object.keys(step.request.headers ?? {}).length"
                class="detail-block"
              >
                <h4>请求头</h4>
                <pre>{{
                  Object.entries(step.request.headers)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')
                }}</pre>
              </div>
              <div v-if="step.request?.body" class="detail-block">
                <h4>请求体</h4>
                <pre>{{ step.request.body }}</pre>
              </div>
              <div v-if="step.response" class="detail-block">
                <h4>响应状态</h4>
                <pre>{{ step.response.status ?? '无响应' }}</pre>
              </div>
              <div
                v-if="step.response && Object.keys(step.response.headers ?? {}).length"
                class="detail-block"
              >
                <h4>响应头</h4>
                <pre>{{
                  Object.entries(step.response.headers ?? {})
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')
                }}</pre>
              </div>
              <div v-if="step.response" class="detail-block">
                <h4>响应体</h4>
                <pre>{{ step.response.body ? prettyJson(step.response.body) : '（空）' }}</pre>
                <div v-if="step.response.truncated" class="muted" style="font-size: 12px">
                  响应体超过上限，已截断
                </div>
              </div>
            </div>
          </details>
        </li>
      </ul>
    </template>
  </a-modal>
</template>
