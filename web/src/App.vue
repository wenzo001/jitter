<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import type { MenuProps } from 'antdv-next'
import zhCN from 'antdv-next/locale/zh_CN'
import enUS from 'antdv-next/locale/en_US'
import { getTask, resumeTask, runTask, startTask, stopTask } from '@/api/tasks'
import { BACKEND_MARKERS } from '@/api/client'
import type { Task } from '@/types/task'
import type { TestBenchConfig } from '@/types/testbench'
import { useAppStore } from '@/stores/app'
import { useDiagnosticsStore } from '@/stores/diagnostics'
import { useLogsStore } from '@/stores/logs'
import { useTasksStore } from '@/stores/tasks'
import { conditionFromTask } from '@/types/form'
import { curlOf } from '@/utils/curl'
import { formatDuration, formatRate } from '@/utils/format'
import { setLocale, type Locale } from '@/i18n'
import TaskList from '@/components/task/TaskList.vue'
import TaskForm from '@/components/task/TaskForm.vue'
import LogsPanel from '@/components/logs/LogsPanel.vue'
import TopClock from '@/components/common/TopClock.vue'
import TestBenchDialog from '@/components/dialogs/TestBenchDialog.vue'
import PauseDialog from '@/components/dialogs/PauseDialog.vue'
import DeleteTaskDialog from '@/components/dialogs/DeleteTaskDialog.vue'
import CleanupLogsDialog from '@/components/dialogs/CleanupLogsDialog.vue'
import StatsDialog from '@/components/dialogs/StatsDialog.vue'
import SettingsDialog from '@/components/dialogs/SettingsDialog.vue'
import CalendarDialog from '@/components/dialogs/CalendarDialog.vue'
import DatabaseDialog from '@/components/dialogs/DatabaseDialog.vue'
import DiagnosticsDialog from '@/components/dialogs/DiagnosticsDialog.vue'
import RuntimeLogsDialog from '@/components/dialogs/RuntimeLogsDialog.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const { t, locale } = useI18n()

const app = useAppStore()
const diagnostics = useDiagnosticsStore()
const tasks = useTasksStore()
const logs = useLogsStore()

const taskFormRef = ref<InstanceType<typeof TaskForm> | null>(null)
const testRef = ref<InstanceType<typeof TestBenchDialog> | null>(null)

const statsOpen = ref(false)
const settingsOpen = ref(false)
const cleanupOpen = ref(false)
const globalTestOpen = ref(false)
const calendarOpen = ref(false)
const databaseOpen = ref(false)
const diagnosticsOpen = ref(false)
const runtimeLogsOpen = ref(false)

const formOpen = ref(false)
/** 弹窗标题由「新建 / 编辑」和任务名拼出来，随语言实时变化。 */
const formMode = ref<'create' | 'edit'>('create')
const formTaskName = ref('')

const pauseOpen = ref(false)
const pauseTarget = ref<Task | null>(null)
const deleteOpen = ref(false)
const deleteTarget = ref<Task | null>(null)

const runTarget = ref<Task | null>(null)
const stopTarget = ref<Task | null>(null)
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

/** antdv-next 组件自带的文案也跟着界面语言切换。 */
const antLocale = computed(() => (locale.value === 'en-US' ? enUS : zhCN))

function onLocaleChange(value: unknown): void {
  if (value === 'zh-CN' || value === 'en-US') setLocale(value as Locale)
}

/** 「更多」菜单：次要入口 + 语言切换。 */
function onMoreClick(info: { key: string | number }): void {
  const key = String(info.key)
  switch (key) {
    case 'statistics':
      statsOpen.value = true
      break
    case 'database':
      databaseOpen.value = true
      break
    case 'runtimeLogs':
      runtimeLogsOpen.value = true
      break
    case 'diagnostics':
      diagnosticsOpen.value = true
      break
    case 'settings':
      settingsOpen.value = true
      break
    case 'lang-zh':
      onLocaleChange('zh-CN')
      break
    case 'lang-en':
      onLocaleChange('en-US')
      break
  }
}

