<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import zhCN from 'antdv-next/locale/zh_CN'
import { getTask, resumeTask, runTask, startTask, stopTask } from '@/api/tasks'
import type { Task } from '@/types/task'
import type { TestBenchConfig } from '@/types/testbench'
import { useAppStore } from '@/stores/app'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { conditionFromTask } from '@/types/form'
import { curlOf } from '@/utils/curl'
import { formatDuration, formatRate } from '@/utils/format'
import TaskList from '@/components/task/TaskList.vue'
import TaskForm from '@/components/task/TaskForm.vue'
import LogsPanel from '@/components/logs/LogsPanel.vue'
import TestBenchDialog from '@/components/dialogs/TestBenchDialog.vue'
import PauseDialog from '@/components/dialogs/PauseDialog.vue'
import DeleteTaskDialog from '@/components/dialogs/DeleteTaskDialog.vue'
import CleanupLogsDialog from '@/components/dialogs/CleanupLogsDialog.vue'
import StatsDialog from '@/components/dialogs/StatsDialog.vue'
import SettingsDialog from '@/components/dialogs/SettingsDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const app = useAppStore()
const tasks = useTasksStore()
const logs = useLogsStore()

const taskFormRef = ref<InstanceType<typeof TaskForm> | null>(null)
const testRef = ref<InstanceType<typeof TestBenchDialog> | null>(null)

const statsOpen = ref(false)
const settingsOpen = ref(false)
const cleanupOpen = ref(false)
const globalTestOpen = ref(false)

const pauseOpen = ref(false)
const pauseTarget = ref<Task | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<Task | null>(null)

const runTarget = ref<Task | null>(null)
const busyId = ref<string | null>(null)

const theme = {
  token: {
    colorPrimary: '#2563eb',
    colorInfo: '#2563eb',
    borderRadius: 8,
    colorBgLayout: '#f5f6f8',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  },
}

const metricsText = computed(() => {
  const overview = app.metrics?.overview
  if (!overview) return ''
  const parts = [
    `今日 ${overview.today_runs} 次`,
    `成功率 ${formatRate(overview.success_rate_7d)}`,
    `均耗时 ${formatDuration(overview.avg_duration_ms_7d)}`,
  ]
  if (overview.running > 0) parts.push(`${overview.running} 个执行中`)
  return parts.join(' · ')
})

const runContent = computed(() => {
  const task = runTarget.value
  if (!task) return ''
  return `会真实发送请求；满足成功条件时还会发送通知 curl，并写入执行记录。\n执行条件不满足时会跳过本次。任务「${task.name}」`
})

async function refreshLogs(reset = true) {
  await logs.load(tasks.selectedId, { reset, pageSize: app.config.logsPageSize })
}

