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

/** 一个已连接的网络接口。 */
export interface HostNetwork {
  /** 接口名（Windows 是适配器名称，如「WLAN」「以太网」）。 */
  name: string
  /** wifi / ethernet / other。 */
  kind: 'wifi' | 'ethernet' | 'other'
}

export interface HostEnvironment {
  onAcPower: boolean | null
  localIps: string[]
  /** 当前已连接的物理网卡（WiFi / 有线）。 */
  networks: HostNetwork[]
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
  /** 今天（或服务端当前时刻）的归类。 */
  today?: DayInfo
  refreshed?: number[]
  errors?: string[]
}

/** 单日归类：法定节假日 / 调休上班 / 普通周末 / 工作日。 */
export type HolidayDayType = 'holiday' | 'makeup' | 'weekend' | 'workday'

export interface DayInfo {
  /** YYYY-MM-DD */
  date: string
  dayType: HolidayDayType
  /** 是否上班（工作日与调休上班日为 true）。 */
  isWorkday: boolean
  /** 节日名称（法定节假日与调休日有）。 */
  name: string | null
  /** 是否依据节假日数据判定；false 表示该年无数据，只按星期推断。 */
  authoritative: boolean
  /** 1 = 周一 … 7 = 周日。 */
  weekday: number
  /** 星期几（中文）。 */
  weekdayLabel: string
}

export interface HolidayMonthResponse {
  year: number
  month: number
  today: DayInfo
  days: DayInfo[]
}

export interface DatabaseColumn {
  name: string
  decl_type: string
}

export interface DatabaseTable {
  name: string
  columns: DatabaseColumn[]
  row_count: number
}

export interface DatabaseRows {
  table: string
  columns: DatabaseColumn[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
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

/** 后台健康检查结果。 */
export interface HealthInfo {
  ok: boolean
  /** 服务端当前时间戳（毫秒）。 */
  now: number
  version: string
  /** 已运行时长（毫秒）。 */
  uptimeMs: number
  /** 数据库是否可读可写。 */
  dbOk: boolean
  dbPath: string
  /** 运行日志目录。 */
  logDir: string
  /** 最近一次服务端错误。 */
  lastError: { at: number; message: string } | null
}

/** 一个运行日志文件的元信息。 */
export interface LogFileInfo {
  name: string
  size: number
  /** 最后修改时间戳（毫秒）。 */
  modified_at: number
}

/** 运行日志文件列表。 */
export interface LogFilesResponse {
  dir: string
  retentionDays: number
  files: LogFileInfo[]
}

/** 运行日志文件的一段内容。 */
export interface LogFileChunk {
  name: string
  content: string
  /** 本次读取的起始字节偏移。 */
  offset: number
  /** 下一次读取的偏移。 */
  next_offset: number
  /** 文件总字节数。 */
  size: number
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
