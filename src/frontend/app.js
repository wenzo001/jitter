const els = {
  statusLine: document.getElementById("status-line"),
  taskList: document.getElementById("task-list"),
  tasksEmpty: document.getElementById("tasks-empty"),
  form: document.getElementById("create-form"),
  formTitle: document.getElementById("form-title"),
  cancelEdit: document.getElementById("cancel-edit"),
  editHint: document.getElementById("edit-hint"),
  name: document.getElementById("name"),
  windowStart: document.getElementById("window-start"),
  windowEnd: document.getElementById("window-end"),
  dailyRangeFields: document.getElementById("daily-range-fields"),
  dailyExactField: document.getElementById("daily-exact-field"),
  dailyJitterField: document.getElementById("daily-jitter-field"),
  dailyHint: document.getElementById("daily-hint"),
  exactTime: document.getElementById("exact-time"),
  jitterMinutes: document.getElementById("jitter-minutes"),
  metricsStrip: document.getElementById("metrics-strip"),
  openMetrics: document.getElementById("open-metrics"),
  metricsClose: document.getElementById("metrics-close"),
  metricsDialog: document.getElementById("metrics-dialog"),
  metricsOverview: document.getElementById("metrics-overview"),
  metricsTasks: document.getElementById("metrics-tasks"),
  metricsEmpty: document.getElementById("metrics-empty"),
  scheduleDaily: document.getElementById("schedule-daily"),
  scheduleInterval: document.getElementById("schedule-interval"),
  intervalValue: document.getElementById("interval-value"),
  intervalUnit: document.getElementById("interval-unit"),
  intervalJitter: document.getElementById("interval-jitter"),
  intervalStart: document.getElementById("interval-start"),
  schedulePreview: document.getElementById("schedule-preview"),
  schedulePreviewList: document.getElementById("schedule-preview-list"),
  schedulePreviewNote: document.getElementById("schedule-preview-note"),
  curl: document.getElementById("curl"),
  curlWrap: document.getElementById("curl-wrap"),
  structuredWrap: document.getElementById("structured-wrap"),
  url: document.getElementById("url"),
  method: document.getElementById("method"),
  headers: document.getElementById("headers"),
  body: document.getElementById("body"),
  precheckEnabled: document.getElementById("precheck-enabled"),
  precheckFields: document.getElementById("precheck-fields"),
  precheckWeekdays: document.getElementById("precheck-weekdays"),
  precheckTimeStart: document.getElementById("precheck-time-start"),
  precheckTimeEnd: document.getElementById("precheck-time-end"),
  precheckCurl: document.getElementById("precheck-curl"),
  precheckStatus: document.getElementById("precheck-status"),
  precheckExpr: document.getElementById("precheck-expr"),
  notifyEnabled: document.getElementById("notify-enabled"),
  notifyFields: document.getElementById("notify-fields"),
  notifyCurl: document.getElementById("notify-curl"),
  expectStatus: document.getElementById("expect-status"),
  expectBody: document.getElementById("expect-body"),
  expectExpr: document.getElementById("expect-expr"),
  formError: document.getElementById("form-error"),
  submit: document.getElementById("submit"),
  logsTitle: document.getElementById("logs-title"),
  logsTaskMeta: document.getElementById("logs-task-meta"),
  logList: document.getElementById("log-list"),
  logsEmpty: document.getElementById("logs-empty"),
  loadMore: document.getElementById("load-more"),
  logRenderHint: document.getElementById("log-render-hint"),
  logLimitNote: document.getElementById("log-limit-note"),
  retentionDays: document.getElementById("retention-days"),
  retentionSave: document.getElementById("retention-save"),
  retentionNote: document.getElementById("retention-note"),
  retentionDays2: document.getElementById("retention-days-2"),
  retentionSave2: document.getElementById("retention-save-2"),
  retentionNote2: document.getElementById("retention-note-2"),
  openSettings: document.getElementById("open-settings"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsClose: document.getElementById("settings-close"),
  swVersion: document.getElementById("sw-version"),
  swMode: document.getElementById("sw-mode"),
  swUrl: document.getElementById("sw-url"),
  swInstall: document.getElementById("sw-install"),
  swData: document.getElementById("sw-data"),
  swAutostart: document.getElementById("sw-autostart"),
  swAutostartHint: document.getElementById("sw-autostart-hint"),
  swCheckUpdate: document.getElementById("sw-check-update"),
  swQuit: document.getElementById("sw-quit"),
  swUpdate: document.getElementById("sw-update"),
  swUpdateSummary: document.getElementById("sw-update-summary"),
  swUpdateNotes: document.getElementById("sw-update-notes"),
  swUpdateProgress: document.getElementById("sw-update-progress"),
  swApplyUpdate: document.getElementById("sw-apply-update"),
  appVersion: document.getElementById("app-version"),
  swUpdateRetry: document.getElementById("sw-update-retry"),
  backupCreate: document.getElementById("backup-create"),
  backupImport: document.getElementById("backup-import"),
  backupFile: document.getElementById("backup-file"),
  backupDirHint: document.getElementById("backup-dir-hint"),
  backupList: document.getElementById("backup-list"),
  refreshTasks: document.getElementById("refresh-tasks"),
  refreshLogs: document.getElementById("refresh-logs"),
  openCleanup: document.getElementById("open-cleanup"),
  cleanupDialog: document.getElementById("cleanup-dialog"),
  cleanupClose: document.getElementById("cleanup-close"),
  cleanupCancel: document.getElementById("cleanup-cancel"),
  cleanupExecute: document.getElementById("cleanup-execute"),
  cleanupLoading: document.getElementById("cleanup-loading"),
  cleanupErrorWrap: document.getElementById("cleanup-error-wrap"),
  cleanupError: document.getElementById("cleanup-error"),
  cleanupRetry: document.getElementById("cleanup-retry"),
  cleanupContent: document.getElementById("cleanup-content"),
  cleanupRunning: document.getElementById("cleanup-running"),
  cleanupResult: document.getElementById("cleanup-result"),
  cleanupOptions: document.getElementById("cleanup-options"),
  cleanupImpact: document.getElementById("cleanup-impact"),
  cleanupRange: document.getElementById("cleanup-range"),
  cleanupAllWarning: document.getElementById("cleanup-all-warning"),
  cleanupConfirmWrap: document.getElementById("cleanup-confirm-wrap"),
  cleanupConfirm: document.getElementById("cleanup-confirm"),
  cleanupAllInputWrap: document.getElementById("cleanup-all-input-wrap"),
  cleanupAllInput: document.getElementById("cleanup-all-input"),
  cleanupEmpty: document.getElementById("cleanup-empty"),
  usageDb: document.getElementById("usage-db"),
  usageWal: document.getElementById("usage-wal"),
  usageTotal: document.getElementById("usage-total"),
  usageCount: document.getElementById("usage-count"),
  pauseDialog: document.getElementById("pause-dialog"),
  pauseClose: document.getElementById("pause-close"),
  pauseCancel: document.getElementById("pause-cancel"),
  pauseConfirm: document.getElementById("pause-confirm"),
  pauseTask: document.getElementById("pause-task"),
  pauseDays: document.getElementById("pause-days"),
  pauseSummary: document.getElementById("pause-summary"),
  pauseError: document.getElementById("pause-error"),
  deleteDialog: document.getElementById("delete-dialog"),
  deleteClose: document.getElementById("delete-close"),
  deleteCancel: document.getElementById("delete-cancel"),
  deleteConfirm: document.getElementById("delete-confirm"),
  deleteTask: document.getElementById("delete-task"),
  deleteNameHint: document.getElementById("delete-name-hint"),
  deleteConfirmInput: document.getElementById("delete-confirm-input"),
  deleteError: document.getElementById("delete-error"),
  openTestCurl: document.getElementById("open-test-curl"),
  openTestGlobal: document.getElementById("open-test-global"),
  testDialog: document.getElementById("test-dialog"),
  testClose: document.getElementById("test-close"),
  testCancel: document.getElementById("test-cancel"),
  testSend: document.getElementById("test-send"),
  testCurl: document.getElementById("test-curl"),
  testPrecheckEnabled: document.getElementById("test-precheck-enabled"),
  testPrecheckFields: document.getElementById("test-precheck-fields"),
  testPrecheckWeekdays: document.getElementById("test-precheck-weekdays"),
  testPrecheckTimeStart: document.getElementById("test-precheck-time-start"),
  testPrecheckTimeEnd: document.getElementById("test-precheck-time-end"),
  testPrecheckCurl: document.getElementById("test-precheck-curl"),
  testPrecheckStatus: document.getElementById("test-precheck-status"),
  testPrecheckExpr: document.getElementById("test-precheck-expr"),
  testExpectStatus: document.getElementById("test-expect-status"),
  testExpectExpr: document.getElementById("test-expect-expr"),
  testExpectBody: document.getElementById("test-expect-body"),
  testNotifyEnabled: document.getElementById("test-notify-enabled"),
  testNotifyFields: document.getElementById("test-notify-fields"),
  testNotifyCurl: document.getElementById("test-notify-curl"),
  testSendNotify: document.getElementById("test-send-notify"),
  testHistory: document.getElementById("test-history"),
  testHistoryList: document.getElementById("test-history-list"),
  testSave: document.getElementById("test-save"),
  testError: document.getElementById("test-error"),
  testResult: document.getElementById("test-result"),
  testSummary: document.getElementById("test-summary"),
  testTotal: document.getElementById("test-total"),
  testSteps: document.getElementById("test-steps"),
};

const MAX_PAUSE_DAYS = 15;

const CLIENT_CONFIG_DEFAULTS = {
  logsPageSize: 50,
  defaultWindowMinutes: 5,
  pollIntervalMs: 4000,
  logBodyLimitBytes: 100 * 1024,
  requestTimeoutMs: 30_000,
};

const state = {
  tasks: [],
  tasksSignature: "",
  selectedTaskId: null,
  selectionEpoch: 0,
  logs: new Map(),
  /** Loaded log details (headers/bodies), fetched on demand. */
  logDetails: new Map(),
  detailLoading: new Set(),
  /** Retention window reported by the server (0 = no limit). */
  logRetentionDays: 30,
  oldestCursor: null,
  hasMore: false,
  polling: false,
  statusTimer: null,
  clientConfig: { ...CLIENT_CONFIG_DEFAULTS },
  metrics: null,
  /** What the server knows about this installation. */
  system: null,
  /** The result of the last update check. */
  update: null,
  /** True while a task card is being dragged (the list must not repaint). */
  dragging: false,
  cleanup: { preview: null, selected: null, busy: false, view: "loading" },
  pause: { taskId: null, busy: false, label: "暂停任务" },
  deleting: { taskId: null, busy: false, name: "" },
  testing: { busy: false, taskId: null },
  editingId: null,
};

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function hhmm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(timestamp) {
  if (timestamp === null || timestamp === undefined) return "—";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatShortTime(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatClockSecond(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** epoch ms -> value for `<input type="datetime-local">` in local time. */
function toDateTimeLocal(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `datetime-local` value -> epoch ms (local time); null when empty/invalid. */
function fromDateTimeLocal(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDay(timestamp) {
  const date = new Date(timestamp);
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  // A pause can cross New Year (up to 15 days), so include the year when needed.
  return date.getFullYear() === new Date().getFullYear()
    ? monthDay
    : `${date.getFullYear()}-${monthDay}`;
}

/**
 * A live pause is [paused_from, paused_until). `started: false` means the
 * interval begins in the future ("starts tomorrow"), so TODAY still runs.
 * A deadline in the past means the pause is already over.
 */
function pauseStateOf(task, now = Date.now()) {
  const until = task.paused_until;
  if (until === null || until === undefined || until <= now) return null;
  // A legacy row may lack paused_from: treat it as already started so the card
  // never reports an absurd day count.
  const from = task.paused_from ?? now;
  return { from, until, started: from <= now };
}

function calendarDays(from, until) {
  const a = new Date(from);
  a.setHours(0, 0, 0, 0);
  const b = new Date(until);
  b.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text =
    unit === 0 ? String(Math.round(size)) : size >= 100 ? size.toFixed(0) : size.toFixed(1);
  return `${text} ${units[unit]}`;
}

function formatWindow(task) {
  const cross = task.window_end < task.window_start;
  return `${task.window_start}–${task.window_end}${cross ? "（跨午夜）" : ""}`;
}

function scheduleKindOf(task) {
  return task.schedule_kind === "interval" ? "interval" : "daily";
}

function formatInterval(seconds) {
  const value = Number(seconds) || 0;
  if (value > 0 && value % 86400 === 0) return `${value / 86400} 天`;
  if (value > 0 && value % 3600 === 0) return `${value / 3600} 小时`;
  if (value > 0 && value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
}

/** Short human description shown on the task card and in the log header. */
function formatSchedule(task) {
  const kind = scheduleKindOf(task);
  if (kind === "interval") {
    const base = `每 ${formatInterval(task.interval_seconds)}`;
    const anchor = task.interval_start_at
      ? `（从 ${formatShortTime(task.interval_start_at)} 起算）`
      : "";
    const jitter =
      task.interval_jitter_seconds > 0
        ? `，随机 +0–${task.interval_jitter_seconds}s`
        : "";
    return `${base}${anchor}${jitter}`;
  }
  if (task.window_start === task.window_end) {
    const jitter = task.daily_jitter_minutes ?? 0;
    return jitter > 0
      ? `每天 ${task.window_start} ±${jitter} 分钟`
      : `每天 ${task.window_start}`;
  }
  return `每天 ${formatWindow(task)}`;
}

function prettyJson(raw) {
  if (raw === null || raw === undefined || raw === "") return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function setStatus(message, isError = false) {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle("error", isError);
  clearTimeout(state.statusTimer);
  if (!isError) {
    state.statusTimer = setTimeout(() => {
      els.statusLine.textContent = "就绪";
      els.statusLine.classList.remove("error");
    }, 5000);
  }
}

function showFormError(message) {
  els.formError.textContent = message ?? "";
  els.formError.hidden = !message;
}

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  }
  // A synchronous VACUUM during log cleanup can block the single Bun thread;
  // without a timeout the polling loop would hang forever on that request.
  if (!init.signal) init.signal = AbortSignal.timeout(15_000);
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new Error(
      timedOut
        ? "请求超时：服务可能正忙（例如日志清理），请稍后重试"
        : "无法连接 Jitter 服务，请确认服务仍在运行",
    );
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? "curl";
}

function syncMode() {
  const mode = getMode();
  els.curlWrap.hidden = mode !== "curl";
  els.structuredWrap.hidden = mode !== "structured";
}

function syncNotify() {
  els.notifyFields.hidden = !els.notifyEnabled.checked;
}

function syncPrecheck() {
  els.precheckFields.hidden = !els.precheckEnabled.checked;
}

function weekdayBoxes(containerId) {
  const container = document.getElementById(containerId);
  return container ? [...container.querySelectorAll('input[type="checkbox"]')] : [];
}

function checkedWeekdays(containerId) {
  return weekdayBoxes(containerId)
    .filter((input) => input.checked)
    .map((input) => Number(input.value));
}

function setCheckedWeekdays(containerId, days) {
  const wanted = new Set((Array.isArray(days) ? days : []).map(Number));
  for (const input of weekdayBoxes(containerId)) {
    input.checked = wanted.has(Number(input.value));
  }
}

function getScheduleKind() {
  return document.querySelector('input[name="schedule_kind"]:checked')?.value ?? "daily";
}

/** range | exact | jitter — the three shapes of 定时执行. */
function getDailyMode() {
  return document.querySelector('input[name="daily_mode"]:checked')?.value ?? "range";
}

function setDailyMode(mode) {
  const input = document.querySelector(`input[name="daily_mode"][value="${mode}"]`);
  if (input) input.checked = true;
  syncDailyMode();
}

function syncDailyMode() {
  const mode = getDailyMode();
  els.dailyRangeFields.hidden = mode !== "range";
  els.dailyExactField.hidden = mode === "range";
  els.dailyJitterField.hidden = mode !== "jitter";
  els.dailyHint.textContent =
    mode === "range"
      ? "每天在窗口内随机挑一个时刻执行一次；结束早于开始视为跨午夜窗口（例如 23:50–00:10），按开始日计一次。"
      : mode === "exact"
        ? "每天就在这个时刻执行一次，不随机。"
        : "以该时刻为中心，前后各随机浮动 N 分钟内执行（例如 18:00 + 5 → 17:55 到 18:05 之间随机一个时刻）。";
  schedulePreview();
}

function syncSchedule() {
  const kind = getScheduleKind();
  els.scheduleDaily.hidden = kind !== "daily";
  els.scheduleInterval.hidden = kind !== "interval";
  // Coming back from interval with no window typed yet: offer a sensible
  // default instead of an empty time input.
  if (kind === "daily" && !els.windowStart.value && !els.windowEnd.value) {
    setDefaultWindow();
  }
  if (kind === "daily") syncDailyMode();
  else schedulePreview();
}

let previewTimer = null;
let previewEpoch = 0;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 250);
}

/** The schedule the form currently describes, or null when it is incomplete. */
function previewPayload() {
  const kind = getScheduleKind();
  if (kind === "daily") {
    if (getDailyMode() === "range") {
      const start = els.windowStart.value;
      const end = els.windowEnd.value;
      if (!start || !end || start === end) return null;
      return {
        schedule_kind: "daily",
        window_start: start,
        window_end: end,
        count: 7,
      };
    }
    const time = els.exactTime.value;
    if (!time) return null;
    const payload = {
      schedule_kind: "daily",
      window_start: time,
      window_end: time,
      count: 7,
    };
    if (getDailyMode() === "jitter") {
      const jitter = Number(els.jitterMinutes.value || "0");
      if (Number.isInteger(jitter) && jitter > 0) {
        payload.daily_jitter_minutes = Math.min(jitter, 60);
      }
    }
    return payload;
  }
  const value = Number(els.intervalValue.value);
  const unit = Number(els.intervalUnit.value);
  if (!Number.isInteger(value) || value < 1) return null;
  const seconds = value * unit;
  if (seconds > 30 * 24 * 3600) return null;
  const jitter = Number(els.intervalJitter.value || "0");
  const safeJitter = Number.isInteger(jitter) && jitter >= 0 ? Math.min(jitter, seconds) : 0;
  const payload = {
    schedule_kind: "interval",
    interval_seconds: seconds,
    interval_jitter_seconds: safeJitter,
    count: 7,
  };
  const startAt = fromDateTimeLocal(els.intervalStart.value);
  if (startAt !== null) payload.interval_start_at = startAt;
  return payload;
}

/** Show the next 7 runs so the pattern is obvious before saving. */
async function refreshPreview() {
  const payload = previewPayload();
  if (!payload) {
    els.schedulePreview.hidden = true;
    return;
  }
  const epoch = (previewEpoch += 1);
  try {
    const data = await api("/api/schedule/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (epoch !== previewEpoch) return; // a newer request won
    renderPreview(data, payload);
  } catch {
    if (epoch === previewEpoch) els.schedulePreview.hidden = true;
  }
}

function renderPreview(data, payload) {
  const times = Array.isArray(data.next) ? data.next : [];
  if (times.length === 0) {
    els.schedulePreview.hidden = true;
    return;
  }
  const win = data.window ?? null;
  const chips = times.map((timestamp) => {
    if (data.kind !== "daily") {
      return h("span", { class: "preview-chip" }, formatClockSecond(timestamp));
    }
    const label =
      win && !win.instant ? `${formatShortTime(timestamp)}–${win.end}` : formatShortTime(timestamp);
    return h("span", { class: "preview-chip" }, label);
  });
  els.schedulePreview.hidden = false;
  els.schedulePreviewList.replaceChildren(...chips);
  if (data.kind === "daily") {
    const jitter = payload.daily_jitter_minutes ?? 0;
    els.schedulePreviewNote.textContent =
      win && win.instant
        ? "每天固定这个时刻"
        : jitter > 0
          ? `基准 ${payload.window_start}，前后各 ${jitter} 分钟随机`
          : "窗口内随机，具体时刻执行前才确定";
  } else {
    const jitter = payload.interval_jitter_seconds ?? 0;
    els.schedulePreviewNote.textContent = jitter > 0 ? `每次再加 0–${jitter} 秒抖动` : "";
  }
}

function setDefaultWindow() {
  const now = new Date();
  const configured = Number(state.clientConfig.defaultWindowMinutes);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 5;
  const end = new Date(now.getTime() + minutes * 60_000);
  els.windowStart.value = hhmm(now);
  els.windowEnd.value = hhmm(end);
  // The exact-time input is a single field shared by two modes; give it the
  // same sensible default so switching modes is not an empty form.
  if (!els.exactTime.value) els.exactTime.value = hhmm(now);
}

async function loadClientConfig() {
  try {
    const data = await api("/api/config");
    state.clientConfig = {
      ...CLIENT_CONFIG_DEFAULTS,
      ...(data && typeof data === "object" ? data : {}),
    };
  } catch {
    state.clientConfig = { ...CLIENT_CONFIG_DEFAULTS };
  }
  const bytes = Number(state.clientConfig.logBodyLimitBytes);
  const kib =
    Number.isFinite(bytes) && bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 100;
  const hint = document.getElementById("body-limit");
  if (hint) hint.textContent = String(kib);
  // 0 = no server-side timeout: a request that never returns would keep the
  // task busy forever, so the user has to know.
  const warning = document.getElementById("timeout-warning");
  if (warning) {
    const timeout = Number(state.clientConfig.requestTimeoutMs);
    warning.hidden = Number.isFinite(timeout) && timeout > 0;
  }
}

function selectedTask() {
  return state.tasks.find((task) => task.id === state.selectedTaskId) ?? null;
}

function renderTasks() {
  els.taskList.replaceChildren();
  els.tasksEmpty.hidden = state.tasks.length > 0;

  for (const task of state.tasks) {
    els.taskList.append(renderTaskCard(task));
  }

  const current = selectedTask();
  if (current) {
    els.logsTitle.textContent = `执行记录 · ${current.name}`;
    renderLogMeta(current);
  } else {
    els.logsTitle.textContent = "执行记录";
    els.logsTaskMeta.textContent = "";
  }
}

/** The subtitle of the log panel: schedule, next run and the visible window. */
function renderLogMeta(task = selectedTask()) {
  if (!task) {
    els.logsTaskMeta.textContent = "";
    return;
  }
  const window = state.logRetentionDays > 0 ? ` · 仅显示最近 ${state.logRetentionDays} 天` : "";
  els.logsTaskMeta.textContent = `${formatSchedule(task)} · 下次 ${formatTime(
    task.next_run_at,
  )}${task.running ? " · 执行中" : ""}${window}`;
}

function formatTimeout(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = value / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** "45 秒" / "3 分 12 秒" — elapsed time of an in-flight request. */
function formatElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * Keep the "执行中 · 已 x 秒" badges ticking even when no new data arrives.
 * A request that hangs must look like it is hanging, not frozen.
 */
function tickRunningBadges() {
  const nodes = els.taskList.querySelectorAll("[data-running-since]");
  if (nodes.length === 0) return;
  const now = Date.now();
  for (const node of nodes) {
    const since = Number(node.dataset.runningSince);
    if (!Number.isFinite(since)) continue;
    node.textContent = `执行中 · ${formatElapsed(now - since)}`;
  }
}

/**
 * Drag & drop reordering of the task list.
 *
 * Pointer based (not HTML5 drag & drop) so it also works with a finger, and
 * so the dragged card can follow the pointer exactly. The list keeps its
 * place during the drag: the dragged card is taken out of the flow and a
 * placeholder of the same height takes its place.
 */
const DRAG_THRESHOLD = 5;

/** Set after a real drag so the trailing click event is ignored. */
let suppressClick = false;

const drag = {
  started: false,
  card: null,
  placeholder: null,
  indicator: null,
  pointerId: null,
  startY: 0,
  offsetY: 0,
  targetId: null,
  position: null,
};

/** The ids of the tasks in their current visual order. */
function currentOrderIds() {
  return state.tasks.map((task) => task.id);
}

/** Put `movedId` before or after `targetId` in `ids`. */
function insertInto(ids, movedId, targetId, position) {
  const next = ids.filter((id) => id !== movedId);
  if (targetId === null) {
    next.push(movedId);
    return next;
  }
  const index = next.indexOf(targetId);
  if (index < 0) {
    next.push(movedId);
    return next;
  }
  next.splice(position === "after" ? index + 1 : index, 0, movedId);
  return next;
}

function markDropTarget(targetId, position) {
  for (const node of els.taskList.querySelectorAll(".drop-before, .drop-after")) {
    node.classList.remove("drop-before", "drop-after");
  }
  if (targetId === null) {
    if (drag.indicator) drag.indicator.remove();
    return;
  }
  const node = els.taskList.querySelector(`.task-card[data-id="${CSS.escape(targetId)}"]`);
  if (node) node.classList.add(position === "after" ? "drop-after" : "drop-before");
}

/**
 * The insertion line. It lives above the dragged card (higher z-index) so
 * the landing spot stays visible even when the card hovers over it.
 */
function showDropIndicator(targetId, position) {
  if (!drag.indicator) {
    drag.indicator = h("div", { class: "drop-indicator" });
  }
  if (!drag.indicator.isConnected) els.taskList.append(drag.indicator);
  if (targetId === null) {
    drag.indicator.remove();
    return;
  }
  const node = els.taskList.querySelector(`.task-card[data-id="${CSS.escape(targetId)}"]`);
  if (!node) return;
  const listRect = els.taskList.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const y = position === "after" ? rect.bottom : rect.top;
  drag.indicator.style.top = `${Math.round(y - listRect.top)}px`;
}

function startDrag(event) {
  const card = drag.card;
  if (!card) return;
  drag.started = true;
  state.dragging = true;
  const rect = card.getBoundingClientRect();
  drag.offsetY = drag.startY - rect.top;
  drag.width = rect.width;

  // A placeholder keeps the list from jumping when the card leaves the flow.
  drag.placeholder = h("div", {
    class: "task-placeholder",
    style: `height:${Math.round(rect.height)}px`,
  });
  card.after(drag.placeholder);

  card.classList.add("dragging");
  card.style.width = `${rect.width}px`;
  card.style.position = "fixed";
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.style.zIndex = "30";
  card.style.pointerEvents = "none";
  document.body.classList.add("dragging-task");
}

function moveDrag(event) {
  const card = drag.card;
  if (!card) return;
  card.style.top = `${event.clientY - drag.offsetY}px`;

  // The drop position: the first card whose middle the pointer passed.
  const others = [...els.taskList.querySelectorAll(".task-card:not(.dragging)")];
  let target = null;
  let position = null;
  for (const other of others) {
    const rect = other.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      target = other;
      position = "before";
      break;
    }
    target = other;
    position = "after";
  }
  drag.targetId = target ? target.dataset.id : null;
  drag.position = position;
  markDropTarget(drag.targetId, position);
  showDropIndicator(drag.targetId, position);
}

function endDrag() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  window.removeEventListener("keydown", onDragKeyDown, true);

  const card = drag.card;
  if (card) {
    card.classList.remove("dragging");
    card.style.width = "";
    card.style.position = "";
    card.style.left = "";
    card.style.top = "";
    card.style.zIndex = "";
    card.style.pointerEvents = "";
  }
  if (drag.placeholder) drag.placeholder.remove();
  if (drag.indicator) {
    drag.indicator.remove();
    drag.indicator = null;
  }
  markDropTarget(null, null);
  document.body.classList.remove("dragging-task");
  state.dragging = false;

  const started = drag.started;
  const movedId = card ? card.dataset.id : null;
  const targetId = drag.targetId;
  const position = drag.position;
  drag.card = null;
  drag.placeholder = null;
  drag.started = false;
  drag.targetId = null;
  drag.position = null;

  if (!started || !movedId) return;
  suppressClick = true;
  const ids = insertInto(currentOrderIds(), movedId, targetId, position);
  if (ids.join(",") === currentOrderIds().join(",")) return;
  void applyOrder(ids);
}

function onPointerDown(event) {
  const handle = event.target.closest("[data-drag-handle]");
  if (!handle) return;
  if (event.button !== undefined && event.button !== 0) return;
  const card = handle.closest(".task-card");
  if (!card) return;
  event.preventDefault();
  drag.card = card;
  drag.startY = event.clientY;
  drag.pointerId = event.pointerId ?? null;
  drag.started = false;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onDragKeyDown, true);
}

function onPointerMove(event) {
  if (drag.pointerId !== null && event.pointerId !== undefined && event.pointerId !== drag.pointerId) {
    return;
  }
  if (!drag.started) {
    if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    startDrag(event);
  }
  moveDrag(event);
}

function onPointerUp() {
  endDrag();
}

/** Escape cancels the drag, the card goes back to where it was. */
function onDragKeyDown(event) {
  if (event.key === "Escape" && drag.started) {
    event.preventDefault();
    drag.targetId = null;
    endDrag();
  }
}

/** Send a new order to the server and repaint with what it returns. */
async function applyOrder(ids) {
  try {
    const data = await api("/api/tasks/reorder", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if (Array.isArray(data?.tasks)) state.tasks = data.tasks;
    state.tasksSignature = "";
    renderTasks();
    setStatus("任务顺序已保存");
  } catch (error) {
    setStatus(error.message, true);
    await loadTasks({ silent: true });
  }
}

/** Move a task one place up or down (keyboard alternative to dragging). */
async function moveTaskByKeyboard(taskId, delta) {
  const ids = currentOrderIds();
  const index = ids.indexOf(taskId);
  if (index < 0) return;
  const target = index + delta;
  if (target < 0 || target >= ids.length) return;
  const next = [...ids];
  next.splice(index, 1);
  next.splice(target, 0, taskId);
  await applyOrder(next);
}

// ---------------------------------------------------------------------------
// Settings (software)
// ---------------------------------------------------------------------------

/**
 * Load what the server knows about this installation and paint the panel.
 * Every action reports its own result - nothing here fails silently.
 */
async function loadSystemInfo() {
  try {
    const info = await api("/api/system");
    state.system = info;
    if (els.appVersion) els.appVersion.textContent = info.version ? `v${info.version}` : "";
    els.swVersion.textContent = info.version ?? "—";
    els.swMode.textContent = info.compiled
      ? "已安装的单文件程序"
      : "开发模式（从源码运行）";
    els.swUrl.textContent = info.url ?? "—";
    els.swInstall.textContent = info.install_dir ?? info.binary_path ?? "源码目录";
    els.swData.textContent = info.db_path ?? "—";
    els.swAutostart.checked = Boolean(info.autostart);
    els.swAutostartHint.textContent = info.compiled
      ? info.autostart
        ? `已注册：${info.autostart_path}`
        : `未注册（注册文件：${info.autostart_path}）`
      : "开机自启只对安装后的程序有效，当前从源码运行。";
    els.swAutostart.disabled = !info.compiled;
    return info;
  } catch (error) {
    els.swVersion.textContent = `读取失败：${error.message}`;
    if (els.appVersion && !els.appVersion.textContent) els.appVersion.textContent = "v—";
    return null;
  }
}

async function toggleAutostart(enabled) {
  els.swAutostart.disabled = true;
  try {
    const result = await api("/api/system/autostart", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    els.swAutostart.checked = Boolean(result.autostart);
    await loadSystemInfo();
    setStatus(result.autostart ? "已设置开机自启" : "已取消开机自启");
  } catch (error) {
    els.swAutostart.checked = !enabled;
    setStatus(error.message, true);
  } finally {
    els.swAutostart.disabled = false;
  }
}

async function checkUpdate() {
  els.swCheckUpdate.disabled = true;
  els.swUpdate.hidden = false;
  els.swUpdateRetry.hidden = true;
  els.swUpdateSummary.textContent = "正在检查更新…";
  els.swUpdateNotes.textContent = "";
  els.swApplyUpdate.disabled = true;
  try {
    const info = await api("/api/update/check");
    state.update = info;
    if (info.error && !info.latest) {
      els.swUpdateSummary.textContent = `检查失败：${info.error}`;
      return;
    }
    if (!info.latest) {
      els.swUpdateSummary.textContent = "还没有发布任何版本（仓库里暂无 Release）。";
      return;
    }
    if (!info.available) {
      els.swUpdateSummary.textContent = `当前版本 ${info.current} 已是最新${
        info.latest ? `（最新发布 ${info.latest}）` : ""
      }。`;
      return;
    }
    els.swUpdateSummary.textContent = `发现新版本 ${info.latest}（当前 ${info.current}）${
      info.asset ? `，安装包 ${formatBytes(info.asset.size)}` : ""
    }`;
    els.swUpdateNotes.textContent = info.notes ?? "（这个发布没有说明）";
    els.swApplyUpdate.disabled = false;
  } catch (error) {
    els.swUpdateSummary.textContent = `检查失败：${error.message}`;
  } finally {
    els.swCheckUpdate.disabled = false;
  }
}

/** Download and install the new release, showing the progress live. */
/**
 * 升级状态机：busy（进行中）/ success（已升级，数据已刷新）/
 * error（失败，给出原因且「重试」可点）/ idle（未开始）。
 * 所有非正常状态都必须留下可操作的下一步。
 */
function setUpgradeState(view, message) {
  els.swUpdateProgress.textContent = message ?? "";
  if (view === "busy") {
    els.swApplyUpdate.disabled = true;
    els.swUpdateRetry.hidden = true;
  } else if (view === "error") {
    els.swApplyUpdate.disabled = false;
    els.swUpdateRetry.hidden = false;
  } else if (view === "success") {
    els.swApplyUpdate.disabled = true;
    els.swUpdateRetry.hidden = true;
  } else {
    els.swApplyUpdate.disabled = false;
    els.swUpdateRetry.hidden = true;
  }
}

/** 等新版本把服务拉起来（旧版本退出到新版本可访问之间页面是断的）。 */
async function waitForServerBack(previousVersion) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 10 ? 1000 : 2000));
    setUpgradeState("busy", `等待新版本启动…（已等 ${attempt + 1} 秒）`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const response = await fetch("/api/system", { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!response.ok) continue;
      const info = await response.json();
      if (info?.version && info.version !== previousVersion) return info;
      // 版本没变：旧进程可能还没退出，也可能升级没生效——多等几轮再下结论。
      if (attempt >= 9) return info;
    } catch {
      // 服务正在重启：连接失败是预期状态，继续等。
    }
  }
  return null;
}

/** 升级成功：刷新页面数据，让用户立刻回到正常业务。 */
async function finishUpgradeSuccess(newVersion, previousVersion) {
  setUpgradeState("success", `升级成功：v${previousVersion} → v${newVersion}，页面数据已刷新。`);
  setStatus(`已升级到 v${newVersion}`);
  await loadSystemInfo();
  await loadTasks({ silent: true });
  if (state.selectedTaskId) await loadLogs({ reset: true });
  void refreshMetrics();
}

async function applyUpdate() {
  const previousVersion = state.system?.version ?? "?";
  const expected = state.update?.latest ?? null;
  setUpgradeState("busy", "正在准备…");

  // 先确认服务可达，避免"点了没反应"。
  try {
    await api("/api/health", { signal: AbortSignal.timeout(3000) });
  } catch {
    setUpgradeState("error", "无法连接 Jitter 服务。请确认程序仍在运行（看托盘图标），然后点「重试」。");
    return;
  }

  // 已经是目标版本：上次其实升级成功了（比如页面没感知到），直接收尾。
  try {
    const info = await api("/api/system", { signal: AbortSignal.timeout(3000) });
    if (expected && info?.version === expected) {
      finishUpgradeSuccess(info.version, previousVersion);
      return;
    }
  } catch {
    // 继续按当前版本降级处理。
  }

  const poller = setInterval(async () => {
    try {
      const progress = await api("/api/update/progress", { signal: AbortSignal.timeout(2000) });
      if (progress?.error) {
        setUpgradeState("busy", `出错：${progress.error}（正在收尾…）`);
      } else if (progress?.message) {
        setUpgradeState("busy", progress.message);
      }
    } catch {
      // 正在重启时请求失败是预期行为。
    }
  }, 500);

  let result = null;
  let requestError = null;
  try {
    result = await api("/api/update/apply", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (error) {
    requestError = error;
  } finally {
    clearInterval(poller);
  }

  if (requestError) {
    // 请求中断：多半是旧进程在替换后退出了。等新版本起来再判断。
    setUpgradeState("busy", "升级请求中断，正在等待服务恢复…");
    const back = await waitForServerBack(previousVersion);
    if (back && (!expected || back.version === expected)) {
      await finishUpgradeSuccess(back.version, previousVersion);
    } else if (back) {
      setUpgradeState("error", `服务已恢复，但版本仍是 ${back.version}（期望 ${expected ?? "新版本"}）。可能替换未生效，点「重试」重新下载安装。`);
    } else {
      setUpgradeState("error", `升级失败：${requestError.message}。若托盘图标仍在，可点「重试」；否则请手动重新打开程序。`);
    }
    return;
  }

  if (!result?.ok) {
    const message = result?.message ?? "未知原因";
    if (message.includes("最新版本")) {
      setUpgradeState("idle", message);
      els.swApplyUpdate.disabled = true;
    } else {
      setUpgradeState("error", `升级失败：${message}。当前版本仍可正常使用，可点「重试」。`);
    }
    return;
  }

  // 升级包已就位、正在重启：等新版本起来并核对版本号。
  setUpgradeState("busy", result.message ?? "升级完成，正在重启…");
  const back = await waitForServerBack(previousVersion);
  if (!back) {
    setUpgradeState("error", "等待 60 秒仍未恢复。请检查托盘图标是否在运行、端口是否被占用；可点「重试」再次检测，或手动重新打开程序。");
    return;
  }
  if (expected && back.version !== expected) {
    setUpgradeState("error", `服务已恢复，但版本仍是 ${back.version}（期望 ${expected}）。可能替换未生效，点「重试」或手动重新下载安装包。`);
    return;
  }
  await finishUpgradeSuccess(back.version, previousVersion);
}

async function quitApp() {
  if (!window.confirm("退出后 Jitter 会停止运行，页面也会断开。确定退出吗？")) return;
  els.swQuit.disabled = true;
  try {
    await api("/api/quit", { method: "POST" });
    els.swQuit.disabled = false;
    setStatus("正在退出…");
  } catch (error) {
    els.swQuit.disabled = false;
    setStatus(error.message, true);
  }
}

// ---------------------------------------------------------------------------
// Settings: backup / export / import / restore
// ---------------------------------------------------------------------------

function formatBackupSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatBackupTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (entry) => String(entry).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadBackups() {
  try {
    const data = await api("/api/backup/list");
    els.backupDirHint.textContent = `备份目录：${data.backup_dir}`;
    renderBackupList(data.backups ?? []);
  } catch (error) {
    els.backupDirHint.textContent = `备份列表读取失败：${error.message}`;
    renderBackupList([]);
  }
}

function renderBackupList(entries) {
  if (!entries.length) {
    els.backupList.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "backup-empty",
        textContent: "还没有备份。点「新建备份」生成一份完整快照（任务、日志、设置都在内）。",
      }),
    );
    return;
  }
  const items = entries.map((entry) => {
    const row = document.createElement("div");
    row.className = "backup-item";
    const meta = document.createElement("div");
    meta.className = "backup-meta";
    const name = document.createElement("div");
    name.className = "backup-name";
    name.textContent = entry.name;
    const size = document.createElement("div");
    size.className = "backup-size";
    size.textContent = `${formatBackupSize(entry.size)} · ${formatBackupTime(entry.modified_at)}`;
    meta.append(name, size);

    const actions = document.createElement("div");
    actions.className = "backup-actions";
    const download = document.createElement("button");
    download.className = "btn";
    download.type = "button";
    download.textContent = "下载";
    download.addEventListener("click", () => {
      // 直接用浏览器下载（带上名字参数）。
      window.open(`/api/backup/download?name=${encodeURIComponent(entry.name)}`, "_blank");
    });
    const restore = document.createElement("button");
    restore.className = "btn";
    restore.type = "button";
    restore.textContent = "恢复";
    restore.addEventListener("click", () => void restoreBackup(entry.name));
    const remove = document.createElement("button");
    remove.className = "btn";
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => void deleteBackup(entry.name));
    actions.append(download, restore, remove);
    row.append(meta, actions);
    return row;
  });
  els.backupList.replaceChildren(...items);
}