const moreMenu = computed<MenuProps>(() => {
  // 语言项前面给当前语言打个勾：下拉里两项长得一样，不标记的话看不出当前是哪个。
  const check = (on: boolean) => (on ? '✓ ' : '')
  const items: NonNullable<MenuProps['items']> = [
    { key: 'statistics', label: t('topbar.statistics') },
    { key: 'database', label: t('topbar.database') },
    { key: 'runtimeLogs', label: t('topbar.runtimeLogs') },
    { key: 'diagnostics', label: t('topbar.diagnostics') },
    { key: 'settings', label: t('topbar.settings') },
    { type: 'divider' },
    { key: 'lang-zh', label: check(locale.value === 'zh-CN') + t('topbar.languageZh') },
    { key: 'lang-en', label: check(locale.value === 'en-US') + t('topbar.languageEn') },
  ]
  return { items, onClick: onMoreClick }
})

const formTitle = computed(() =>
  formMode.value === 'edit'
    ? t('task.editTitle', { name: formTaskName.value })
    : t('task.create'),
)

const metricsText = computed(() => {
  const overview = app.metrics?.overview
  if (!overview) return ''
  const parts = [
    t('metrics.todayRuns', { count: overview.today_runs }),
    t('metrics.successRate', { value: formatRate(overview.success_rate_7d) }),
    t('metrics.avgDuration', { value: formatDuration(overview.avg_duration_ms_7d) }),
  ]
  if (overview.running > 0) parts.push(t('metrics.runningCount', { count: overview.running }))
  return parts.join(' · ')
})

const runContent = computed(() => {
  const task = runTarget.value
  if (!task) return ''
  return t('task.runContent', { name: task.name })
})

const stopContent = computed(() =>
  t('task.stopContent', { name: stopTarget.value?.name ?? '' }),
)

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

function openCreate() {
  taskFormRef.value?.startCreate()
  formMode.value = 'create'
  formTaskName.value = ''
  formOpen.value = true
}

async function editTask(task: Task) {
  try {
    const data = await getTask(task.id)
    if (!data?.task) return
    formMode.value = 'edit'
    formTaskName.value = data.task.name
    taskFormRef.value?.loadTask(data.task)
    formOpen.value = true
    app.setStatus(t('task.editingStatus', { name: task.name }))
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
  }
}

function closeFormPanel() {
  formOpen.value = false
  formMode.value = 'create'
  formTaskName.value = ''
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
  taskFormRef.value?.startCreate()
  taskFormRef.value?.applyTestConfig(config)
  formMode.value = 'create'
  formTaskName.value = ''
  formOpen.value = true
}

async function onReorder(ids: string[]) {
  const previous = tasks.tasks.map((task) => task.id).join(',')
  if (previous === ids.join(',')) return
  try {
    await tasks.applyOrder(ids)
    app.setStatus(t('task.orderSaved'))
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
    await tasks.load()
  }
}

async function onRun(task: Task) {
  runTarget.value = task
}

function askStop(task: Task) {
  stopTarget.value = task
}

async function doStop() {
  const task = stopTarget.value
  if (!task) return
  stopTarget.value = null
  await action(task, 'stop')
}