async function refreshAll() {
  try {
    await tasks.load()
    if (tasks.selectedId) await refreshLogs(false)
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function selectTask(id: string) {
  tasks.select(id)
}

async function editTask(task: Task) {
  try {
    const data = await getTask(task.id)
    if (!data?.task) return
    taskFormRef.value?.loadTask(data.task)
    document.querySelector('.task-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    app.setStatus(`正在编辑任务「${task.name}」`)
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

async function testTask(task: Task) {
  try {
    const data = await getTask(task.id)
    if (!data?.task) return
    const full = data.task
    const config: TestBenchConfig = {
      curl: curlOf(full),
      precheckEnabled: full.precheck_enabled === 1,
      conditions: conditionFromTask(full),
      expectStatus:
        full.expect_status === null || full.expect_status === undefined
          ? ''
          : String(full.expect_status),
      expectBody: full.expect_body ?? '',
      expectExpr: full.expect_expr ?? '',
      notifyEnabled: full.notify_enabled === 1,
      notifyCurl: full.notify_curl_command ?? '',
      taskId: full.id,
      taskName: full.name,
    }
    globalTestOpen.value = true
    testRef.value?.openWith(config)
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function openGlobalTest() {
  globalTestOpen.value = true
  testRef.value?.openWith()
}

function applyGlobalTest(config: TestBenchConfig) {
  taskFormRef.value?.applyTestConfig(config)
  document.querySelector('.task-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function onReorder(ids: string[]) {
  const previous = tasks.tasks.map((task) => task.id).join(',')
  if (previous === ids.join(',')) return
  try {
    await tasks.applyOrder(ids)
    app.setStatus('任务顺序已保存')
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
    await tasks.load()
  }
}

async function onRun(task: Task) {
  runTarget.value = task
}

async function doRun() {
  const task = runTarget.value
  if (!task) return
  runTarget.value = null
  busyId.value = task.id
  try {
    const data = await runTask(task.id)
    const parts = [data.skipped ? `任务「${task.name}」被执行条件跳过` : `任务「${task.name}」已执行一次`]
    if (!data.skipped && data.status !== null) parts.push(`HTTP ${data.status}`)
    if (data.error) parts.push(data.error)
    else if (data.matched) parts.push(data.notifySent ? '成功并发通知' : '成功')
    else parts.push('未满足成功条件')
    if (!data.skipped) parts.push(`${data.durationMs} ms`)
    app.setStatus(parts.join(' · '), Boolean(data.error))
    await tasks.load()
    await refreshLogs(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = message.includes('请求超时')
    app.setStatus(
      timedOut
        ? `任务「${task.name}」超过 60 秒未返回，已断开等待；后台可能仍在执行，稍后刷新执行记录查看`
        : message,
      true,
    )
    await tasks.load()
  } finally {
    busyId.value = null
  }
}

async function action(task: Task, kind: 'stop' | 'start' | 'resumePause') {
  busyId.value = task.id
  try {
    if (kind === 'stop') await stopTask(task.id)
    else if (kind === 'start') await startTask(task.id)
    else await resumeTask(task.id)
    app.setStatus(
      kind === 'stop'
        ? '调度已停用'
        : kind === 'resumePause'
          ? '已取消暂停，恢复定时执行'
          : '已启用调度',
    )
    await tasks.load()
    await refreshLogs(true)
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  } finally {
    busyId.value = null
  }
}

function openPause(task: Task) {
  pauseTarget.value = task
  pauseOpen.value = true
}

function openDelete(task: Task) {
  deleteTarget.value = task
  deleteOpen.value = true
}

async function onPauseSaved() {
  await tasks.load()
  await refreshLogs(true)
}

async function onDeleted(id: string) {
  taskFormRef.value?.resetIfEditing(id)
  logs.clear()
  await tasks.load()
  if (tasks.selectedId) await refreshLogs(true)
}

async function onCleanupDone() {
  logs.clear()
  await tasks.load()
  if (tasks.selectedId) await refreshLogs(true)
}

let pollTimer: number | undefined
let tickTimer: number | undefined
let metricsTimer: number | undefined

function startTimers() {
  const interval = Math.max(500, Number(app.config.pollIntervalMs) || 4000)
  tickTimer = window.setInterval(() => tasks.tick(), 1000)
  pollTimer = window.setInterval(() => {
    if (document.hidden) return
    void refreshAll()
  }, interval)
  metricsTimer = window.setInterval(() => {
    if (!document.hidden) void app.refreshMetrics()
  }, 15_000)
}

function onVisible() {
  if (!document.hidden) {
    tasks.tick()
    void refreshAll()
    void app.refreshMetrics()
  }
}

onMounted(async () => {
  await app.loadConfig()
  try {
    await tasks.load()
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
  await app.loadSystem()
  void app.refreshMetrics()
  void app.loadHoliday()
  startTimers()
  document.addEventListener('visibilitychange', onVisible)
})

onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  window.clearInterval(tickTimer)
  window.clearInterval(metricsTimer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="theme">
    <header class="app-topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-mark" />
          <span class="brand-name">Jitter</span>
          <span v-if="app.version" class="muted" style="font-size: 12px">v{{ app.version }}</span>
          <span class="brand-sub">先测通，再定时 · 按秒 / 分 / 时 / 天调用 curl</span>
        </div>
        <div class="topbar-actions">
          <span v-if="metricsText" class="metrics-strip">{{ metricsText }}</span>
          <a-button size="small" @click="statsOpen = true">统计</a-button>
          <a-button size="small" @click="settingsOpen = true">设置</a-button>
          <a-button size="small" type="primary" ghost @click="openGlobalTest">试跑 curl</a-button>
          <span class="status-line" :class="{ 'is-error': app.status.error }">{{ app.status.text }}</span>
        </div>
      </div>
    </header>

    <a-alert
      v-if="app.banner"
      :type="app.banner.kind === 'success' ? 'success' : 'error'"
      :message="app.banner.text"
      banner
      closable
      style="border-radius: 0"
      @close="app.dismissBanner()"
    />

    <main class="page">
      <div class="layout">
        <section class="column">
          <div class="panel">
            <div class="panel-head">
              <h2 class="panel-title">任务 <small>{{ tasks.tasks.length }} 个</small></h2>
              <a-button size="small" type="text" :loading="tasks.loading" @click="refreshAll">
                刷新
              </a-button>
            </div>
            <TaskList
              :tasks="tasks.tasks"
              :selected-id="tasks.selectedId"
              :now="tasks.now"
              :busy-id="busyId"
              @select="selectTask"
              @run="onRun"
              @edit="editTask"
              @test="testTask"
              @pause="openPause"
              @resume-pause="action($event, 'resumePause')"
              @stop="action($event, 'stop')"
              @start="action($event, 'start')"
              @remove="openDelete"
              @reorder="onReorder"
            />
          </div>

          <TaskForm ref="taskFormRef" @saved="refreshAll" />
        </section>

        <section class="column">
          <LogsPanel @cleanup="cleanupOpen = true" />
        </section>
      </div>
    </main>

    <PauseDialog v-model:open="pauseOpen" :task="pauseTarget" @saved="onPauseSaved" />
    <DeleteTaskDialog v-model:open="deleteOpen" :task="deleteTarget" @deleted="onDeleted" />
    <CleanupLogsDialog v-model:open="cleanupOpen" @done="onCleanupDone" />
    <StatsDialog v-model:open="statsOpen" />
    <SettingsDialog v-model:open="settingsOpen" @cleanup="cleanupOpen = true" />
    <TestBenchDialog v-model:open="globalTestOpen" ref="testRef" @apply="applyGlobalTest" />

    <ConfirmDialog
      :open="runTarget !== null"
      title="立即执行任务"
      :content="runContent"
      ok-text="执行"
      @update:open="runTarget = null"
      @confirm="doRun"
    />
  </a-config-provider>
</template>