async function createBackupSnapshot() {
  els.backupCreate.disabled = true;
  els.backupCreate.textContent = "备份中…";
  try {
    const data = await api("/api/backup", { method: "POST", signal: AbortSignal.timeout(120_000) });
    setStatus(`备份已创建：${data.backup.name}`);
    await loadBackups();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    els.backupCreate.disabled = false;
    els.backupCreate.textContent = "新建备份";
  }
}

async function restoreBackup(name) {
  if (
    !window.confirm(
      `确定用备份「${name}」恢复吗？\n当前的数据会被覆盖（恢复前会自动另存一份当前状态的安全备份）。`,
    )
  ) {
    return;
  }
  els.backupRestoreBusy = true;
  setStatus("正在恢复备份…");
  try {
    const data = await api("/api/backup/restore", {
      method: "POST",
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(180_000),
    });
    setStatus(data.message ?? "已恢复");
    // 数据回来了：全部重新加载。
    await refreshAll();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    els.backupRestoreBusy = false;
    await loadBackups();
  }
}

async function deleteBackup(name) {
  if (!window.confirm(`删除备份「${name}」？此操作不可恢复。`)) return;
  try {
    await api("/api/backup/delete", { method: "POST", body: JSON.stringify({ name }) });
    setStatus(`已删除备份 ${name}`);
    await loadBackups();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function pickBackupFile() {
  els.backupFile.value = "";
  els.backupFile.click();
}

async function uploadBackupFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.name.endsWith(".db")) {
    setStatus("请选择 .db 备份文件", true);
    return;
  }
  setStatus(`正在上传 ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await api(`/api/backup/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream" },
      signal: AbortSignal.timeout(300_000),
    });
    setStatus(`已导入备份 ${data.backup.name}，可在列表里点「恢复」`);
    await loadBackups();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function openSettings() {
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
  els.swUpdate.hidden = true;
  els.swUpdateProgress.textContent = "";
  await loadSystemInfo();
  await syncRetentionControl();
  await loadBackups();
}

