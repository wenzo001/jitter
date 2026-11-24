export interface AppConfig {
  logsPageSize: number
  defaultWindowMinutes: number
  pollIntervalMs: number
  logBodyLimitBytes: number
  requestTimeoutMs: number
  logRetentionDays: number
}

export interface Settings {
  logRetentionDays: number
  logMaxRowsPerTask: number
  skipTlsVerify: boolean
  preventSleepOnAc: boolean
}

export interface SystemInfo {
  name: string
  version: string
  platform: string
  arch: string
  compiled: boolean
  binary_path: string
  install_dir: string
  config_dir: string
  db_path: string
  autostart: boolean
  autostart_path: string
  url: string
  port: number
}

export interface HostEnvironment {
  onAcPower: boolean | null
  localIps: string[]
  preventSleepOnAc: boolean
}

export interface HolidayDay {
  name: string
  /** YYYY-MM-DD */
  date: string
  /** true = 放假；false = 调休上班。 */
  isOffDay: boolean
}

export interface HolidayYearMeta {
  year: number
  /** 法定放假天数。 */
  offDays: number
  /** 调休上班天数（通常落在周末）。 */
  makeupDays: number
  fetchedAt: number
  /** 按日期升序的明细。 */
  days: HolidayDay[]
}

export interface HolidayStatus {
  years: HolidayYearMeta[]
  /** 当年是否有节假日数据：决定「工作日 / 休息日」选项是否可选。 */
  hasCurrentYear: boolean
  refreshed?: number[]
  errors?: string[]
}

export interface BackupEntry {
  name: string
  size: number
  modified_at: number
}

export interface BackupListResponse {
  backups: BackupEntry[]
  backup_dir: string
}

export interface UpdateAsset {
  name: string
  url: string
  size: number
}

export interface UpdateInfo {
  current: string
  latest: string | null
  available: boolean
  notes: string | null
  url: string | null
  published_at: string | null
  asset: UpdateAsset | null
  error: string | null
}

export interface UpdateProgress {
  phase: string
  percent: number
  message: string
  error: string | null
}

export interface TaskMetrics {
  task_id: string
  runs: number
  ok: number
  success_rate: number | null
  avg_duration_ms: number | null
  last_executed_at: number | null
  last_status: number | null
  last_error: string | null
  last_kind: string | null
}

export interface MetricsOverview {
  tasks: number
  active: number
  running: number
  today_runs: number
  today_ok: number
  week_runs: number
  week_ok: number
  success_rate_7d: number | null
  avg_duration_ms_7d: number | null
}

export interface MetricsReport {
  overview: MetricsOverview
  tasks: TaskMetrics[]
  window: number
}

export interface CleanupOption {
  days: number
  label: string
  cutoff: number
  count: number
  bytes: number
}

export interface CleanupStorage {
  db_bytes: number
  wal_bytes: number
  shm_bytes: number
  total_bytes: number
}

export interface CleanupCount {
  count: number
  bytes: number
  oldest: number | null
  newest: number | null
}

export interface CleanupPreview {
  generated_at: number
  total_count: number
  total_bytes: number
  oldest_executed_at: number | null
  newest_executed_at: number | null
  storage: CleanupStorage
  options: CleanupOption[]
  all: CleanupCount
}

export interface CleanupResult {
  deleted: number
  remaining: number
  reclaimed_bytes: number
  storage_before?: CleanupStorage
  storage_after?: CleanupStorage
  vacuum_error?: string | null
}
