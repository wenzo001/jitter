<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BackupEntry, HolidayDay, HolidayYearMeta, Settings, UpdateInfo, UpdateProgress } from '@/types/system'
import { getSettings, updateSettings, quitApp, setAutostart } from '@/api/system'
import { BACKEND_MARKERS } from '@/api/client'
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

const { t } = useI18n()

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
const holidayDetail = ref<HolidayYearMeta | null>(null)

const updateInfo = ref<UpdateInfo | null>(null)
const updateProgress = ref<UpdateProgress | null>(null)
const updateBusy = ref(false)
const updateChecked = ref(false)
const updateError = ref('')

const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmContent = ref('')
const confirmOkText = ref(t('common.ok'))
const confirmDanger = ref(true)
const confirmBusy = ref(false)
let confirmAction: (() => Promise<void>) | null = null

const retentionOptions = computed(() =>
  [0, 7, 14, 30, 60, 90, 180, 365].map((days) => ({
    value: days,
    label:
      days === 0
        ? t('settings.retentionForever')
        : t('settings.retentionDays', { days }),
  })),
)

const updateSummary = computed(() => {
  const info = updateInfo.value
  if (!info) return ''
  if (info.error && !info.latest) return t('update.summaryFailed', { error: info.error })
  if (!info.latest) return t('update.summaryNoRelease')
  if (!info.available) {
    return t('update.summaryUpToDate', { current: info.current, latest: info.latest })
  }
  return info.asset
    ? t('update.summaryNewAsset', {
        latest: info.latest,
        current: info.current,
        size: formatBytes(info.asset.size),
      })
    : t('update.summaryNew', { latest: info.latest, current: info.current })
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
    backupDir.value =
      err instanceof Error
        ? t('backup.listFailed', { error: err.message })
        : t('backup.listFailedSimple')
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
      retention.value > 0
        ? t('settings.statusRetentionSet', { days: retention.value })
        : t('settings.statusRetentionCleared'),
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
          ? t('settings.statusSkipTlsOn')
          : t('settings.statusSkipTlsOff')
        : value
          ? t('settings.statusSleepOn')
          : t('settings.statusSleepOff'),
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
    app.setStatus(data.autostart ? t('settings.statusAutostartOn') : t('settings.statusAutostartOff'))
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
    else
      app.setStatus(
        status?.refreshed?.length
          ? t('settings.statusHolidayUpdated')
          : t('settings.statusHolidayUnchanged'),
      )
  } finally {
    holidayRefreshing.value = false
  }
}

const WEEKDAY_LABELS = [
  'weekday.sun',
  'weekday.mon',
  'weekday.tue',
  'weekday.wed',
  'weekday.thu',
  'weekday.fri',
  'weekday.sat',
] as const