function renderTaskCard(task) {
  const kind = scheduleKindOf(task);
  const cross = kind === "daily" && task.window_end < task.window_start;
  const active = task.status === "active";
  const pause = active ? pauseStateOf(task) : null;
  const conditions = [];
  if (task.expect_status !== null) conditions.push(`状态=${task.expect_status}`);
  if (task.expect_body !== null) conditions.push("响应体相等");
  if (task.expect_expr !== null) conditions.push(`条件=${task.expect_expr}`);
  if (!conditions.length) conditions.push("任意 2xx");

  let requestOptions = {};
  try {
    requestOptions = task.request_options ? JSON.parse(task.request_options) : {};
  } catch {
    requestOptions = {};
  }

  const statusBadge = h(
    "span",
    {
      class: `badge ${
        active
          ? pause
            ? pause.started
              ? "badge-paused"
              : "badge-pending"
            : "badge-active"
          : "badge-stopped"
      }`,
    },
    active
      ? pause
        ? pause.started
          ? `暂停至 ${formatDay(pause.until)}`
          : `${formatDay(pause.from)} 起暂停`
        : "运行中"
      : "已停止",
  );

  // A request that is in flight right now. Without this the user cannot tell
  // "waiting for the next run" from "stuck inside a request that never ends".
  const runningBadge = task.running
    ? h(
        "span",
        {
          class: "badge badge-running",
          dataset: { runningSince: String(task.running_since ?? Date.now()) },
          title: "请求正在执行中",
        },
        `执行中 · ${formatElapsed(Date.now() - (task.running_since ?? Date.now()))}`,
      )
    : null;

  // A schedule that cannot be parsed would silently never run again.
  const brokenBadge = task.schedule_error
    ? h(
        "span",
        { class: "badge badge-broken", title: task.schedule_error },
        "调度配置无效",
      )
    : null;

  const card = h(
    "article",
    {
      class: `task-card${task.id === state.selectedTaskId ? " selected" : ""}`,
      dataset: { id: task.id },
      tabindex: "0",
      "aria-label": `任务 ${task.name}`,
      "aria-current": task.id === state.selectedTaskId ? "true" : null,
    },
    h(
      "div",
      { class: "task-head" },
      h(
        "div",
        { class: "task-title" },
        h(
          "button",
          {
            class: "drag-handle",
            type: "button",
            dataset: { dragHandle: "1" },
            title: "拖动排序；也可以聚焦后按 ↑ / ↓",
            "aria-label": `拖动调整任务「${task.name}」的位置`,
          },
          "⠿",
        ),
        h("h3", { class: "task-name" }, task.name),
      ),
      h(
        "div",
        { class: "task-actions" },
        task.running
          ? h(
              "button",
              {
                class: "btn",
                type: "button",
                dataset: { action: "run" },
                disabled: true,
                title: "上一次执行还没结束",
              },
              "执行中…",
            )
          : h(
              "button",
              {
                class: "btn btn-primary",
                type: "button",
                dataset: { action: "run" },
                title: "真实执行一次：会发请求，命中条件会发通知，并写入执行记录",
              },
              "立即执行",
            ),
        h("button", { class: "btn", type: "button", dataset: { action: "edit" } }, "编辑"),
        h(
          "details",
          { class: "task-more" },
          h("summary", { class: "btn", title: "更多操作" }, "更多"),
          h(
            "div",
            { class: "task-menu" },
            h(
              "button",
              {
                class: "btn btn-quiet",
                type: "button",
                dataset: { action: "test" },
                title: "只演练一遍完整链路（解析→判断→请求→判定→通知预览），不写执行记录、不真正发通知",
              },
              "试跑（不记录）",
            ),
            active
              ? pause
                ? [
                    h("button", { class: "btn btn-quiet", type: "button", dataset: { action: "pause" } }, "调整暂停"),
                    h("button", { class: "btn btn-quiet", type: "button", dataset: { action: "resume" } }, "取消暂停"),
                  ]
                : h("button", { class: "btn btn-quiet", type: "button", dataset: { action: "pause" } }, "暂停")
              : null,
            active
              ? h("button", { class: "btn btn-quiet btn-danger-text", type: "button", dataset: { action: "stop" } }, "停止")
              : h("button", { class: "btn btn-quiet", type: "button", dataset: { action: "resume" } }, "恢复调度"),
          ),
        ),
        h("button", { class: "btn btn-danger", type: "button", dataset: { action: "delete" } }, "删除"),
      ),
    ),
    h(
      "div",
      { class: "task-meta" },
      statusBadge,
      runningBadge,
      brokenBadge,
      cross ? h("span", { class: "badge badge-cross" }, "跨午夜") : null,
      task.precheck_enabled
        ? h("span", { class: "badge badge-pending" }, "前置判断")
        : null,
      requestOptions.insecure
        ? h("span", { class: "badge badge-insecure" }, "跳过 TLS 校验")
        : null,
      requestOptions.timeoutMs
        ? h("span", { class: "badge badge-timeout" }, `超时 ${formatTimeout(requestOptions.timeoutMs)}`)
        : null,
      h(
        "span",
        { class: "task-schedule" },
        h("span", { class: "meta-key" }, "调度 "),
        h("span", { class: "task-window-value" }, formatSchedule(task)),
      ),
    ),
    h("div", { class: "task-request" }, `${task.request_method} ${task.request_url}`),
    h(
      "div",
      { class: "task-foot" },
      h(
        "span",
        {},
        active
          ? pause
            ? pause.started
              ? `已暂停 ${calendarDays(pause.from, pause.until)} 天（${formatDay(pause.from)} 起），${formatTime(pause.until)} 恢复；下次 ${formatTime(task.next_run_at)}`
              : `下次 ${formatTime(task.next_run_at)}；${formatDay(pause.from)} 00:00 起暂停 ${calendarDays(pause.from, pause.until)} 天，${formatTime(pause.until)} 恢复`
            : `下次 ${formatTime(task.next_run_at)}`
          : "已停止，历史日志保留",
      ),
      h("span", { class: "foot-sep", "aria-hidden": "true" }, "·"),
      h("span", {}, task.notify_enabled ? `通知已开启（${conditions.join(" 且 ")}）` : "通知未开启"),
      h("span", { class: "foot-sep", "aria-hidden": "true" }, "·"),
      h(
        "span",
        {},
        task.precheck_enabled ? "执行前会先判断，不满足则跳过" : "无条件执行",
      ),
    ),
  );

  return card;
}

