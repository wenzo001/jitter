<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupEntry, Settings, UpdateInfo, UpdateProgress } from '@/types/system'
import { getSettings, updateSettings, quitApp, setAutostart } from '@/api/system'
import {
  applyUpdate as applyUpdateApi,
  backupDownloadUrl,
  checkUpdate,
  createBackup,
  deleteBackup,
  getUpdateProgress,
  listBackups,
  restoreBackup,
  uploadBackup,
} from '@/api/backup'
import { useAppStore } from '@/stores/app'
import { useTasksStore } from '@/stores/tasks'
import { useLogsStore } from '@/stores/logs'
import { formatBytes, formatTime } from '@/utils/format'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  cleanup: []
}>()

const app = useAppStore()
const tasks = useTasksStore()
const logs = useLogsStore()

const tab = ref('general')
const settings = ref<Settings | null>(null)
const retention = ref(30)
const settingsBusy = ref(false)
const autostartBusy = ref(false)

const backups = ref<BackupEntry[]>([])
const backupDir = ref('')
const backupBusy = ref(false)
const uploadBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const holidayRefreshing = ref(false)
const holidayErrors = ref<string[]>([])

const updateInfo = ref<UpdateInfo | null>(null)
const updateProgress = ref<UpdateProgress | null>(null)
const updateBusy = ref(false)
const updateChecked = ref(false)
const updateError = ref('')

const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmContent = ref('')
const confirmOkText = ref('确定')
const confirmDanger = ref(true)
const confirmBusy = ref(false)
let confirmAction: (() => Promise<void>) | null = null

const retentionOptions = [0, 7, 14, 30, 60, 90, 180, 365].map((days) => ({
  value: days,
  label: days === 0 ? '不限制（永久保留）' : `最近 ${days} 天`,
}))

const updateSummary = computed(() => {
  const info = updateInfo.value
  if (!info) return ''
  if (info.error && !info.latest) return `检查失败：${info.error}`
  if (!info.latest) return '还没有发布任何版本（仓库里暂无 Release）。'
  if (!info.available) return `当前版本 v${info.current} 已是最新（最新发布 ${info.latest}）。`
  return `发现新版本 ${info.latest}（当前 ${info.current}）${
    info.asset ? `，安装包 ${formatBytes(info.asset.size)}` : ''
  }`
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    updateInfo.value = null
    updateProgress.value = null
    updateChecked.value = false
    updateError.value = ''
    updateBusy.value = false
    holidayErrors.value = []
    tab.value = 'general'
    await Promise.all([app.loadSystem(), app.loadHoliday(), loadSettings(), loadBackups()])
  },
)

async function loadSettings() {
  try {
    const data = await getSettings()
    settings.value = data
    retention.value = Number(data.logRetentionDays ?? 0)
  } catch {
    settings.value = null
  }
}

async function loadBackups() {
  try {
    const data = await listBackups()
    backups.value = data.backups ?? []
    backupDir.value = data.backup_dir ?? ''
  } catch (err) {
    backupDir.value = err instanceof Error ? `备份列表读取失败：${err.message}` : '备份列表读取失败'
    backups.value = []
  }
}

/* ---------------- 常规设置 ---------------- */

async function saveRetention() {
  settingsBusy.value = true
  try {
    await updateSettings({ logRetentionDays: retention.value })
    await app.loadConfig()
    app.setStatus(
      retention.value > 0 ? `已设置保留最近 ${retention.value} 天的日志` : '已取消日志保留期限',
    )
    await tasks.load()
    await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
    await loadSettings()
  } catch (err) {
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  } finally {
    settingsBusy.value = false
  }
}