async function doRun() {
  const task = runTarget.value
  if (!task) return
  runTarget.value = null
  busyId.value = task.id
  try {
    const data = await runTask(task.id)
    const parts = [
      data.skipped
        ? t('task.runSkipped', { name: task.name })
        : t('task.runDone', { name: task.name }),
    ]
    if (!data.skipped && data.status !== null) parts.push(`HTTP ${data.status}`)
    if (data.error) parts.push(data.error)
    else if (data.matched) parts.push(data.notifySent ? t('task.runNotified') : t('common.success'))
    else parts.push(t('task.conditionNotMet'))
    if (!data.skipped) parts.push(`${data.durationMs} ms`)
    app.setStatus(parts.join(' · '), Boolean(data.error))
    await tasks.load()
    await refreshLogs(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = message.includes(BACKEND_MARKERS.timeout)
    app.setStatus(
      timedOut ? t('task.runTimeout', { name: task.name }) : message,
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
        ? t('task.scheduleDisabled')
        : kind === 'resumePause'
          ? t('task.pauseCancelled')
          : t('task.scheduleEnabled'),
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

// 轮询与可见性交给 vueuse：定时器随组件卸载自动清理，
// 页面切到后台时自动跳过轮询，回到前台立刻补一次刷新。
const { pause: pauseTick, resume: resumeTick } = useIntervalFn(() => tasks.tick(), 1000)
const { pause: pausePoll, resume: resumePoll } = useIntervalFn(
  () => void refreshAll(),
  () => Math.max(500, Number(app.config.pollIntervalMs) || 4000),
)
const { pause: pauseMetrics, resume: resumeMetrics } = useIntervalFn(
  () => void app.refreshMetrics(),
  15_000,
)

const visibility = useDocumentVisibility()

watch(visibility, (state) => {
  if (state === 'hidden') {
    pauseTick()
    pausePoll()
    pauseMetrics()
    return
  }
  resumeTick()
  resumePoll()
  resumeMetrics()
  // 回到前台：立刻同步一次，别让用户盯着旧数据。
  tasks.tick()
  void refreshAll()
  void app.refreshMetrics()
  // 跨天后顶栏的「今天 / 工作日」标签要跟着变。
  void app.loadHoliday()
})

onMounted(async () => {
  await app.loadConfig()
  try {
    await tasks.load()
  } catch (error) {
    app.setStatus(error instanceof Error ? error.message : String(error), true)
    diagnostics.reportError(t('diagnostics.sourceTaskListFailed'), error)
  }
  await app.loadSystem()
  void app.refreshMetrics()
  void app.loadHoliday()
  resumeTick()
  resumePoll()
  resumeMetrics()
  diagnostics.startHealthPolling()
})
</script>

<template>
  <a-config-provider :locale="antLocale" :theme="theme">
    <div class="app-shell">
      <header class="app-topbar">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-mark" />
            <span class="brand-name">Jitter</span>
            <span v-if="app.version" class="muted brand-version">v{{ app.version }}</span>
            <span class="brand-sub">{{ $t('topbar.subtitle') }}</span>
          </div>
          <div class="topbar-status">
            <span class="status-line" :class="{ 'is-error': app.status.error }">{{ app.status.text }}</span>
          </div>
          <div class="topbar-clock">
            <TopClock
              :now="tasks.now"
              :today="app.holiday?.today ?? null"
              @open-calendar="calendarOpen = true"
            />
          </div>
          <div class="topbar-actions">
            <span v-if="metricsText" class="metrics-strip">{{ metricsText }}</span>
            <a-button size="small" type="primary" ghost @click="openGlobalTest">
              {{ $t('topbar.testCurl') }}
            </a-button>
            <!-- 次要入口收进「更多」：电脑端顶栏只留品牌、时钟和一个主操作。鼠标移上去就展开，点击也保留（触屏用）。 -->
            <a-dropdown :trigger="['hover', 'click']" :menu="moreMenu" placement="bottomRight">
              <a-button size="small">{{ $t('topbar.more') }}</a-button>
            </a-dropdown>
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

      <!-- 后台没响应时，必须明确告诉用户发生了什么、下一步该做什么。 -->
      <a-alert
        v-if="diagnostics.serviceState === 'down'"
        type="error"
        show-icon
        banner
        style="border-radius: 0"
      >
        <template #message>
          <strong>{{ $t('alert.backendDown') }}</strong>
          —— {{ diagnostics.guidance }}
        </template>
        <template #action>
          <a-button size="small" :loading="diagnostics.checking" @click="diagnostics.checkHealth()">
            {{ $t('common.recheck') }}
          </a-button>
          <a-button size="small" @click="runtimeLogsOpen = true">
            {{ $t('common.viewRuntimeLogs') }}
          </a-button>
        </template>
      </a-alert>
      <a-alert
        v-else-if="diagnostics.serviceState === 'degraded' && diagnostics.health?.lastError"
        type="warning"
        show-icon
        banner
        style="border-radius: 0"
      >
        <template #message>
          <strong>{{ $t('alert.backendDegraded') }}</strong>
          —— {{ diagnostics.health.lastError.message }}
        </template>
        <template #action>
          <a-button size="small" @click="diagnosticsOpen = true">{{ $t('common.viewDetails') }}</a-button>
        </template>
      </a-alert>

      <main class="page">
        <ErrorBoundary :label="$t('app.mainArea')" @open-diagnostics="diagnosticsOpen = true">
          <div class="layout">
            <section class="column">
              <div class="panel">
                <div class="panel-head">
                  <h2 class="panel-title">
                    {{ $t('task.panelTitle') }}
                    <small>{{ $t('task.panelCount', { count: tasks.tasks.length }) }}</small>
                  </h2>
                  <div class="panel-actions">
                    <a-button size="small" type="primary" @click="openCreate">
                      {{ $t('task.create') }}
                    </a-button>
                    <a-button size="small" type="text" :loading="tasks.loading" @click="refreshAll">
                      {{ $t('common.refresh') }}
                    </a-button>
                  </div>
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
                  @stop="askStop"
                  @start="action($event, 'start')"
                  @remove="openDelete"
                  @reorder="onReorder"
                />
              </div>
            </section>

            <section class="column">
              <LogsPanel @cleanup="cleanupOpen = true" />
            </section>
          </div>
        </ErrorBoundary>
      </main>
    </div>

    <a-modal
      :open="formOpen"
      :title="formTitle"
      width="min(920px, 96vw)"
      :mask-closable="false"
      :style="{ top: '40px' }"
      wrap-class-name="task-form-modal"
      force-render
      @cancel="taskFormRef?.requestClose()"
    >
      <TaskForm ref="taskFormRef" @saved="refreshAll" @close="closeFormPanel" />
      <template #footer>
        <div class="task-form-footer">
          <span class="task-form-footer-hint">{{ taskFormRef?.footerHint }}</span>
          <div class="task-form-footer-actions">
            <a-button @click="taskFormRef?.requestClose()">{{ $t('common.cancel') }}</a-button>
            <a-button
              type="primary"
              :loading="taskFormRef?.submitting"
              @click="taskFormRef?.submit()"
            >
              {{ taskFormRef?.editingId ? $t('taskForm.saveChanges') : $t('taskForm.createTask') }}
            </a-button>
          </div>
        </div>
      </template>
    </a-modal>

    <PauseDialog v-model:open="pauseOpen" :task="pauseTarget" @saved="onPauseSaved" />
    <DeleteTaskDialog v-model:open="deleteOpen" :task="deleteTarget" @deleted="onDeleted" />
    <CleanupLogsDialog v-model:open="cleanupOpen" @done="onCleanupDone" />
    <StatsDialog v-model:open="statsOpen" />
    <CalendarDialog v-model:open="calendarOpen" />
    <DatabaseDialog v-model:open="databaseOpen" />
    <RuntimeLogsDialog v-model:open="runtimeLogsOpen" />
    <DiagnosticsDialog v-model:open="diagnosticsOpen" @open-logs="runtimeLogsOpen = true" />
    <SettingsDialog v-model:open="settingsOpen" @cleanup="cleanupOpen = true" />
    <TestBenchDialog v-model:open="globalTestOpen" ref="testRef" @apply="applyGlobalTest" />

    <ConfirmDialog
      :open="runTarget !== null"
      :title="$t('task.runTitle')"
      :content="runContent"
      :ok-text="$t('task.runOkText')"
      @update:open="runTarget = null"
      @confirm="doRun"
    />

    <ConfirmDialog
      :open="stopTarget !== null"
      :title="$t('task.menuStop')"
      :content="stopContent"
      :ok-text="$t('task.menuStop')"
      danger
      @update:open="stopTarget = null"
      @confirm="doStop"
    />
  </a-config-provider>
</template>

<style scoped>
/* 顶栏的次要入口都收在「更多」下拉里，这里没有额外样式。 */
</style>