function kindLabel(kind) {
  if (kind === "notify") return "通知";
  if (kind === "missed") return "错过";
  if (kind === "skipped") return "跳过";
  return "任务";
}

function statusInfo(log) {
  if (log.kind === "missed") return { text: "未执行", cls: "status-warn" };
  if (log.kind === "skipped") return { text: "已跳过", cls: "status-warn" };
  if (log.error && log.error.startsWith("请求超时")) return { text: "超时", cls: "status-warn" };
  if (log.aborted) return { text: "已中断", cls: "status-err" };
  if (log.error) return { text: "错误", cls: "status-err" };
  if (log.response_status === null) return { text: "无响应", cls: "status-muted" };
  const status = log.response_status;
  const cls =
    status >= 200 && status < 300
      ? "status-ok"
      : status >= 300 && status < 400
        ? "status-warn"
        : "status-err";
  return { text: String(status), cls };
}

function addDetail(parent, title, content) {
  if (content === null || content === undefined || content === "") return;
  parent.append(h("section", {}, h("h4", {}, title), h("pre", {}, content)));
}

function renderLog(log) {
  const status = statusInfo(log);
  const head = h(
    "div",
    { class: "log-head" },
    h("span", { class: `badge badge-${log.kind}` }, kindLabel(log.kind)),
    h("span", { class: "log-time" }, formatTime(log.executed_at)),
    h("span", { class: `badge ${status.cls}` }, status.text),
    log.duration_ms !== null ? h("span", { class: "muted" }, `${log.duration_ms} ms`) : null,
    log.kind === "task" && log.matched !== null
      ? h(
          "span",
          { class: `badge ${log.matched ? "status-ok" : "status-muted"}` },
          log.matched ? "命中成功条件" : "未命中",
        )
      : null,
    log.kind === "notify" && log.parent_log_id !== null
      ? h("span", { class: "muted" }, `来自日志 #${log.parent_log_id}`)
      : null,
    log.run_source === "manual"
      ? h("span", { class: "badge status-muted", title: "页面「立即执行」触发，不是定时触发" }, "手动")
      : null,
  );

  const card = h(
    "article",
    { class: `log kind-${log.kind}${log.aborted ? " aborted" : ""}` },
    head,
  );

  if (log.request_url) {
    card.append(h("div", { class: "log-request" }, `${log.request_method ?? ""} ${log.request_url}`));
  }
  if (log.error) {
    card.append(h("div", { class: "log-error" }, log.error));
  }

  const details = h("details", { dataset: { logId: log.id } });
  details.append(h("summary", {}, "请求 / 响应详情"));
  const body = h("div", { class: "detail" });
  // The list only carries the summary; the bodies (up to 100 KiB each) are
  // fetched the first time the entry is opened.
  body.append(h("div", { class: "muted" }, "展开后加载详情…"));
  details.append(body);
  details.addEventListener("toggle", () => {
    if (details.open) void loadLogDetail(log.id, body);
  });
  card.append(details);

  return card;
}

/** Fetch (and cache) the heavy part of one log row. */
async function loadLogDetail(logId, body) {
  const cached = state.logDetails.get(logId);
  if (cached) {
    body.replaceChildren(...detailSections(cached));
    return;
  }
  if (state.detailLoading.has(logId)) return;
  state.detailLoading.add(logId);
  try {
    const data = await api(`/api/logs/${logId}`);
    const log = data?.log;
    if (!log) return;
    state.logDetails.set(logId, log);
    // The cached details are the heavy part (up to 100 KiB each): keep the
    // cache small so a long session cannot grow without bound.
    while (state.logDetails.size > 40) {
      const oldest = state.logDetails.keys().next().value;
      state.logDetails.delete(oldest);
    }
    body.replaceChildren(...detailSections(log));
  } catch (error) {
    body.replaceChildren(h("div", { class: "log-error" }, `详情加载失败：${error.message}`));
  } finally {
    state.detailLoading.delete(logId);
  }
}

/** The sections inside an expanded log entry. */
function detailSections(log) {
  const body = h("div", { class: "detail" });
  addDetail(body, "请求头", prettyJson(log.request_headers));
  if (log.request_body !== null) {
    addDetail(body, "请求体", log.request_body === "" ? "（空）" : prettyJson(log.request_body));
  }
  if (log.response_status !== null) {
    addDetail(body, "响应状态", String(log.response_status));
  }
  addDetail(body, "响应头", prettyJson(log.response_headers));
  if (log.response_body !== null) {
    addDetail(body, "响应体", log.response_body === "" ? "（空）" : prettyJson(log.response_body));
  }
  if (!body.childElementCount) {
    body.append(h("div", { class: "muted" }, "没有可显示的详情"));
  }
  return [body];
}

/** Newest first: execution time desc, id desc as the tiebreaker. */
function compareLogsDesc(a, b) {
  if (b.executed_at !== a.executed_at) return b.executed_at - a.executed_at;
  return b.id - a.id;
}

/**
 * How many log rows stay in the DOM at once.
 *
 * The list is paged (50 rows per request) but a user can keep pressing
 * "加载更早"; without a cap the DOM would grow until the browser starts to
 * stutter. Beyond the cap the list keeps the newest rows and says so.
 */
const MAX_LOG_ROWS = 300;

/** A render slower than this shows a hint, so a stutter is never silent. */
const SLOW_RENDER_MS = 120;

function renderLogs() {
  const started = performance.now();
  // Polling rebuilds the whole list; keep expanded detail panels expanded.
  const openIds = new Set(
    [...els.logList.querySelectorAll("details[open][data-log-id]")].map(
      (node) => node.dataset.logId,
    ),
  );
  const rows = [...state.logs.values()].sort(compareLogsDesc);
  const visible = rows.slice(0, MAX_LOG_ROWS);
  const dropped = rows.length - visible.length;
  els.logList.replaceChildren(...visible.map(renderLog));
  for (const node of els.logList.querySelectorAll("details[data-log-id]")) {
    if (openIds.has(node.dataset.logId)) node.open = true;
  }
  const atCap = dropped > 0 || state.logs.size >= MAX_LOG_ROWS;
  els.loadMore.hidden = !state.hasMore || atCap;
  els.logLimitNote.hidden = !atCap;
  if (atCap) {
    els.logLimitNote.textContent =
      `已达渲染上限（${MAX_LOG_ROWS} 条）；更早的记录不会显示，可在「清理日志」里调整保留天数`;
  }

  if (!state.selectedTaskId) {
    els.logsEmpty.hidden = false;
    els.logsEmpty.textContent = "选择一个任务查看执行记录";
    return;
  }
  if (rows.length === 0) {
    els.logsEmpty.hidden = false;
    els.logsEmpty.textContent = "这个任务还没有执行记录。定时触发后会出现在这里。";
    return;
  }
  els.logsEmpty.hidden = true;

  // Report the real cost of the rebuild (DOM + layout). A slow render is
  // visible instead of silently freezing the panel.
  requestAnimationFrame(() => {
    const total = Math.round(performance.now() - started);
    if (total < SLOW_RENDER_MS) {
      els.logRenderHint.textContent = "";
      return;
    }
    els.logRenderHint.textContent = `渲染 ${visible.length} 条耗时 ${total} ms`;
  });
}

async function loadTasks({ silent = false } = {}) {
  // A drag owns the DOM: repainting the list mid-drag would throw the
  // dragged card away.
  if (state.dragging) return;
  try {
    const data = await api("/api/tasks");
    const tasks = data?.tasks ?? [];
    const now = Date.now();
    // `started` flips at the interval's local midnight without any DB write,
    // so it must be part of the signature: otherwise a "start tomorrow" card
    // keeps claiming "today still runs" after the pause has taken effect.
    const pauseState = tasks.map((task) => {
      const pause = pauseStateOf(task, now);
      return pause ? `${pause.until}:${pause.started ? 1 : 0}` : "0";
    });
    const signature = `${JSON.stringify(tasks)}#${pauseState.join(",")}`;
    state.tasks = tasks;

    let selectionChanged = false;
    if (!state.selectedTaskId && tasks.length > 0) {
      state.selectedTaskId = tasks[0].id;
      state.selectionEpoch += 1;
    }
    if (state.selectedTaskId && !tasks.some((task) => task.id === state.selectedTaskId)) {
      state.selectedTaskId = tasks[0]?.id ?? null;
      state.selectionEpoch += 1;
      state.logs.clear();
      state.oldestCursor = null;
      state.hasMore = false;
      selectionChanged = true;
    }

    if (signature !== state.tasksSignature) {
      state.tasksSignature = signature;
      renderTasks();
      if (selectionChanged) renderLogs();
    }
    if (!silent) setStatus(`${tasks.length} 个任务`);
  } catch (error) {
    if (!silent) setStatus(error.message, true);
  }
}