function parseLocalDate(text: string): Date | null {
  const [year, month, day] = text.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

/** `YYYY-MM-DD` → 周几（数据都是本地日期，用字符串解析避免时区偏差）。 */
function weekdayOf(date: string): string {
  const parsed = parseLocalDate(date)
  return parsed ? t(WEEKDAY_LABELS[parsed.getDay()]) : ''
}

function nextDayOf(date: string): string | null {
  const parsed = parseLocalDate(date)
  if (!parsed) return null
  parsed.setDate(parsed.getDate() + 1)
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${parsed.getFullYear()}-${month}-${day}`
}

function offDaysOf(year: HolidayYearMeta): HolidayDay[] {
  return year.days.filter((entry) => entry.isOffDay)
}

function makeupDaysOf(year: HolidayYearMeta): HolidayDay[] {
  return year.days.filter((entry) => !entry.isOffDay)
}

interface HolidayRange {
  name: string
  start: string
  end: string
  count: number
}

/** 把连续的放假日期按节日合并成区间，例如「春节 02-15~02-21（7 天）」。 */
function offDayRanges(year: HolidayYearMeta): HolidayRange[] {
  const ranges: HolidayRange[] = []
  for (const day of offDaysOf(year)) {
    const last = ranges[ranges.length - 1]
    if (last && last.name === day.name && nextDayOf(last.end) === day.date) {
      last.end = day.date
      last.count += 1
    } else {
      ranges.push({ name: day.name, start: day.date, end: day.date, count: 1 })
    }
  }
  return ranges
}

function rangeLabel(range: HolidayRange): string {
  const start = `${range.start.slice(5)} ${weekdayOf(range.start)}`
  if (range.start === range.end) return start
  return `${start} ~ ${range.end.slice(5)} ${weekdayOf(range.end)}`
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
    app.setStatus(t('backup.statusCreated'))
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
    t('backup.restoreTitle'),
    t('backup.restoreContent', { name }),
    t('backup.restoreOk'),
    true,
    async () => {
      await restoreBackup(name)
      app.setStatus(t('backup.statusRestored'))
      await Promise.all([tasks.load(), app.loadConfig()])
      await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
      await loadBackups()
    },
  )
}

function askDeleteBackup(name: string) {
  ask(t('backup.removeTitle'), t('backup.removeContent', { name }), t('backup.removeOk'), true, async () => {
    await deleteBackup(name)
    app.setStatus(t('backup.statusRemoved', { name }))
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
    app.setStatus(t('backup.statusBadFile'), true)
    return
  }
  uploadBusy.value = true
  try {
    await uploadBackup(file)
    app.setStatus(t('backup.statusImported', { name: file.name }))
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
      message: t('update.progressWaiting', { seconds: attempt + 1 }),
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
  updateProgress.value = { phase: 'prepare', percent: 0, message: t('update.progressPreparing'), error: null }

  try {
    const health = await fetch('/api/health', { cache: 'no-store' })
    if (!health.ok) throw new Error(t('update.errorNoService'))
  } catch {
    updateBusy.value = false
    updateError.value = t('update.errorNoServiceDetail')
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
    updateProgress.value = {
      phase: 'wait',
      percent: 0,
      message: t('update.progressInterrupted'),
      error: null,
    }
    const back = await waitForServerBack(previous)
    if (back && (!expected || app.sameVersion(back, expected))) {
      await finishUpgrade(back, previous)
    } else if (back) {
      updateError.value = t('update.errorVersionMismatch', {
        current: back,
        expected: expected ?? t('update.newVersion'),
      })
      updateBusy.value = false
    } else {
      updateError.value = t('update.errorUpgradeFailed', {
        error: (requestError as Error)?.message ?? String(requestError),
      })
      updateBusy.value = false
    }
    return
  }

  if (!result?.ok) {
    const message = result?.message ?? t('update.errorUnknownReason')
    if (message.includes(BACKEND_MARKERS.alreadyLatest)) {
      app.writePending(null)
      updateProgress.value = { phase: 'idle', percent: 100, message, error: null }
      updateBusy.value = false
      return
    }
    updateError.value = t('update.errorUpgradeFailedUsable', { error: message })
    updateBusy.value = false
    return
  }

  updateProgress.value = {
    phase: 'restart',
    percent: 100,
    message: t('update.progressRestarting'),
    error: null,
  }
  const back = await waitForServerBack(previous)
  if (!back) {
    updateError.value = t('update.errorTimeout')
    updateBusy.value = false
    return
  }
  if (expected && !app.sameVersion(back, expected)) {
    updateError.value = t('update.errorVersionMismatchRetry', { current: back, expected })
    updateBusy.value = false
    return
  }
  await finishUpgrade(back, previous)
}

async function finishUpgrade(newVersion: string, previousVersion: string) {
  updateProgress.value = {
    phase: 'success',
    percent: 100,
    message: t('update.progressSuccess', { from: `v${previousVersion}`, to: `v${newVersion}` }),
    error: null,
  }
  app.writePending({ from: previousVersion, expected: newVersion, at: Date.now() })
  app.setBanner('success', 'app.upgradeSuccessBanner', {
    from: `v${previousVersion}`,
    to: `v${newVersion}`,
  })
  app.setStatus(t('update.statusUpgraded', { version: `v${newVersion}` }))
  updateBusy.value = false
  await app.loadSystem()
  await tasks.load()
  await logs.load(tasks.selectedId, { reset: true, pageSize: app.config.logsPageSize })
}

function askQuit() {
  ask(t('settings.quitTitle'), t('settings.quitContent'), t('settings.quitOk'), true, async () => {
    await quitApp()
    app.setStatus(t('settings.statusQuitting'))
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
    :title="$t('settings.title')"
    width="min(820px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="general" :tab="$t('settings.tabGeneral')">
        <div class="settings-section">
          <div class="settings-title">{{ $t('settings.logRetention') }}</div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <a-select v-model:value="retention" :options="retentionOptions" style="width: 220px" />
            <a-button type="primary" size="small" :loading="settingsBusy" @click="saveRetention">
              {{ $t('common.save') }}
            </a-button>
            <a-button size="small" @click="openCleanup">{{ $t('settings.cleanupAll') }}</a-button>
          </div>
          <p class="field-hint" style="margin-top: 6px">
            {{ $t('settings.retentionHint') }}
          </p>
        </div>

        <div class="settings-section">
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">{{ $t('settings.skipTls') }}</div>
              <div class="muted" style="font-size: 12px">{{ $t('settings.skipTlsHint') }}</div>
            </div>
            <a-switch
              :checked="settings?.skipTlsVerify !== false"
              :loading="settingsBusy"
              @change="toggleSetting('skipTlsVerify', $event as boolean)"
            />
          </div>
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">{{ $t('settings.preventSleep') }}</div>
              <div class="muted" style="font-size: 12px">{{ $t('settings.preventSleepHint') }}</div>
            </div>
            <a-switch
              :checked="settings?.preventSleepOnAc === true"
              @change="toggleSetting('preventSleepOnAc', $event as boolean)"
            />
          </div>
          <div class="settings-line">
            <div>
              <div class="settings-title" style="margin: 0">{{ $t('settings.autostart') }}</div>
              <div class="muted" style="font-size: 12px">
                {{
                  app.system?.compiled
                    ? app.system?.autostart_path
                    : $t('settings.autostartHintCompiled')
                }}
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
          <div class="settings-title">{{ $t('settings.holidayTitle') }}</div>
          <p class="field-hint" style="margin-top: 0">
            {{ $t('settings.holidayHint') }}
          </p>
          <div v-if="app.holiday?.years?.length" class="holiday-years">
            <button
              v-for="entry in app.holiday.years"
              :key="entry.year"
              type="button"
              class="holiday-year-row"
              :title="$t('settings.holidayYearTitle', { year: entry.year })"
              @click="holidayDetail = entry"
            >
              <span class="holiday-year">{{ $t('settings.holidayYearLabel', { year: entry.year }) }}</span>
              <span class="muted">
                {{
                  $t('settings.holidayYearSummary', {
                    offDays: entry.offDays,
                    makeupDays: entry.makeupDays,
                    time: formatTime(entry.fetchedAt),
                  })
                }}
              </span>
              <a-tag v-if="entry.year === new Date().getFullYear()" color="blue">
                {{ $t('settings.holidayThisYear') }}
              </a-tag>
              <span class="holiday-more">{{ $t('settings.holidayMore') }}</span>
            </button>
          </div>
          <div v-else class="muted" style="font-size: 12.5px; padding: 6px 0">
            {{ $t('settings.holidayEmpty') }}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px">
            <a-button size="small" :loading="holidayRefreshing" @click="refreshHoliday">
              {{ $t('settings.holidayFetch') }}
            </a-button>
            <a-tag :color="app.holiday?.hasCurrentYear ? 'success' : 'warning'">
              {{
                app.holiday?.hasCurrentYear
                  ? $t('settings.holidayAvailable')
                  : $t('settings.holidayMissing')
              }}
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
          <div class="settings-title">{{ $t('settings.runtimeTitle') }}</div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.labelVersion') }}</span>
            <span class="value">{{ app.system ? `v${app.system.version}` : '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.labelMode') }}</span>
            <span class="value">
              {{ app.system?.compiled ? $t('settings.modeCompiled') : $t('settings.modeDev') }}
            </span>
          </div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.labelUrl') }}</span>
            <span class="value">{{ app.system?.url ?? '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.labelInstallDir') }}</span>
            <span class="value">
              {{ app.system?.install_dir ?? app.system?.binary_path ?? $t('settings.sourceDir') }}
            </span>
          </div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.labelDataFile') }}</span>
            <span class="value">{{ app.system?.db_path ?? '—' }}</span>
          </div>
          <div class="settings-line">
            <span class="label">{{ $t('settings.autostartPath') }}</span>
            <span class="value">{{ app.system?.autostart_path ?? '—' }}</span>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane key="backup" :tab="$t('settings.tabBackup')">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px">
          <a-button type="primary" size="small" :loading="backupBusy" @click="createSnapshot">
            {{ $t('backup.create') }}
          </a-button>
          <a-button size="small" :loading="uploadBusy" @click="pickFile">
            {{ $t('backup.import') }}
          </a-button>
          <input ref="fileInput" type="file" accept=".db" style="display: none" @change="onFile" />
          <span class="muted" style="font-size: 12px">{{ backupDir }}</span>
        </div>
        <p class="field-hint">{{ $t('backup.hint') }}</p>

        <div v-if="backups.length === 0" class="empty" style="padding: 20px 0">
          {{ $t('backup.empty') }}
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
              <a-button size="small" @click="downloadBackup(entry.name)">
                {{ $t('backup.download') }}
              </a-button>
              <a-button size="small" @click="askRestore(entry.name)">{{ $t('backup.restore') }}</a-button>
              <a-button size="small" danger @click="askDeleteBackup(entry.name)">
                {{ $t('backup.remove') }}
              </a-button>
            </div>
          </div>
        </div>
      </a-tab-pane>

      <a-tab-pane key="update" :tab="$t('settings.tabUpdate')">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
          <a-button size="small" :loading="updateBusy && !pendingUpdate" @click="check">
            {{ $t('update.check') }}
          </a-button>
          <a-button
            v-if="pendingUpdate"
            type="primary"
            size="small"
            :loading="updateBusy"
            @click="applyUpdate"
          >
            {{ $t('update.downloadInstall', { version: updateInfo?.latest }) }}
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
        <p v-else class="field-hint">{{ $t('update.hint') }}</p>
      </a-tab-pane>

      <a-tab-pane key="danger" :tab="$t('settings.tabQuit')">
        <a-alert
          type="warning"
          show-icon
          :message="$t('settings.quitWarning')"
        />
        <div style="display: flex; justify-content: flex-end; margin-top: 16px">
          <a-button danger @click="askQuit">{{ $t('settings.quitTitle') }}</a-button>
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

  <a-modal
    :open="Boolean(holidayDetail)"
    :title="holidayDetail ? $t('settings.holidayDetailTitle', { year: holidayDetail.year }) : ''"
    width="min(520px, 94vw)"
    :footer="null"
    @update:open="holidayDetail = null"
  >
    <template v-if="holidayDetail">
      <div class="holiday-detail-summary">
        <span>
          {{ $t('settings.holidayOffDaysBefore') }}<strong>{{ offDaysOf(holidayDetail).length }}</strong
          >{{ $t('settings.holidayOffDaysAfter') }}
        </span>
        <span>
          {{ $t('settings.holidayMakeupDaysBefore') }}<strong>{{ makeupDaysOf(holidayDetail).length }}</strong
          >{{ $t('settings.holidayMakeupDaysAfter') }}
        </span>
      </div>

      <div class="holiday-detail-block">
        <div class="holiday-detail-title">{{ $t('settings.holidayOffTitle') }}</div>
        <div
          v-for="range in offDayRanges(holidayDetail)"
          :key="`${range.name}-${range.start}`"
          class="holiday-detail-row"
        >
          <span class="holiday-detail-date">{{ rangeLabel(range) }}</span>
          <span class="muted">
            {{ $t('settings.holidayRangeMeta', { name: range.name, count: range.count }) }}
          </span>
        </div>
      </div>

      <div class="holiday-detail-block">
        <div class="holiday-detail-title">{{ $t('settings.holidayMakeupTitle') }}</div>
        <div v-if="!makeupDaysOf(holidayDetail).length" class="muted" style="font-size: 12.5px">
          {{ $t('settings.holidayNoMakeup') }}
        </div>
        <div v-for="day in makeupDaysOf(holidayDetail)" :key="day.date" class="holiday-detail-row">
          <span class="holiday-detail-date">{{ day.date }} {{ weekdayOf(day.date) }}</span>
          <span class="muted">
            {{
              day.name
                ? $t('settings.holidayMakeupName', { name: day.name })
                : $t('settings.holidayMakeupTitle')
            }}
          </span>
        </div>
      </div>

      <p class="field-hint" style="margin: 12px 0 0">
        {{ $t('settings.holidayDetailHint') }}
      </p>
    </template>
  </a-modal>
</template>