async function toggleSetting(key: 'skipTlsVerify' | 'preventSleepOnAc', value: boolean) {
  const previous = settings.value?.[key]
  if (settings.value) settings.value[key] = value
  try {
    const data = await updateSettings({ [key]: value })
    settings.value = data
    app.setStatus(
      key === 'skipTlsVerify'
        ? value
          ? '已开启：默认跳过 TLS 证书校验'
          : '已关闭默认跳过（仅 -k 生效）'
        : value
          ? '已开启：接通电源时防止系统休眠'
          : '已关闭：恢复系统默认休眠策略',
    )
  } catch (err) {
    if (settings.value) settings.value[key] = previous ?? !value
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  }
}

async function toggleAutostart(value: boolean) {
  autostartBusy.value = true
  try {
    const data = await setAutostart(value)
    await app.loadSystem()
    app.setStatus(data.autostart ? '已设置开机自启' : '已取消开机自启')
  } catch (err) {
    app.setStatus(err instanceof Error ? err.message : String(err), true)
    await app.loadSystem()
  } finally {
    autostartBusy.value = false
  }
}

/* ---------------- 节假日数据 ---------------- */

async function refreshHoliday() {
  holidayRefreshing.value = true
  holidayErrors.value = []
  try {
    const status = await app.refreshHoliday()
    if (status?.errors?.length) holidayErrors.value = status.errors
    else app.setStatus(status?.refreshed?.length ? '节假日数据已更新' : '节假日数据没有变化')
  } finally {
    holidayRefreshing.value = false
  }
}

/* ---------------- 备份 ---------------- */

function ask(title: string, content: string, okText: string, danger: boolean, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmContent.value = content
  confirmOkText.value = okText
  confirmDanger.value = danger
  confirmAction = action
  confirmOpen.value = true
}

async function runConfirm() {
  const action = confirmAction
  if (!action) return
  confirmBusy.value = true
  try {
    await action()
    confirmOpen.value = false
  } catch (err) {
    confirmBusy.value = false
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  } finally {
    confirmBusy.value = false
    confirmAction = null
  }
}

async function createSnapshot() {
  backupBusy.value = true
  try {
    await createBackup()
    app.setStatus('备份已创建')
    await loadBackups()
  } catch (err) {
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  } finally {
    backupBusy.value = false
  }
}

function downloadBackup(name: string) {
  window.open(backupDownloadUrl(name), '_blank')
}

function askRestore(name: string) {
  ask(
    '恢复备份',
    `确定用备份「${name}」恢复吗？当前数据会被覆盖（恢复前会自动另存一份当前状态的安全备份）。`,
    '恢复',
    true,
    async () => {
      await restoreBackup(name)
      app.setStatus('已恢复备份，正在刷新数据')
      await Promise.all([tasks.load(), app.loadConfig()])
      await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
      await loadBackups()
    },
  )
}

function askDeleteBackup(name: string) {
  ask('删除备份', `删除备份「${name}」？此操作不可恢复。`, '删除', true, async () => {
    await deleteBackup(name)
    app.setStatus(`已删除备份 ${name}`)
    await loadBackups()
  })
}

function pickFile() {
  if (fileInput.value) {
    fileInput.value.value = ''
    fileInput.value.click()
  }
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.name.endsWith('.db')) {
    app.setStatus('请选择 .db 备份文件', true)
    return
  }
  uploadBusy.value = true
  try {
    await uploadBackup(file)
    app.setStatus(`已导入备份 ${file.name}，可在列表里点「恢复」`)
    await loadBackups()
  } catch (err) {
    app.setStatus(err instanceof Error ? err.message : String(err), true)
  } finally {
    uploadBusy.value = false
  }
}

/* ---------------- 更新 ---------------- */

async function check() {
  updateChecked.value = true
  updateError.value = ''
  updateBusy.value = true
  updateInfo.value = null
  try {
    updateInfo.value = await checkUpdate()
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : String(err)
  } finally {
    updateBusy.value = false
  }
}

const pendingUpdate = computed(() => Boolean(updateInfo.value?.available && updateInfo.value.latest))