async function loadLogs({ reset = false, older = false } = {}) {
  const taskId = state.selectedTaskId;
  if (!taskId) {
    state.logs.clear();
    renderLogs();
    return;
  }

  // Responses for an older selection (A -> B -> A) must not be merged.
  const epoch = state.selectionEpoch;
  const list = els.logList;
  const nearTop = list.scrollTop < 80;
  const sizeBefore = state.logs.size;

  try {
    const pageSize = Number(state.clientConfig.logsPageSize) || 50;
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs?limit=${pageSize}`;
    if (older && state.oldestCursor !== null) {
      url += `&before=${state.oldestCursor.executedAt}:${state.oldestCursor.id}`;
    }
    const data = await api(url);
    if (epoch !== state.selectionEpoch || state.selectedTaskId !== taskId) return;

    const rows = data?.logs ?? [];

    if (reset) {
      state.logs.clear();
    }
    for (const row of rows) {
      state.logs.set(row.id, row);
    }

    // Keep the in-memory list bounded too: paging back through months of
    // history must not grow the tab without limit.
    const sorted = [...state.logs.values()].sort(compareLogsDesc);
    if (sorted.length > MAX_LOG_ROWS) {
      for (const stale of sorted.slice(MAX_LOG_ROWS)) {
        state.logs.delete(stale.id);
      }
    }

    // The cursor points at the oldest loaded row, in the same order the list
    // is rendered (execution time desc, id desc).
    const kept = [...state.logs.values()].sort(compareLogsDesc);
    const oldest = kept.length ? kept[kept.length - 1] : null;
    state.oldestCursor = oldest ? { executedAt: oldest.executed_at, id: oldest.id } : null;
    // `has_more` on a poll means "rows older than the NEWEST page", not "rows
    // older than our oldest loaded row". Trusting it during polling resurrects
    // "load older" after the user already paged to the bottom. Only requests
    // that advance the cursor (reset / older / first load) own this flag.
    if (reset || older || sizeBefore === 0) {
      state.hasMore = Boolean(data?.has_more);
    }
    // The server only ever answers inside the retention window.
    if (typeof data?.retention_days === "number") {
      state.logRetentionDays = data.retention_days;
    }

    const changed = reset || older || state.logs.size !== sizeBefore;
    if (!changed) return;

    renderLogs();
    if (reset) {
      list.scrollTop = 0;
    } else if (older) {
      // Older rows are appended below the current ones, so the viewport stays.
    } else if (nearTop) {
      list.scrollTop = 0;
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

function selectTask(taskId) {
  if (state.selectedTaskId === taskId) {
    loadLogs({ reset: true });
    return;
  }
  state.selectedTaskId = taskId;
  state.selectionEpoch += 1;
  state.logs.clear();
  state.oldestCursor = null;
  state.hasMore = false;
  renderTasks();
  els.logList.replaceChildren();
  els.logsEmpty.hidden = false;
  els.logsEmpty.textContent = "加载中…";
  els.loadMore.hidden = true;
  loadLogs({ reset: true });
}

/**
 * Fetch the run statistics and paint both the headline strip and the panel.
 * Failures are silent on purpose: the metrics are decorative, and a failing
 * statistics call must never disturb the task list.
 */
async function refreshMetrics() {
  try {
    const data = await api("/api/metrics");
    state.metrics = data;
    renderMetricsStrip(data);
    renderMetricsPanel(data);
  } catch {
    // Keep the last known numbers rather than blanking the strip.
  }
}

function formatRate(value) {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function renderMetricsStrip(data) {
  const overview = data?.overview;
  if (!overview) return;
  const item = (label, value, suffix = "") =>
    h("span", {}, `${label} `, h("strong", {}, String(value)), suffix);
  const parts = [
    item("今日", overview.today_runs, " 次"),
    item("近 7 天成功率", formatRate(overview.success_rate_7d)),
    item("均", formatDuration(overview.avg_duration_ms_7d)),
  ];
  if (overview.running > 0) parts.push(item("", overview.running, " 个执行中"));
  const children = [];
  parts.forEach((part, index) => {
    if (index > 0) children.push(document.createTextNode(" · "));
    children.push(part);
  });
  els.metricsStrip.replaceChildren(...children);
  els.metricsStrip.hidden = false;
}

function renderMetricsPanel(data) {
  const overview = data?.overview;
  if (!overview) return;
  els.metricsOverview.replaceChildren(
    ...[
      ["任务", `${overview.active} / ${overview.tasks}`],
      ["正在执行", String(overview.running)],
      ["今日执行", `${overview.today_runs} 次（成功 ${overview.today_ok}）`],
      ["近 7 天执行", `${overview.week_runs} 次`],
      ["近 7 天成功率", formatRate(overview.success_rate_7d)],
      ["近 7 天平均耗时", formatDuration(overview.avg_duration_ms_7d)],
    ].map(([label, value]) => h("div", {}, h("dt", {}, label), h("dd", {}, value))),
  );

  const nameOf = new Map(state.tasks.map((task) => [task.id, task.name]));
  const rows = (data.tasks ?? [])
    .filter((entry) => entry.runs > 0)
    .sort((a, b) => (b.success_rate ?? -1) - (a.success_rate ?? -1) || b.runs - a.runs);
  els.metricsEmpty.hidden = rows.length > 0;
  els.metricsTasks.replaceChildren(
    ...rows.map((entry) => {
      const last =
        entry.last_error !== null
          ? `失败：${entry.last_error}`
          : entry.last_status !== null
            ? `HTTP ${entry.last_status}`
            : entry.last_kind === "missed"
              ? "错过窗口"
              : "—";
      return h(
        "tr",
        {},
        h("td", { class: "name" }, nameOf.get(entry.task_id) ?? "（已删除）"),
        h("td", {}, String(entry.runs)),
        h("td", {}, formatRate(entry.success_rate)),
        h("td", {}, formatDuration(entry.avg_duration_ms)),
        h("td", {}, `${entry.last_executed_at ? formatTime(entry.last_executed_at) : "—"} · ${last}`),
      );
    }),
  );
}

function openMetricsDialog() {
  if (!els.metricsDialog.open) els.metricsDialog.showModal();
  void refreshMetrics();
}

async function refreshAll() {
  await loadTasks({ silent: true });
  if (state.selectedTaskId) {
    await loadLogs({ reset: false });
  }
}

function headersToText(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return Object.entries(parsed)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  } catch {
    return raw;
  }
}

function setEditMode(task) {
  state.editingId = task.id;
  els.formTitle.textContent = "编辑任务";
  els.submit.textContent = "保存修改";
  els.cancelEdit.hidden = false;
  els.editHint.hidden = false;
  showFormError("");

  els.name.value = task.name;
  const kind = scheduleKindOf(task);
  const kindRadio = document.querySelector(`input[name="schedule_kind"][value="${kind}"]`);
  if (kindRadio) kindRadio.checked = true;
  els.windowStart.value = task.window_start || "";
  els.windowEnd.value = task.window_end || "";
  if (kind === "daily") {
    const jitter = task.daily_jitter_minutes ?? 0;
    const exact = task.window_start === task.window_end;
    setDailyMode(!exact ? "range" : jitter > 0 ? "jitter" : "exact");
    if (exact) {
      els.exactTime.value = task.window_start;
      els.jitterMinutes.value = String(jitter > 0 ? jitter : 5);
    }
  }
  if (kind === "interval") {
    const seconds = Number(task.interval_seconds) || 60;
    const unit =
      seconds % 86400 === 0
        ? 86400
        : seconds % 3600 === 0
          ? 3600
          : seconds % 60 === 0
            ? 60
            : 1;
    els.intervalUnit.value = String(unit);
    els.intervalValue.value = String(Math.max(1, Math.round(seconds / unit)));
    els.intervalJitter.value = String(task.interval_jitter_seconds ?? 0);
    els.intervalStart.value =
      task.interval_start_at === null || task.interval_start_at === undefined
        ? ""
        : toDateTimeLocal(task.interval_start_at);
  } else {
    // A daily task has no anchor; leaving a previous value here would silently
    // travel into the task if the user switched to 循环执行 later.
    els.intervalStart.value = "";
  }
  syncSchedule();

  const useCurl = task.curl_command !== null;
  const modeInput = document.querySelector(`input[name="mode"][value="${useCurl ? "curl" : "structured"}"]`);
  if (modeInput) modeInput.checked = true;
  syncMode();
  els.curl.value = task.curl_command ?? "";
  els.url.value = task.request_url ?? "";
  const method = task.request_method ?? "GET";
  // The dropdown is a convenience list, not a whitelist: preserve an uncommon
  // method (e.g. OPTIONS) instead of letting `.value =` reset it to empty.
  if (!Array.from(els.method.options).some((option) => option.value === method)) {
    els.method.append(new Option(method, method));
  }
  els.method.value = method;
  els.headers.value = headersToText(task.request_headers);
  els.body.value = task.request_body ?? "";

  els.notifyEnabled.checked = task.notify_enabled === 1;
  syncNotify();
  els.notifyCurl.value = task.notify_curl_command ?? "";
  els.expectStatus.value = task.expect_status === null ? "" : String(task.expect_status);
  els.expectBody.value = task.expect_body ?? "";
  els.expectExpr.value = task.expect_expr ?? "";

  els.precheckEnabled.checked = task.precheck_enabled === 1;
  syncPrecheck();
  els.precheckCurl.value = precheckCurlFromTask(task);
  els.precheckStatus.value =
    task.precheck_expect_status === null || task.precheck_expect_status === undefined
      ? ""
      : String(task.precheck_expect_status);
  els.precheckExpr.value = task.precheck_expr ?? "";
  const storedWeekdays = task.precheck_weekdays
    ? task.precheck_weekdays
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
    : [];
  setCheckedWeekdays("precheck-weekdays", storedWeekdays);
  els.precheckTimeStart.value = task.precheck_time_start ?? "";
  els.precheckTimeEnd.value = task.precheck_time_end ?? "";
}

function clearEditMode() {
  state.editingId = null;
  els.formTitle.textContent = "新建任务";
  els.submit.textContent = "创建任务";
  els.cancelEdit.hidden = true;
  els.editHint.hidden = true;
}

function cancelEdit() {
  els.form.reset();
  clearEditMode();
  setDefaultWindow();
  syncMode();
  syncSchedule();
  syncNotify();
  syncPrecheck();
  showFormError("");
  setStatus("已取消编辑");
}

async function onCreate(event) {
  event.preventDefault();
  showFormError("");

  const name = els.name.value.trim();
  if (!name) {
    showFormError("请填写任务名称");
    return;
  }
  const scheduleKind = getScheduleKind();
  const mode = getMode();
  const payload = {
    name,
    schedule_kind: scheduleKind,
    mode,
    notify_enabled: els.notifyEnabled.checked,
    precheck_enabled: els.precheckEnabled.checked,
  };

  if (scheduleKind === "daily") {
    if (getDailyMode() === "range") {
      const windowStart = els.windowStart.value;
      const windowEnd = els.windowEnd.value;
      if (!windowStart || !windowEnd) {
        showFormError("请填写执行窗口");
        return;
      }
      if (windowStart === windowEnd) {
        showFormError("窗口起止时间不能相同；想要固定时刻请选「精确时间」");
        return;
      }
      payload.window_start = windowStart;
      payload.window_end = windowEnd;
    } else {
      const time = els.exactTime.value;
      if (!time) {
        showFormError("请选择每天的执行时间");
        return;
      }
      payload.window_start = time;
      payload.window_end = time;
      if (getDailyMode() === "jitter") {
        const jitter = Number(els.jitterMinutes.value);
        if (!Number.isInteger(jitter) || jitter < 0 || jitter > 60) {
          showFormError("浮动分钟必须是 0–60 的整数");
          return;
        }
        if (jitter > 0) payload.daily_jitter_minutes = jitter;
      }
    }
  } else if (scheduleKind === "interval") {
    const value = Number(els.intervalValue.value);
    const unit = Number(els.intervalUnit.value);
    if (!Number.isInteger(value) || value < 1) {
      showFormError("执行间隔必须是大于 0 的整数");
      return;
    }
    const seconds = value * unit;
    if (seconds > 30 * 24 * 3600) {
      showFormError("执行间隔不能超过 30 天");
      return;
    }
    const jitter = Number(els.intervalJitter.value || "0");
    if (!Number.isInteger(jitter) || jitter < 0) {
      showFormError("随机抖动必须是大于等于 0 的整数秒");
      return;
    }
    if (jitter > seconds) {
      showFormError("随机抖动不能大于执行间隔");
      return;
    }
    payload.interval_seconds = seconds;
    payload.interval_jitter_seconds = jitter;
    const startAt = fromDateTimeLocal(els.intervalStart.value);
    if (startAt !== null) payload.interval_start_at = startAt;
  }

  if (payload.precheck_enabled) {
    const days = checkedWeekdays("precheck-weekdays");
    if (days.length > 0) payload.precheck_weekdays = days;

    const timeStart = els.precheckTimeStart.value;
    const timeEnd = els.precheckTimeEnd.value;
    if ((timeStart && !timeEnd) || (!timeStart && timeEnd)) {
      showFormError("执行时段需要同时填写开始和结束时间");
      return;
    }
    if (timeStart && timeEnd) {
      if (timeStart === timeEnd) {
        showFormError("执行时段的开始和结束时间不能相同");
        return;
      }
      payload.precheck_time_start = timeStart;
      payload.precheck_time_end = timeEnd;
    }

    const precheckCurl = els.precheckCurl.value.trim();
    if (precheckCurl) payload.precheck_curl = precheckCurl;

    const rawPreStatus = els.precheckStatus.value.trim();
    let preStatus = null;
    if (rawPreStatus !== "") {
      preStatus = Number(rawPreStatus);
      if (!Number.isInteger(preStatus) || preStatus < 100 || preStatus > 599) {
        showFormError("前置判断的期望状态码必须是 100–599 的整数");
        return;
      }
    }
    const preExpr = els.precheckExpr.value.trim();
    if (!precheckCurl && (preStatus !== null || preExpr)) {
      showFormError("配置了前置状态码或表达式时，必须填写前置判断 curl");
      return;
    }
    if (preStatus !== null) payload.precheck_expect_status = preStatus;
    if (preExpr) payload.precheck_expr = preExpr;

    if (days.length === 0 && !timeStart && !precheckCurl) {
      showFormError("启用执行前判断时，至少配置执行星期、执行时段或前置 curl 之一");
      return;
    }
  }

  if (mode === "curl") {
    const curl = els.curl.value.trim();
    if (!curl) {
      showFormError("请粘贴 curl 命令");
      return;
    }
    payload.curl = curl;
  } else {
    const url = els.url.value.trim();
    if (!url) {
      showFormError("请填写 URL");
      return;
    }
    payload.url = url;
    payload.method = els.method.value;
    payload.headers = els.headers.value;
    if (els.body.value !== "") payload.body = els.body.value;
  }

  if (payload.notify_enabled) {
    const notifyCurl = els.notifyCurl.value.trim();
    if (!notifyCurl) {
      showFormError("请填写通知 curl");
      return;
    }
    payload.notify_curl = notifyCurl;
  }

  // Success conditions are saved regardless of notifications.
  const rawStatus = els.expectStatus.value.trim();
  if (rawStatus !== "") {
    const status = Number(rawStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      showFormError("期望状态码必须是 100–599 的整数");
      return;
    }
    payload.expect_status = status;
  }
  if (els.expectBody.value !== "") payload.expect_body = els.expectBody.value;
  if (els.expectExpr.value.trim() !== "") payload.expect_expr = els.expectExpr.value.trim();

  const editingId = state.editingId;
  els.submit.disabled = true;
  try {
    const data = await api(editingId ? `/api/tasks/${encodeURIComponent(editingId)}` : "/api/tasks", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    els.form.reset();
    clearEditMode();
    setDefaultWindow();
    syncMode();
    syncSchedule();
    syncNotify();
    syncPrecheck();
    const savedMessage = !editingId
      ? `已创建任务「${data.task.name}」`
      : data.task.status === "active"
        ? `已保存任务「${data.task.name}」，继续按新配置定时`
        : `已保存任务「${data.task.name}」，任务仍保持停止；如需定时请点恢复`;
    setStatus(savedMessage);
    await loadTasks({ silent: true });
    selectTask(data.task.id);
  } catch (error) {
    showFormError(error.message);
  } finally {
    els.submit.disabled = false;
  }
}

async function onTaskAction(button) {
  const card = button.closest(".task-card");
  if (!card) return;
  const taskId = card.dataset.id;
  const action = button.dataset.action;
  const task = state.tasks.find((entry) => entry.id === taskId);
  const wasPaused = task ? pauseStateOf(task) !== null : false;
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    setStatus(
      action === "stop" ? "任务已停止" : wasPaused ? "已取消暂停，任务恢复调度" : "任务已恢复",
    );
    await loadTasks({ silent: true });
    if (state.selectedTaskId === taskId) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await loadLogs({ reset: true });
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function onRunNow(button) {
  const card = button.closest(".task-card");
  if (!card) return;
  const taskId = card.dataset.id;
  const task = state.tasks.find((entry) => entry.id === taskId);
  const name = task?.name ?? "任务";
  if (
    !window.confirm(
      `立即执行任务「${name}」？

会真实发送请求；命中成功条件时还会发送通知 curl，并写入执行记录。`,
    )
  ) {
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "执行中…";
  // A run may legitimately take a while (tasks can have no timeout); give the
  // UI a generous cap while still surfacing a stuck request.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
      signal: controller.signal,
    });
    const parts = [
      data.skipped ? `任务「${name}」被前置判断跳过` : `任务「${name}」已执行一次`,
    ];
    if (!data.skipped && data.status !== null) parts.push(`HTTP ${data.status}`);
    if (data.error) parts.push(data.error);
    else if (data.matched) parts.push(data.notifySent ? "命中并发通知" : "命中条件");
    else parts.push("未命中条件");
    if (!data.skipped) parts.push(`${data.durationMs} ms`);
    setStatus(parts.join(" · "), Boolean(data.error));
    await loadTasks({ silent: true });
    if (state.selectedTaskId === taskId) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await loadLogs({ reset: true });
    }
  } catch (error) {
    // The 60s cap is a CLIENT-side abort: the server keeps running the task.
    // Say so, otherwise the user assumes the run failed and retries.
    const timedOut = error?.message?.includes("请求超时");
    setStatus(
      timedOut
        ? `任务「${name}」超过 60 秒未返回，已断开等待；后台可能仍在执行，稍后刷新执行记录查看`
        : error.message,
      true,
    );
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function setCleanupView(view) {
  state.cleanup.view = view;
  els.cleanupLoading.hidden = view !== "loading";
  els.cleanupErrorWrap.hidden = view !== "error";
  els.cleanupContent.hidden = view !== "content";
  els.cleanupRunning.hidden = view !== "running";
  els.cleanupResult.hidden = view !== "result";

  const busy = view === "running";
  els.cleanupCancel.disabled = busy;
  els.cleanupClose.disabled = busy;
  els.cleanupExecute.hidden = view === "result";
  els.cleanupCancel.textContent = view === "result" ? "关闭" : "取消";
  els.cleanupExecute.textContent = busy ? "清理中…" : "执行清理";
  if (view === "content") {
    updateCleanupExecute();
  } else {
    els.cleanupExecute.disabled = true;
  }
}

function showCleanupError(message) {
  els.cleanupError.textContent = message || "清理失败";
  setCleanupView("error");
}

function updateCleanupExecute() {
  const preview = state.cleanup.preview;
  const selected = state.cleanup.selected;
  if (!preview || selected === null || selected === undefined) {
    els.cleanupExecute.disabled = true;
    return;
  }
  const count =
    selected === "all"
      ? preview.all.count
      : (preview.options.find((option) => option.days === selected)?.count ?? 0);
  const confirmed =
    selected === "all"
      ? els.cleanupAllInput.value.trim() === "删除全部"
      : els.cleanupConfirm.checked;
  els.cleanupExecute.disabled = state.cleanup.busy || count === 0 || !confirmed;
}

function updateCleanupSelection() {
  const preview = state.cleanup.preview;
  const selected = state.cleanup.selected;
  const isAll = selected === "all";
  els.cleanupAllWarning.hidden = !isAll;
  els.cleanupConfirmWrap.hidden = isAll;
  els.cleanupAllInputWrap.hidden = !isAll;

  if (!preview || selected === null || selected === undefined) {
    els.cleanupImpact.textContent = "请选择一个清理范围。";
    updateCleanupExecute();
    return;
  }

  const option = isAll
    ? preview.all
    : preview.options.find((entry) => entry.days === selected);
  const count = Number(option?.count ?? 0);
  const bytes = Number(option?.bytes ?? 0);
  if (isAll) {
    els.cleanupImpact.textContent = `将删除全部 ${count} 条日志（约 ${formatBytes(bytes)}），清理后日志表为空。`;
  } else {
    const remaining = Math.max(0, preview.total_count - count);
    els.cleanupImpact.textContent = `将删除 ${count} 条日志（约 ${formatBytes(bytes)}），保留 ${remaining} 条较新的日志。`;
  }
  updateCleanupExecute();
}

function renderCleanupPreview(data) {
  const storage = data.storage ?? {};
  els.usageDb.textContent = formatBytes(storage.db_bytes);
  els.usageWal.textContent = formatBytes(storage.wal_bytes);
  els.usageTotal.textContent = formatBytes(storage.total_bytes);
  els.usageCount.textContent = `${data.total_count} 条`;

  els.cleanupRange.textContent =
    data.oldest_executed_at && data.newest_executed_at
      ? `日志时间范围：${formatTime(data.oldest_executed_at)} → ${formatTime(data.newest_executed_at)}。按 executed_at 判断，不保留每个任务的最近记录。`
      : "当前没有可统计的日志时间范围。";

  const options = [
    ...data.options,
    { days: "all", label: "全部清除", count: data.all.count, bytes: data.all.bytes, danger: true },
  ];

  const inputs = new Map();
  const nodes = options.map((option) => {
    const isAll = option.days === "all";
    const count = Number(option.count) || 0;
    const input = h("input", {
      type: "radio",
      name: "cleanup-option",
      value: String(option.days),
      disabled: count === 0,
      onchange: () => {
        state.cleanup.selected = isAll ? "all" : Number(option.days);
        els.cleanupConfirm.checked = false;
        els.cleanupAllInput.value = "";
        updateCleanupSelection();
      },
    });
    inputs.set(option.days, input);
    return h(
      "label",
      { class: `cleanup-option${isAll ? " is-danger" : ""}` },
      input,
      h("span", { class: "cleanup-option-label" }, isAll ? option.label : `保留最近 ${option.label}`),
      h(
        "span",
        { class: "cleanup-option-impact" },
        count === 0 ? "无匹配日志" : `删除 ${count} 条 · 约 ${formatBytes(option.bytes)}`,
      ),
    );
  });

  const legend = h("legend", {}, "选择保留范围（按执行时间 executed_at 判断）");
  els.cleanupOptions.replaceChildren(legend, ...nodes);

  const firstAvailable = options.find((option) => option.days !== "all" && Number(option.count) > 0);
  state.cleanup.selected = firstAvailable ? firstAvailable.days : null;
  if (firstAvailable) {
    const input = inputs.get(firstAvailable.days);
    if (input) input.checked = true;
  }

  els.cleanupEmpty.hidden = data.total_count > 0;
  updateCleanupSelection();
}

async function loadCleanupPreview() {
  state.cleanup.preview = null;
  state.cleanup.selected = null;
  setCleanupView("loading");
  try {
    const data = await api("/api/logs/cleanup/preview");
    if (!els.cleanupDialog.open) return;
    state.cleanup.preview = data;
    renderCleanupPreview(data);
    setCleanupView("content");
  } catch (error) {
    if (!els.cleanupDialog.open) return;
    showCleanupError(`统计失败：${error.message}`);
  }
}

async function openCleanup() {
  state.cleanup = { preview: null, selected: null, busy: false, view: "loading" };
  els.cleanupConfirm.checked = false;
  els.cleanupAllInput.value = "";
  els.cleanupImpact.textContent = "";
  els.cleanupResult.replaceChildren();
  if (!els.cleanupDialog.open) els.cleanupDialog.showModal();
  setCleanupView("loading");
  await loadCleanupPreview();
  await syncRetentionControl();
}

/** Show the retention window that is actually in force, and allow changing it. */
async function syncRetentionControl() {
  try {
    const config = await api("/api/config");
    const days = Number(config?.logRetentionDays ?? 0);
    state.logRetentionDays = days;
    for (const select of [els.retentionDays, els.retentionDays2]) {
      if (!select) continue;
      const option = [...select.options].find((entry) => Number(entry.value) === days);
      if (option) select.value = option.value;
    }
    const note = `当前生效：只显示最近 ${days} 天的日志；更早的记录不查询、不渲染，并在后台巡检中被删除（每轮最多 5000 条）。`;
    const unlimited = "当前生效：不限制保留天数，日志会一直保留（记录仍分页加载，不会一次渲染全部）。";
    els.retentionNote.textContent = days > 0 ? note : unlimited;
    els.retentionNote2.textContent = days > 0 ? note : unlimited;
  } catch {
    // The dialog still works without the hint.
  }
}

async function saveRetention(days) {
  els.retentionSave.disabled = true;
  els.retentionSave2.disabled = true;
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ logRetentionDays: days }),
    });
    state.logRetentionDays = days;
    await syncRetentionControl();
    setStatus(days > 0 ? `已设置保留最近 ${days} 天的日志` : "已取消日志保留期限");
    // The visible window changed: reload the list so it matches.
    if (state.selectedTaskId) await loadLogs({ reset: true });
    await loadTasks({ silent: true });
    renderLogMeta();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    els.retentionSave.disabled = false;
    els.retentionSave2.disabled = false;
  }
}

function closeCleanup() {
  if (els.cleanupDialog.open) els.cleanupDialog.close();
}

function renderCleanupResult(result) {
  const before = result.storage_before ?? {};
  const after = result.storage_after ?? {};
  const rows = [
    ["删除条数", `${result.deleted} 条`],
    ["剩余条数", `${result.remaining} 条`],
    ["释放空间", formatBytes(result.reclaimed_bytes)],
    ["合计占用", `${formatBytes(before.total_bytes)} → ${formatBytes(after.total_bytes)}`],
    ["数据库文件", `${formatBytes(before.db_bytes)} → ${formatBytes(after.db_bytes)}`],
    ["WAL 文件", `${formatBytes(before.wal_bytes)} → ${formatBytes(after.wal_bytes)}`],
  ];
  const children = [
    h("p", { class: "cleanup-result-title" }, `清理完成：已删除 ${result.deleted} 条日志`),
    h(
      "dl",
      { class: "cleanup-usage" },
      ...rows.map(([label, value]) => h("div", {}, h("dt", {}, label), h("dd", {}, value))),
    ),
  ];
  if (result.vacuum_error) {
    children.push(
      h(
        "div",
        { class: "cleanup-warning" },
        `空间回收未完成：${result.vacuum_error}。日志行已删除，但数据库文件可能没有缩小。`,
      ),
    );
  }
  els.cleanupResult.replaceChildren(...children);
}

async function executeCleanup() {
  const preview = state.cleanup.preview;
  const selected = state.cleanup.selected;
  if (!preview || selected === null || selected === undefined) return;

  state.cleanup.busy = true;
  setCleanupView("running");
  try {
    const selectedOption = preview.options.find((entry) => entry.days === selected);
    const body =
      selected === "all"
        ? { all: true, confirm: "DELETE_ALL" }
        : {
            days: selected,
            confirm: true,
            // Delete exactly what the preview counted: the backend must not
            // recompute a newer cutoff while the dialog was open.
            ...(Number.isInteger(selectedOption?.cutoff)
              ? { cutoff: selectedOption.cutoff }
              : {}),
          };
    const result = await api("/api/logs/cleanup", {
      method: "POST",
      body: JSON.stringify(body),
      // VACUUM on a large database can take minutes; the default 15s poll
      // timeout must not cut this request short.
      signal: AbortSignal.timeout(600_000),
    });
    state.cleanup.busy = false;
    renderCleanupResult(result);
    setCleanupView("result");

    state.logs.clear();
    state.oldestCursor = null;
    state.hasMore = false;
    await loadTasks({ silent: true });
    if (state.selectedTaskId) {
      await loadLogs({ reset: true });
    } else {
      renderLogs();
    }
    setStatus(`已删除 ${result.deleted} 条日志，释放 ${formatBytes(result.reclaimed_bytes)}`);
  } catch (error) {
    state.cleanup.busy = false;
    const timedOut = error?.message?.includes("请求超时");
    showCleanupError(
      timedOut
        ? "清理请求超时断开：后台可能仍在压缩数据库，稍后刷新查看占用空间再确认是否需要重试。"
        : `清理失败：${error.message}`,
    );
  }
}

function initPauseDays() {
  const options = [];
  for (let days = 1; days <= MAX_PAUSE_DAYS; days += 1) {
    options.push(h("option", { value: String(days) }, `${days} 天`));
  }
  els.pauseDays.replaceChildren(...options);
  els.pauseDays.value = "1";
}

function pauseStartsToday() {
  return document.querySelector('input[name="pause-start"]:checked')?.value === "today";
}

function pauseInterval(days, startsToday) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + (startsToday ? 0 : 1));
  const until = new Date(from.getTime());
  until.setDate(until.getDate() + days);
  return { from: from.getTime(), until: until.getTime() };
}

function updatePauseSummary() {
  const task = state.tasks.find((entry) => entry.id === state.pause.taskId);
  if (!task) {
    els.pauseSummary.textContent = "";
    return;
  }
  const days = Number(els.pauseDays.value);
  const startsToday = pauseStartsToday();
  const { from, until } = pauseInterval(days, startsToday);
  const covered = days === 1 ? formatDay(from) : `${formatDay(from)}–${formatDay(until - 1)}`;
  const lead = startsToday
    ? "今天起算：今天剩余时间（含尚未到达的窗口）一律不再触发，不管现在是几点。"
    : "明天起算：今天剩余时间照常执行，今天已排好的任务不会被取消。";
  els.pauseSummary.textContent =
    `${lead}暂停 ${days} 个完整自然日（${covered}）；` +
    `${formatTime(until)} 恢复，之后按「${formatSchedule(task)}」继续执行。`;
}

function openPauseDialog(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  state.pause.taskId = taskId;
  state.pause.busy = false;
  els.pauseError.hidden = true;
  els.pauseError.textContent = "";

  const current = pauseStateOf(task);
  if (current) {
    // "调整暂停" must open on the CURRENT interval. Otherwise submitting
    // without touching anything silently shortens the pause to 1 day.
    const days = Math.min(
      MAX_PAUSE_DAYS,
      Math.max(1, calendarDays(current.from, current.until)),
    );
    els.pauseDays.value = String(days);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startsToday = current.from <= today.getTime();
    const radio = document.querySelector(
      `input[name="pause-start"][value="${startsToday ? "today" : "tomorrow"}"]`,
    );
    if (radio) radio.checked = true;
    els.pauseTask.textContent =
      `任务「${task.name}」 · 当前 ${formatDay(current.from)} 起暂停，${formatDay(current.until)} 恢复`;
    state.pause.label = "保存调整";
  } else {
    els.pauseDays.value = "1";
    const tomorrow = document.querySelector('input[name="pause-start"][value="tomorrow"]');
    if (tomorrow) tomorrow.checked = true;
    els.pauseTask.textContent = `任务「${task.name}」`;
    state.pause.label = "暂停任务";
  }

  els.pauseConfirm.disabled = false;
  els.pauseConfirm.textContent = state.pause.label;
  updatePauseSummary();
  if (!els.pauseDialog.open) els.pauseDialog.showModal();
}

function closePauseDialog() {
  if (state.pause.busy) return;
  if (els.pauseDialog.open) els.pauseDialog.close();
}

async function executePause() {
  const task = state.tasks.find((entry) => entry.id === state.pause.taskId);
  if (!task || state.pause.busy) return;
  const days = Number(els.pauseDays.value);
  const startsToday = pauseStartsToday();
  state.pause.busy = true;
  els.pauseConfirm.disabled = true;
  els.pauseConfirm.textContent = "暂停中…";
  els.pauseError.hidden = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/pause`, {
      method: "POST",
      body: JSON.stringify({ days, starts_today: startsToday }),
    });
    state.pause.busy = false;
    if (els.pauseDialog.open) els.pauseDialog.close();
    setStatus(
      state.pause.label === "保存调整"
        ? `任务「${task.name}」的暂停已调整为 ${days} 天`
        : `任务「${task.name}」已暂停 ${days} 天`,
    );
    await loadTasks({ silent: true });
    if (state.selectedTaskId === task.id) await loadLogs({ reset: false });
  } catch (error) {
    state.pause.busy = false;
    els.pauseConfirm.disabled = false;
    els.pauseConfirm.textContent = state.pause.label;
    els.pauseError.textContent = error.message;
    els.pauseError.hidden = false;
  }
}

function openDeleteDialog(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  state.deleting.taskId = taskId;
  state.deleting.name = task.name;
  state.deleting.busy = false;
  els.deleteTask.textContent = `任务「${task.name}」及其全部历史日志将被永久删除。`;
  els.deleteNameHint.textContent = task.name;
  els.deleteConfirmInput.value = "";
  els.deleteError.hidden = true;
  els.deleteError.textContent = "";
  els.deleteConfirm.disabled = true;
  els.deleteConfirm.textContent = "确认删除";
  if (!els.deleteDialog.open) els.deleteDialog.showModal();
  els.deleteConfirmInput.focus();
}

function closeDeleteDialog() {
  if (state.deleting.busy) return;
  if (els.deleteDialog.open) els.deleteDialog.close();
}

function updateDeleteConfirm() {
  if (state.deleting.busy) return;
  els.deleteConfirm.disabled = els.deleteConfirmInput.value.trim() !== state.deleting.name.trim();
}

async function executeDelete() {
  const taskId = state.deleting.taskId;
  const name = state.deleting.name;
  if (!taskId || state.deleting.busy) return;
  if (els.deleteConfirmInput.value.trim() !== name.trim()) return;

  state.deleting.busy = true;
  els.deleteConfirm.disabled = true;
  els.deleteCancel.disabled = true;
  els.deleteConfirm.textContent = "删除中…";
  els.deleteError.hidden = true;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    state.deleting.busy = false;
    if (els.deleteDialog.open) els.deleteDialog.close();
    setStatus(`已删除任务「${name}」及其 ${data?.deleted_logs ?? 0} 条日志`);
    if (state.editingId === taskId) clearEditMode();
    if (state.selectedTaskId === taskId) {
      state.selectedTaskId = null;
      state.selectionEpoch += 1;
      state.logs.clear();
      state.oldestCursor = null;
      state.hasMore = false;
    }
    await loadTasks({ silent: true });
    loadLogs({ reset: true });
  } catch (error) {
    state.deleting.busy = false;
    els.deleteCancel.disabled = false;
    els.deleteConfirm.disabled = false;
    els.deleteConfirm.textContent = "确认删除";
    els.deleteError.textContent = error.message;
    els.deleteError.hidden = false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function requestToCurl(method, url, headersJson, body) {
  const parts = [`curl -X ${method} ${shellQuote(url)}`];
  if (headersJson) {
    try {
      const parsed = JSON.parse(headersJson);
      for (const [name, value] of Object.entries(parsed)) {
        parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
      }
    } catch {
      // Keep the parts we already have.
    }
  }
  if (body) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(" \\\n  ");
}

/** Reconstruct curl text for tasks created through the structured form. */
function curlFromTask(task) {
  if (task.curl_command) return task.curl_command;
  return requestToCurl(
    task.request_method,
    task.request_url,
    task.request_headers,
    task.request_body,
  );
}

function precheckCurlFromTask(task) {
  if (task.precheck_curl_command) return task.precheck_curl_command;
  if (!task.precheck_url) return "";
  return requestToCurl(
    task.precheck_method ?? "GET",
    task.precheck_url,
    task.precheck_headers,
    task.precheck_body,
  );
}

/**
 * The curl a "test now" would run for the CURRENT form. In structured mode the
 * task will be saved from URL/headers/body, so the test must use the same
 * fields instead of an empty curl box.
 */
function formCurl() {
  const direct = els.curl.value.trim();
  if (getMode() === "curl") return direct;
  const url = els.url.value.trim();
  if (!url) return direct;
  const headers = {};
  for (const line of els.headers.value.split("\n")) {
    const trimmed = line.trim();
    const index = trimmed.indexOf(":");
    if (index > 0) headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return requestToCurl(
    els.method.value,
    url,
    Object.keys(headers).length > 0 ? JSON.stringify(headers) : null,
    els.body.value || null,
  );
}

function syncTestPrecheck() {
  els.testPrecheckFields.hidden = !els.testPrecheckEnabled.checked;
}

function syncTestNotify() {
  els.testNotifyFields.hidden = !els.testNotifyEnabled.checked;
}

/**
 * Open the test bench. With a task it previews that task's real configuration;
 * without one it takes whatever the create form currently holds, so "try it
 * before saving" needs no copy-paste.
 */
function openTestDialog(task = null) {
  state.testing.busy = false;
  state.testing.taskId = task ? task.id : null;
  els.testSend.disabled = false;
  els.testSend.textContent = "开始测试";
  els.testError.hidden = true;
  els.testError.textContent = "";
  els.testResult.hidden = true;
  els.testSteps.replaceChildren();
  els.testSendNotify.checked = false;

  if (task) {
    els.testCurl.value = curlFromTask(task);
    els.testPrecheckEnabled.checked = task.precheck_enabled === 1;
    els.testPrecheckCurl.value = precheckCurlFromTask(task);
    els.testPrecheckStatus.value =
      task.precheck_expect_status === null || task.precheck_expect_status === undefined
        ? ""
        : String(task.precheck_expect_status);
    els.testPrecheckExpr.value = task.precheck_expr ?? "";
    setCheckedWeekdays(
      "test-precheck-weekdays",
      task.precheck_weekdays
        ? task.precheck_weekdays
            .split(",")
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value))
        : [],
    );
    els.testPrecheckTimeStart.value = task.precheck_time_start ?? "";
    els.testPrecheckTimeEnd.value = task.precheck_time_end ?? "";
    els.testExpectStatus.value =
      task.expect_status === null || task.expect_status === undefined
        ? ""
        : String(task.expect_status);
    els.testExpectExpr.value = task.expect_expr ?? "";
    els.testExpectBody.value = task.expect_body ?? "";
    els.testNotifyEnabled.checked = task.notify_enabled === 1;
    els.testNotifyCurl.value = task.notify_curl_command ?? "";
  } else {
    els.testCurl.value = formCurl();
    els.testPrecheckEnabled.checked = els.precheckEnabled.checked;
    els.testPrecheckCurl.value = els.precheckCurl.value.trim();
    els.testPrecheckStatus.value = els.precheckStatus.value;
    els.testPrecheckExpr.value = els.precheckExpr.value.trim();
    setCheckedWeekdays("test-precheck-weekdays", checkedWeekdays("precheck-weekdays"));
    els.testPrecheckTimeStart.value = els.precheckTimeStart.value;
    els.testPrecheckTimeEnd.value = els.precheckTimeEnd.value;
    els.testExpectStatus.value = els.expectStatus.value;
    els.testExpectExpr.value = els.expectExpr.value.trim();
    els.testExpectBody.value = els.expectBody.value;
    els.testNotifyEnabled.checked = els.notifyEnabled.checked;
    els.testNotifyCurl.value = els.notifyCurl.value.trim();
  }

  syncTestPrecheck();
  syncTestNotify();
  if (!els.testDialog.open) els.testDialog.showModal();
  void loadTestHistory(state.testing.taskId);
  if (!els.testCurl.value.trim()) els.testCurl.focus();
}