async function waitForServerBack(previousVersion: string): Promise<string | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 10 ? 1000 : 2000))
    updateProgress.value = {
      phase: 'wait',
      percent: 0,
      message: `等待新版本启动…（已等 ${attempt + 1} 秒）`,
      error: null,
    }
    try {
      const response = await fetch('/api/system', { cache: 'no-store' })
      if (!response.ok) continue
      const info = (await response.json()) as { version?: string }
      if (info?.version && !app.sameVersion(info.version, previousVersion)) return info.version
      if (attempt >= 9) return info?.version ?? null
    } catch {
      // 服务重启中：继续等
    }
  }
  return null
}

async function applyUpdate() {
  if (updateBusy.value) return
  const previous = app.system?.version ?? '?'
  const expected = updateInfo.value?.latest ?? null
  updateBusy.value = true
  updateError.value = ''
  updateProgress.value = { phase: 'prepare', percent: 0, message: '正在准备…', error: null }

  try {
    const health = await fetch('/api/health', { cache: 'no-store' })
    if (!health.ok) throw new Error('无法连接 Jitter 服务')
  } catch {
    updateBusy.value = false
    updateError.value = '无法连接 Jitter 服务。请确认程序仍在运行，然后点「重试」。'
    return
  }

  app.writePending({ from: previous, expected, at: Date.now() })

  const poller = window.setInterval(async () => {
    try {
      const progress = await getUpdateProgress()
      updateProgress.value = progress
    } catch {
      // 重启中请求失败是预期行为
    }
  }, 500)

  let result: { ok: boolean; message: string } | null = null
  let requestError: unknown = null
  try {
    result = await applyUpdateApi()
  } catch (err) {
    requestError = err
  } finally {
    window.clearInterval(poller)
  }

  if (requestError) {
    updateProgress.value = { phase: 'wait', percent: 0, message: '升级请求中断，正在等待服务恢复…', error: null }
    const back = await waitForServerBack(previous)
    if (back && (!expected || app.sameVersion(back, expected))) {
      await finishUpgrade(back, previous)
    } else if (back) {
      updateError.value = `服务已恢复，但版本仍是 ${back}（期望 ${expected ?? '新版本'}）。可能替换未生效，可点「重试」。`
      updateBusy.value = false
    } else {
      updateError.value = `升级失败：${(requestError as Error)?.message ?? String(requestError)}。若托盘图标仍在，可点「重试」；否则请手动重新打开程序。`
      updateBusy.value = false
    }
    return
  }

  if (!result?.ok) {
    const message = result?.message ?? '未知原因'
    if (message.includes('最新版本')) {
      app.writePending(null)
      updateProgress.value = { phase: 'idle', percent: 100, message, error: null }
      updateBusy.value = false
      return
    }
    updateError.value = `升级失败：${message}。当前版本仍可正常使用，可点「重试」。`
    updateBusy.value = false
    return
  }

  updateProgress.value = { phase: 'restart', percent: 100, message: '升级包已就位，正在重启…', error: null }
  const back = await waitForServerBack(previous)
  if (!back) {
    updateError.value = '等待 60 秒仍未恢复。请检查托盘图标是否在运行、端口是否被占用；可点「重试」。'
    updateBusy.value = false
    return
  }
  if (expected && !app.sameVersion(back, expected)) {
    updateError.value = `服务已恢复，但版本仍是 ${back}（期望 ${expected}）。可能替换未生效，可点「重试」或手动重新下载安装包。`
    updateBusy.value = false
    return
  }
  await finishUpgrade(back, previous)
}

async function finishUpgrade(newVersion: string, previousVersion: string) {
  updateProgress.value = {
    phase: 'success',
    percent: 100,
    message: `升级成功：v${previousVersion} → v${newVersion}，页面数据已刷新。`,
    error: null,
  }
  app.writePending({ from: previousVersion, expected: newVersion, at: Date.now() })
  app.banner = {
    kind: 'success',
    text: `升级成功：已从 v${previousVersion} 升级到 v${newVersion}，页面数据已同步。`,
  }
  app.setStatus(`已升级到 v${newVersion}`)
  updateBusy.value = false
  await app.loadSystem()
  await tasks.load()
  await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
}