function closeTestDialog() {
  if (state.testing.busy) return;
  if (els.testDialog.open) els.testDialog.close();
}

const TEST_STATUS_META = {
  ok: { label: "通过", cls: "status-ok", step: "is-ok" },
  fail: { label: "失败", cls: "status-err", step: "is-fail" },
  skip: { label: "跳过", cls: "status-warn", step: "is-skip" },
  info: { label: "提示", cls: "status-muted", step: "is-info" },
};

function renderTestStep(step, index) {
  const meta = TEST_STATUS_META[step.status] ?? TEST_STATUS_META.info;
  const card = h(
    "li",
    { class: `test-step ${meta.step}` },
    h(
      "div",
      { class: "test-step-head" },
      h("span", { class: "test-step-index" }, String(index + 1)),
      h("span", { class: "test-step-title" }, step.title),
      h("span", { class: `badge ${meta.cls}` }, meta.label),
      step.durationMs !== null && step.durationMs !== undefined
        ? h("span", { class: "muted" }, `${step.durationMs} ms`)
        : null,
    ),
    h("div", { class: "test-step-detail" }, step.detail ?? ""),
  );

  if (step.request || step.response) {
    const details = h("details", {});
    details.append(h("summary", {}, "请求 / 响应详情"));
    const body = h("div", { class: "detail" });
    if (step.request) {
      addDetail(body, "请求", `${step.request.method} ${step.request.url}`);
      const requestHeaders = Object.entries(step.request.headers ?? {})
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      addDetail(body, "请求头", requestHeaders);
      if (step.request.body !== null && step.request.body !== undefined) {
        addDetail(body, "请求体", step.request.body === "" ? "（空）" : step.request.body);
      }
    }
    if (step.response) {
      addDetail(
        body,
        "响应状态",
        step.response.status === null ? "无响应" : String(step.response.status),
      );
      const responseHeaders = step.response.headers
        ? Object.entries(step.response.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join("\n")
        : "";
      addDetail(body, "响应头", responseHeaders);
      addDetail(
        body,
        "响应体",
        step.response.body ? prettyJson(step.response.body) : "（空）",
      );
      if (step.response.truncated) {
        body.append(h("div", { class: "muted" }, "响应体超过上限，已截断"));
      }
    }
    if (!body.childElementCount) body.append(h("div", { class: "muted" }, "没有可显示的详情"));
    details.append(body);
    card.append(details);
  }

  return card;
}

function renderTestResult(result) {
  const summary = result.summary ?? {};
  let label = "未命中成功条件";
  let cls = "status-warn";
  if (summary.skipped) {
    label = "前置判断未通过，本次跳过";
    cls = "status-warn";
  } else if (summary.matched) {
    label = summary.notifySent ? "命中成功条件并发通知" : "命中成功条件";
    cls = "status-ok";
  } else if (summary.error) {
    label = "执行失败";
    cls = "status-err";
  }

  els.testSummary.className = `badge ${cls}`;
  els.testSummary.textContent = label;
  els.testTotal.textContent = `总耗时 ${summary.totalMs ?? 0} ms`;
  els.testSteps.replaceChildren(
    ...(result.steps ?? []).map((step, index) => renderTestStep(step, index)),
  );
  els.testResult.hidden = false;
  // The dialog body scrolls; make sure the freshly rendered timeline is visible.
  requestAnimationFrame(() => {
    els.testResult.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

async function loadTestHistory(taskId) {
  if (!taskId) {
    els.testHistory.hidden = true;
    els.testHistoryList.replaceChildren();
    return;
  }
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(taskId)}/test-runs`);
    const runs = data.runs ?? [];
    if (!runs.length) {
      els.testHistory.hidden = true;
      els.testHistoryList.replaceChildren();
      return;
    }
    els.testHistory.hidden = false;
    els.testHistoryList.replaceChildren(
      ...runs.map((run) =>
        h(
          "button",
          {
            class: `test-history-item ${run.ok ? "is-ok" : "is-fail"}`,
            type: "button",
            title: "点击查看这次的步骤",
            onclick: () => showTestRun(run.id),
          },
          `${formatShortTime(run.created_at)} ${run.ok ? "命中" : "未命中"}`,
        ),
      ),
    );
  } catch {
    els.testHistory.hidden = true;
  }
}

async function showTestRun(id) {
  try {
    const data = await api(`/api/test-runs/${encodeURIComponent(id)}`);
    const run = data.run;
    if (!run || !Array.isArray(run.steps)) return;
    renderTestResult({ steps: run.steps, summary: run.summary ?? {} });
    setStatus(`查看 ${formatTime(run.created_at)} 的测试记录`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

/** Copy the test dialog's configuration back into the task form. */
function applyTestToForm() {
  document.querySelector('input[name="mode"][value="curl"]').click();
  els.curl.value = els.testCurl.value.trim();

  els.precheckEnabled.checked = els.testPrecheckEnabled.checked;
  syncPrecheck();
  els.precheckCurl.value = els.testPrecheckCurl.value.trim();
  els.precheckStatus.value = els.testPrecheckStatus.value;
  els.precheckExpr.value = els.testPrecheckExpr.value;
  setCheckedWeekdays("precheck-weekdays", checkedWeekdays("test-precheck-weekdays"));
  els.precheckTimeStart.value = els.testPrecheckTimeStart.value;
  els.precheckTimeEnd.value = els.testPrecheckTimeEnd.value;

  els.expectStatus.value = els.testExpectStatus.value;
  els.expectExpr.value = els.testExpectExpr.value;
  els.expectBody.value = els.testExpectBody.value;

  els.notifyEnabled.checked = els.testNotifyEnabled.checked;
  syncNotify();
  els.notifyCurl.value = els.testNotifyCurl.value.trim();
}

/**
 * "用这份配置建任务": copy the tested configuration into the form, name it when
 * empty, and submit through the normal create path so validation, messages and
 * scheduling stay exactly the same as a manual create.
 */
async function saveTestAsTask() {
  if (state.testing.busy) return;
  if (!els.testCurl.value.trim()) {
    els.testError.textContent = "请先填写并测试主请求 curl";
    els.testError.hidden = false;
    return;
  }
  applyTestToForm();

  // Editing an existing task: never create a second one behind the user's back.
  if (state.editingId) {
    els.testDialog.close();
    els.form.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("已把测试配置带入正在编辑的任务，确认后点「保存修改」");
    return;
  }

  if (!els.name.value.trim()) {
    els.name.value = `测试任务 ${formatShortTime(Date.now())}`;
  }
  els.testDialog.close();
  await onCreate(new Event("submit"));
}

async function sendTest() {
  if (state.testing.busy) return;
  const curl = els.testCurl.value.trim();
  if (!curl) {
    els.testError.textContent = "请粘贴主请求 curl";
    els.testError.hidden = false;
    els.testCurl.focus();
    return;
  }

  const payload = {
    curl,
    precheck_enabled: els.testPrecheckEnabled.checked,
    notify_enabled: els.testNotifyEnabled.checked,
    send_notify: els.testSendNotify.checked,
  };
  if (state.testing.taskId) payload.task_id = state.testing.taskId;

  if (payload.precheck_enabled) {
    const days = checkedWeekdays("test-precheck-weekdays");
    if (days.length > 0) payload.precheck_weekdays = days;

    const timeStart = els.testPrecheckTimeStart.value;
    const timeEnd = els.testPrecheckTimeEnd.value;
    if ((timeStart && !timeEnd) || (!timeStart && timeEnd)) {
      els.testError.textContent = "执行时段需要同时填写开始和结束时间";
      els.testError.hidden = false;
      return;
    }
    if (timeStart && timeEnd) {
      if (timeStart === timeEnd) {
        els.testError.textContent = "执行时段的开始和结束时间不能相同";
        els.testError.hidden = false;
        return;
      }
      payload.precheck_time_start = timeStart;
      payload.precheck_time_end = timeEnd;
    }

    const precheckCurl = els.testPrecheckCurl.value.trim();
    if (precheckCurl) payload.precheck_curl = precheckCurl;

    const rawStatus = els.testPrecheckStatus.value.trim();
    const rawExpr = els.testPrecheckExpr.value.trim();
    if (!precheckCurl && (rawStatus !== "" || rawExpr !== "")) {
      els.testError.textContent = "配置了前置状态码或表达式时，必须填写前置判断 curl";
      els.testError.hidden = false;
      return;
    }
    if (rawStatus !== "") payload.precheck_expect_status = Number(rawStatus);
    if (rawExpr !== "") payload.precheck_expr = rawExpr;

    if (days.length === 0 && !timeStart && !precheckCurl) {
      els.testError.textContent = "启用执行前判断时，至少配置执行星期、执行时段或前置 curl 之一";
      els.testError.hidden = false;
      return;
    }
  }
  if (els.testExpectStatus.value.trim() !== "") {
    payload.expect_status = Number(els.testExpectStatus.value);
  }
  if (els.testExpectBody.value !== "") payload.expect_body = els.testExpectBody.value;
  if (els.testExpectExpr.value.trim() !== "") payload.expect_expr = els.testExpectExpr.value.trim();
  if (payload.notify_enabled) {
    const notifyCurl = els.testNotifyCurl.value.trim();
    if (!notifyCurl) {
      els.testError.textContent = "请填写通知 curl";
      els.testError.hidden = false;
      return;
    }
    payload.notify_curl = notifyCurl;
  }

  state.testing.busy = true;
  els.testSend.disabled = true;
  els.testSend.textContent = "测试中…";
  els.testError.hidden = true;
  els.testError.textContent = "";
  els.testResult.hidden = true;
  // The chain can run up to three requests; give it a generous cap.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100_000);
  try {
    const data = await api("/api/test/run", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    renderTestResult(data.result ?? { steps: [], summary: {} });
    if (state.testing.taskId) void loadTestHistory(state.testing.taskId);
    setStatus(`测试完成：${els.testSummary.textContent}`);
  } catch (error) {
    els.testError.textContent = error.message;
    els.testError.hidden = false;
    els.testResult.hidden = true;
    setStatus(error.message, true);
  } finally {
    clearTimeout(timeout);
    state.testing.busy = false;
    els.testSend.disabled = false;
    els.testSend.textContent = "开始测试";
  }
}

function bindEvents() {
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", syncMode);
  });
  document.querySelectorAll('input[name="schedule_kind"]').forEach((radio) => {
    radio.addEventListener("change", syncSchedule);
  });
  document.querySelectorAll('input[name="daily_mode"]').forEach((radio) => {
    radio.addEventListener("change", syncDailyMode);
  });
  // Any schedule field change refreshes the "next 7 runs" preview.
  [
    els.windowStart,
    els.windowEnd,
    els.exactTime,
    els.jitterMinutes,
    els.intervalValue,
    els.intervalUnit,
    els.intervalJitter,
    els.intervalStart,
  ].forEach((input) => {
    input.addEventListener("input", schedulePreview);
    input.addEventListener("change", schedulePreview);
  });
  els.notifyEnabled.addEventListener("change", syncNotify);
  els.precheckEnabled.addEventListener("change", syncPrecheck);
  els.form.addEventListener("submit", onCreate);
  els.cancelEdit.addEventListener("click", cancelEdit);

  els.refreshTasks.addEventListener("click", async () => {
    await loadTasks();
    if (state.selectedTaskId) await loadLogs({ reset: true });
  });
  els.refreshLogs.addEventListener("click", () => loadLogs({ reset: true }));
  els.loadMore.addEventListener("click", () => loadLogs({ older: true }));

  els.openCleanup.addEventListener("click", openCleanup);
  els.retentionSave.addEventListener("click", () => void saveRetention(Number(els.retentionDays.value)));
  els.retentionSave2.addEventListener("click", () => void saveRetention(Number(els.retentionDays2.value)));
  els.openSettings.addEventListener("click", () => void openSettings());
  els.settingsClose.addEventListener("click", () => els.settingsDialog.close());
  els.swAutostart.addEventListener("change", () => void toggleAutostart(els.swAutostart.checked));
  els.swCheckUpdate.addEventListener("click", () => void checkUpdate());
  document.addEventListener("click", (event) => {
    if (event.target.closest(".task-more")) return;
    document.querySelectorAll("details.task-more[open]").forEach((node) => {
      node.open = false;
    });
  });
  els.swApplyUpdate.addEventListener("click", () => void applyUpdate());
  els.swUpdateRetry.addEventListener("click", () => void applyUpdate());
  els.swQuit.addEventListener("click", () => void quitApp());
  els.backupCreate.addEventListener("click", () => void createBackupSnapshot());
  els.backupImport.addEventListener("click", pickBackupFile);
  els.backupFile.addEventListener("change", (event) => void uploadBackupFile(event));
  els.cleanupClose.addEventListener("click", closeCleanup);
  els.cleanupCancel.addEventListener("click", closeCleanup);
  els.cleanupExecute.addEventListener("click", executeCleanup);
  els.cleanupRetry.addEventListener("click", () => loadCleanupPreview());
  els.cleanupConfirm.addEventListener("change", updateCleanupExecute);
  els.cleanupAllInput.addEventListener("input", updateCleanupExecute);
  els.cleanupDialog.addEventListener("cancel", (event) => {
    if (state.cleanup.busy) event.preventDefault();
  });
  els.cleanupDialog.addEventListener("close", () => {
    state.cleanup.busy = false;
  });

  document.querySelectorAll('input[name="pause-start"]').forEach((radio) => {
    radio.addEventListener("change", updatePauseSummary);
  });
  els.pauseDays.addEventListener("change", updatePauseSummary);
  els.pauseConfirm.addEventListener("click", executePause);
  els.pauseClose.addEventListener("click", closePauseDialog);
  els.pauseCancel.addEventListener("click", closePauseDialog);
  els.pauseDialog.addEventListener("cancel", (event) => {
    if (state.pause.busy) event.preventDefault();
  });
  els.pauseDialog.addEventListener("close", () => {
    state.pause.busy = false;
  });

  els.deleteConfirmInput.addEventListener("input", updateDeleteConfirm);
  els.deleteConfirm.addEventListener("click", executeDelete);
  els.deleteClose.addEventListener("click", closeDeleteDialog);
  els.deleteCancel.addEventListener("click", closeDeleteDialog);
  els.deleteDialog.addEventListener("cancel", (event) => {
    if (state.deleting.busy) event.preventDefault();
  });
  els.deleteDialog.addEventListener("close", () => {
    state.deleting.busy = false;
    els.deleteCancel.disabled = false;
  });

  els.openTestCurl.addEventListener("click", () => openTestDialog());
  els.openTestGlobal.addEventListener("click", () => openTestDialog());
  els.openMetrics.addEventListener("click", openMetricsDialog);
  els.metricsClose.addEventListener("click", () => els.metricsDialog.close());
  els.testSave.addEventListener("click", saveTestAsTask);
  els.testSend.addEventListener("click", sendTest);
  els.testClose.addEventListener("click", closeTestDialog);
  els.testCancel.addEventListener("click", closeTestDialog);
  els.testPrecheckEnabled.addEventListener("change", syncTestPrecheck);
  els.testNotifyEnabled.addEventListener("change", syncTestNotify);
  els.testDialog.addEventListener("cancel", (event) => {
    if (state.testing.busy) event.preventDefault();
  });

  els.taskList.addEventListener("click", async (event) => {
    const card = event.target.closest(".task-card");
    if (!card) return;
    // A drag ends with a click event on the handle: it must not select the
    // task or open anything.
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (button) {
      event.stopPropagation();
      if (button.dataset.action === "pause") {
        openPauseDialog(card.dataset.id);
      } else if (button.dataset.action === "delete") {
        openDeleteDialog(card.dataset.id);
      } else if (button.dataset.action === "run") {
        onRunNow(button);
      } else if (button.dataset.action === "test") {
        const task = state.tasks.find((entry) => entry.id === card.dataset.id);
        if (task) {
          // The test bench needs the full request/precheck config, which the
          // list view does not carry.
          button.disabled = true;
          try {
            const data = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
            openTestDialog(data?.task ?? null);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        }
      } else if (button.dataset.action === "edit") {
        const task = state.tasks.find((entry) => entry.id === card.dataset.id);
        if (task) {
          if (state.editingId && state.editingId !== task.id && !window.confirm("切换编辑目标会丢弃当前未保存的修改，继续吗？")) {
            return;
          }
          // The list only carries the card fields; the form needs the bodies.
          button.disabled = true;
          try {
            const data = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
            if (!data?.task) return;
            setEditMode(data.task);
            els.form.scrollIntoView({ behavior: "smooth", block: "start" });
            setStatus(`正在编辑任务「${task.name}」`);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        }
      } else {
        onTaskAction(button);
      }
      return;
    }
    selectTask(card.dataset.id);
  });

  els.taskList.addEventListener("keydown", (event) => {
    // The drag handle also moves a task with the arrow keys, so the list can
    // be reordered without a pointer.
    const handle = event.target.closest("[data-drag-handle]");
    if (handle && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const card = handle.closest(".task-card");
      if (!card) return;
      event.preventDefault();
      void moveTaskByKeyboard(card.dataset.id, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("button")) return;
    const card = event.target.closest(".task-card");
    if (card) {
      event.preventDefault();
      selectTask(card.dataset.id);
    }
  });

  els.taskList.addEventListener("pointerdown", onPointerDown);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll();
  });
}

function startPolling() {
  const configured = Number(state.clientConfig.pollIntervalMs);
  const delay = Number.isFinite(configured) && configured >= 500 ? configured : 4000;
  setInterval(async () => {
    if (document.hidden || state.polling || state.cleanup.busy) return;
    state.polling = true;
    try {
      await loadTasks({ silent: true });
      if (state.selectedTaskId) await loadLogs({ reset: false });
    } finally {
      state.polling = false;
    }
  }, delay);
  // A one-second ticker for the "执行中" badges: they must keep counting even
  // when the poll finds nothing new, otherwise a hanging request looks idle.
  setInterval(tickRunningBadges, 1000);
  // Statistics change slowly: poll them less often than the task list.
  setInterval(() => {
    if (!document.hidden) void refreshMetrics();
  }, 15000);
}

async function init() {
  syncMode();
  syncSchedule();
  syncNotify();
  syncPrecheck();
  initPauseDays();
  bindEvents();
  setStatus("加载中…");
  await loadClientConfig();
  setDefaultWindow();
  await loadTasks();
  void loadSystemInfo();
  void refreshMetrics();
  if (state.selectedTaskId) {
    await loadLogs({ reset: true });
  } else {
    renderLogs();
  }
  startPolling();
}

init();