function askQuit() {
  ask('退出 Jitter', '退出后 Jitter 会停止运行，页面也会断开。确定退出吗？', '退出', true, async () => {
    await quitApp()
    app.setStatus('正在退出…')
  })
}

function openCleanup() {
  emit('cleanup')
  emit('update:open', false)
}
</script>

<template>
  <a-modal
    :open="open"
    title="设置"
    width="min(820px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="general" tab="常规">
        <div class="settings-section">
          <div class="settings-title">日志保留</div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <a-select v-model:value="retention" :options="retentionOptions" style="width: 220px" />
            <a-button type="primary" size="small" :loading="settingsBusy" @click="saveRetention">
              保存
            </a-button>
            <a-button size="small" @click="openCleanup">立即清理日志</a-button>
          </div>
          <p class="field-hint" style="margin-top: 6px">
            超出保留期的日志不查询、不渲染，并由后台巡检删除（每轮最多 5000 条）。
          </p>
        </div>

        <div class="settings-section">
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">默认跳过 TLS 证书校验</div>
              <div class="muted" style="font-size: 12px">对自签名证书的内网接口很有用</div>
            </div>
            <a-switch
              :checked="settings?.skipTlsVerify !== false"
              :loading="settingsBusy"
              @change="toggleSetting('skipTlsVerify', $event as boolean)"
            />
          </div>
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">接通电源时防止系统休眠</div>
              <div class="muted" style="font-size: 12px">只在本机接通 AC 电源时抑制休眠</div>
            </div>
            <a-switch
              :checked="settings?.preventSleepOnAc === true"
              @change="toggleSetting('preventSleepOnAc', $event as boolean)"
            />
          </div>
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">开机自启</div>
              <div class="muted" style="font-size: 12px">
                {{ app.system?.compiled ? app.system?.autostart_path : '仅对安装后的程序有效，当前从源码运行' }}
              </div>
            </div>
            <a-switch
              :checked="Boolean(app.system?.autostart)"
              :disabled="!app.system?.compiled"
              :loading="autostartBusy"
              @change="toggleAutostart($event as boolean)"
            />
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-title">节假日数据</div>
          <p class="field-hint" style="margin-top: 0">
            来自 holiday-cn（中国法定节假日，含调休上班日），供「仅工作日 / 仅休息日」执行条件使用。
            每次启动静默更新，每月 1 号自动刷新；拉取范围是去年、今年、明年。
          </p>
          <div v-if="app.holiday?.years?.length" class="holiday-years">
            <div v-for="entry in app.holiday.years" :key="entry.year" class="holiday-year-row">
              <span class="holiday-year">{{ entry.year }} 年</span>
              <span class="muted">{{ entry.dayCount }} 天 · 更新于 {{ formatTime(entry.fetchedAt) }}</span>
              <a-tag v-if="entry.year === new Date().getFullYear()" color="blue">今年</a-tag>
            </div>
          </div>
          <div v-else class="muted" style="font-size: 12.5px; padding: 6px 0">
            还没有节假日数据：任务里的「仅工作日 / 仅休息日」条件会被跳过。点下面按钮拉取。
          </div>
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px">
            <a-button size="small" :loading="holidayRefreshing" @click="refreshHoliday">
              立即拉取（去年 / 今年 / 明年）
            </a-button>
            <a-tag :color="app.holiday?.hasCurrentYear ? 'success' : 'warning'">
              {{ app.holiday?.hasCurrentYear ? '今年数据可用' : '今年数据缺失' }}
            </a-tag>
          </div>
          <a-alert
            v-for="(error, index) in holidayErrors"
            :key="index"
            type="warning"
            show-icon
            :message="error"
            style="margin-top: 8px"
          />
        </div>

        <div class="settings-section">
          <div class="settings-title">运行信息</div>
          <div class="settings-line">
            <span class="label">版本</span>
            <span class="value">{{ app.system ? `v${app.system.version}` : '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">运行模式</span>
            <span class="value">{{ app.system?.compiled ? '已安装的单文件程序' : '开发模式（从源码运行）' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">访问地址</span>
            <span class="value">{{ app.system?.url ?? '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">安装目录</span>
            <span class="value">{{ app.system?.install_dir ?? app.system?.binary_path ?? '源码目录' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">数据文件</span>
            <span class="value">{{ app.system?.db_path ?? '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">开机自启文件</span>
            <span class="value">{{ app.system?.autostart_path ?? '—' }}</span>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane key="backup" tab="备份">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px">
          <a-button type="primary" size="small" :loading="backupBusy" @click="createSnapshot">
            新建备份
          </a-button>
          <a-button size="small" :loading="uploadBusy" @click="pickFile">导入 .db 备份</a-button>
          <input ref="fileInput" type="file" accept=".db" style="display: none" @change="onFile" />
          <span class="muted" style="font-size: 12px">{{ backupDir }}</span>
        </div>
        <p class="field-hint">备份包含任务、日志和设置。恢复前会自动另存一份当前状态。</p>

        <div v-if="backups.length === 0" class="empty" style="padding: 20px 0">
          还没有备份。点「新建备份」生成一份完整快照。
        </div>
        <div v-else>
          <div v-for="entry in backups" :key="entry.name" class="backup-item">
            <div style="min-width: 0">
              <div class="backup-name">{{ entry.name }}</div>
              <div class="backup-meta">
                {{ formatBytes(entry.size) }} · {{ formatTime(entry.modified_at) }}
              </div>
            </div>
            <div class="backup-actions">
              <a-button size="small" @click="downloadBackup(entry.name)">下载</a-button>
              <a-button size="small" @click="askRestore(entry.name)">恢复</a-button>
              <a-button size="small" danger @click="askDeleteBackup(entry.name)">删除</a-button>
            </div>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane key="update" tab="更新">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <a-button size="small" :loading="updateBusy && !pendingUpdate" @click="check">检查更新</a-button>
          <a-button
            v-if="pendingUpdate"
            type="primary"
            size="small"
            :loading="updateBusy"
            @click="applyUpdate"
          >
            下载并安装 {{ updateInfo?.latest }}
          </a-button>
        </div>

        <div v-if="updateChecked" style="margin-top: 12px">
          <a-alert
            v-if="updateError"
            type="error"
            :message="updateError"
            show-icon
            style="margin-bottom: 8px"
          />
          <a-alert
            v-else-if="updateSummary"
            :type="updateInfo?.available ? 'info' : 'success'"
            :message="updateSummary"
            show-icon
          />
          <pre
            v-if="updateInfo?.available && updateInfo.notes"
            style="
              margin-top: 10px;
              padding: 10px;
              background: #f8fafc;
              border: 1px solid var(--border);
              border-radius: 8px;
              white-space: pre-wrap;
              font-size: 12px;
              max-height: 220px;
              overflow: auto;
            "
            >{{ updateInfo.notes }}</pre
          >
          <a-alert
            v-if="updateProgress?.message"
            type="info"
            :message="updateProgress.message"
            show-icon
            style="margin-top: 10px"
          />
        </div>
        <p v-else class="field-hint">检查 GitHub Release 是否有新版本。升级会下载安装包并自动重启。</p>
      </a-tab-pane>

      <a-tab-pane key="danger" tab="退出">
        <a-alert
          type="warning"
          show-icon
          message="退出后所有定时任务停止，页面也会断开。下次启动会自动恢复调度。"
        />
        <div style="display: flex; justify-content: flex-end; margin-top: 16px">
          <a-button danger @click="askQuit">退出 Jitter</a-button>
        </div>
      </a-tab-pane>
    </a-tabs>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :content="confirmContent"
      :ok-text="confirmOkText"
      :danger="confirmDanger"
      :loading="confirmBusy"
      @confirm="runConfirm"
    />
  </a-modal>
</template>
