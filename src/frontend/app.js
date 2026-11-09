const els = {
  statusLine: document.getElementById("status-line"),
  taskList: document.getElementById("task-list"),
  tasksEmpty: document.getElementById("tasks-empty"),
  form: document.getElementById("create-form"),
  name: document.getElementById("name"),
  windowStart: document.getElementById("window-start"),
  windowEnd: document.getElementById("window-end"),
  curl: document.getElementById("curl"),
  curlWrap: document.getElementById("curl-wrap"),
  structuredWrap: document.getElementById("structured-wrap"),
  url: document.getElementById("url"),
  method: document.getElementById("method"),
  headers: document.getElementById("headers"),
  body: document.getElementById("body"),
  notifyEnabled: document.getElementById("notify-enabled"),
  notifyFields: document.getElementById("notify-fields"),
  notifyCurl: document.getElementById("notify-curl"),
  expectStatus: document.getElementById("expect-status"),
  expectBody: document.getElementById("expect-body"),
  formError: document.getElementById("form-error"),
  submit: document.getElementById("submit"),
  logsTitle: document.getElementById("logs-title"),
  logsTaskMeta: document.getElementById("logs-task-meta"),
  logList: document.getElementById("log-list"),
  logsEmpty: document.getElementById("logs-empty"),
  loadMore: document.getElementById("load-more"),
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
};

const MAX_PAUSE_DAYS = 15;

const CLIENT_CONFIG_DEFAULTS = {
  logsPageSize: 50,
  defaultWindowMinutes: 5,
  pollIntervalMs: 4000,
  logBodyLimitBytes: 100 * 1024,
};

const state = {
  tasks: [],
  tasksSignature: "",
  selectedTaskId: null,
  selectionEpoch: 0,
  logs: new Map(),
  oldestId: null,
  hasMore: false,
  polling: false,
  statusTimer: null,
  clientConfig: { ...CLIENT_CONFIG_DEFAULTS },
  cleanup: { preview: null, selected: null, busy: false, view: "loading" },
  pause: { taskId: null, busy: false },
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

function formatDay(timestamp) {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A deadline in the past means the pause is already over. */
function isPaused(task, now = Date.now()) {
  return (
    task.paused_until !== null &&
    task.paused_until !== undefined &&
    task.paused_until > now
  );
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
  const response = await fetch(path, init);
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

function setDefaultWindow() {
  const now = new Date();
  const configured = Number(state.clientConfig.defaultWindowMinutes);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 5;
  const end = new Date(now.getTime() + minutes * 60_000);
  els.windowStart.value = hhmm(now);
  els.windowEnd.value = hhmm(end);
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
    els.logsTaskMeta.textContent = `${formatWindow(current)} · 下次 ${formatTime(current.next_run_at)}`;
  } else {
    els.logsTitle.textContent = "执行记录";
    els.logsTaskMeta.textContent = "";
  }
}

function formatTimeout(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const seconds = value / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function renderTaskCard(task) {
  const cross = task.window_end < task.window_start;
  const active = task.status === "active";
  const paused = active && isPaused(task);
  const conditions = [];
  if (task.expect_status !== null) conditions.push(`状态=${task.expect_status}`);
  if (task.expect_body !== null) conditions.push("响应体相等");
  if (!conditions.length) conditions.push("任意 2xx");

  let requestOptions = {};
  try {
    requestOptions = task.request_options ? JSON.parse(task.request_options) : {};
  } catch {
    requestOptions = {};
  }

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
      { class: "task-top" },
      h(
        "div",
        { style: "min-width:0" },
        h("h3", { class: "task-name" }, task.name),
        h(
          "div",
          { class: "task-meta" },
          h(
            "span",
            {
              class: `badge ${
                active ? (paused ? "badge-paused" : "badge-active") : "badge-stopped"
              }`,
            },
            active
              ? paused
                ? `暂停至 ${formatDay(task.paused_until)}`
                : "运行中"
              : "已停止",
          ),
          cross ? h("span", { class: "badge badge-cross" }, "跨午夜") : null,
          requestOptions.insecure
            ? h("span", { class: "badge badge-insecure" }, "跳过 TLS 校验")
            : null,
          requestOptions.timeoutMs
            ? h(
                "span",
                { class: "badge badge-timeout" },
                `超时 ${formatTimeout(requestOptions.timeoutMs)}`,
              )
            : null,
          h("span", {}, `窗口 ${task.window_start}–${task.window_end}`),
        ),
      ),
      h(
        "div",
        { class: "task-actions" },
        active
          ? paused
            ? h("button", { class: "btn", type: "button", dataset: { action: "resume" } }, "取消暂停")
            : h("button", { class: "btn", type: "button", dataset: { action: "pause" } }, "暂停")
          : null,
        active
          ? h("button", { class: "btn btn-danger", type: "button", dataset: { action: "stop" } }, "停止")
          : h("button", { class: "btn", type: "button", dataset: { action: "resume" } }, "恢复"),
      ),
    ),
    h("div", { class: "task-request" }, `${task.request_method} ${task.request_url}`),
    h(
      "div",
      { class: "task-extra" },
      active
        ? paused
          ? `已暂停至 ${formatTime(task.paused_until)}，期间不会执行；恢复后下次执行：${formatTime(task.next_run_at)}`
          : `下次执行：${formatTime(task.next_run_at)}`
        : `已停止，历史日志保留`,
    ),
    h(
      "div",
      { class: "task-extra" },
      task.notify_enabled
        ? `成功通知：已开启（${conditions.join(" 且 ")}）`
        : "成功通知：未开启",
    ),
  );

  return card;
}

function kindLabel(kind) {
  if (kind === "notify") return "通知";
  if (kind === "missed") return "错过";
  return "任务";
}

function statusInfo(log) {
  if (log.kind === "missed") return { text: "未执行", cls: "status-warn" };
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

  const details = h("details");
  details.append(h("summary", {}, "请求 / 响应详情"));
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
  details.append(body);
  card.append(details);

  return card;
}

function renderLogs() {
  const rows = [...state.logs.values()].sort((a, b) => a.id - b.id);
  els.logList.replaceChildren(...rows.map(renderLog));
  els.loadMore.hidden = !state.hasMore;

  if (!state.selectedTaskId) {
    els.logsEmpty.hidden = false;
    els.logsEmpty.textContent = "选择一个任务查看执行记录";
    return;
  }
  if (rows.length === 0) {
    els.logsEmpty.hidden = false;
    els.logsEmpty.textContent = "这个任务还没有执行记录。窗口触发后会出现在这里。";
    return;
  }
  els.logsEmpty.hidden = true;
}

async function loadTasks({ silent = false } = {}) {
  try {
    const data = await api("/api/tasks");
    const tasks = data?.tasks ?? [];
    const now = Date.now();
    const pauseState = tasks.map((task) => (isPaused(task, now) ? task.paused_until : 0));
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
      state.oldestId = null;
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
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const previousHeight = list.scrollHeight;
  const sizeBefore = state.logs.size;

  try {
    const pageSize = Number(state.clientConfig.logsPageSize) || 50;
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs?limit=${pageSize}`;
    if (older && state.oldestId !== null) {
      url += `&before=${state.oldestId}`;
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

    const ids = [...state.logs.keys()];
    state.oldestId = ids.length ? Math.min(...ids) : null;
    if (reset || older) {
      state.hasMore = Boolean(data?.has_more);
    } else if (sizeBefore === 0) {
      state.hasMore = Boolean(data?.has_more);
    }

    const changed = reset || older || state.logs.size !== sizeBefore;
    if (!changed) return;

    renderLogs();
    if (reset) {
      list.scrollTop = list.scrollHeight;
    } else if (older) {
      list.scrollTop += list.scrollHeight - previousHeight;
    } else if (nearBottom) {
      list.scrollTop = list.scrollHeight;
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
  state.oldestId = null;
  state.hasMore = false;
  renderTasks();
  els.logList.replaceChildren();
  els.logsEmpty.hidden = false;
  els.logsEmpty.textContent = "加载中…";
  els.loadMore.hidden = true;
  loadLogs({ reset: true });
}

async function refreshAll() {
  await loadTasks({ silent: true });
  if (state.selectedTaskId) {
    await loadLogs({ reset: false });
  }
}

async function onCreate(event) {
  event.preventDefault();
  showFormError("");

  const name = els.name.value.trim();
  if (!name) {
    showFormError("请填写任务名称");
    return;
  }
  const windowStart = els.windowStart.value;
  const windowEnd = els.windowEnd.value;
  if (!windowStart || !windowEnd) {
    showFormError("请填写执行窗口");
    return;
  }
  if (windowStart === windowEnd) {
    showFormError("窗口起止时间不能相同");
    return;
  }

  const mode = getMode();
  const payload = {
    name,
    window_start: windowStart,
    window_end: windowEnd,
    mode,
    notify_enabled: els.notifyEnabled.checked,
  };

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

    const rawStatus = els.expectStatus.value.trim();
    if (rawStatus !== "") {
      const status = Number(rawStatus);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        showFormError("期望状态码必须是 100–599 的整数");
        return;
      }
      payload.expect_status = status;
    }
    if (els.expectBody.value !== "") {
      payload.expect_body = els.expectBody.value;
    }
  }

  els.submit.disabled = true;
  try {
    const data = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.form.reset();
    setDefaultWindow();
    syncMode();
    syncNotify();
    setStatus(`已创建任务「${data.task.name}」`);
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
  const wasPaused = task ? isPaused(task) : false;
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
    const body =
      selected === "all"
        ? { all: true, confirm: "DELETE_ALL" }
        : { days: selected, confirm: true };
    const result = await api("/api/logs/cleanup", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.cleanup.busy = false;
    renderCleanupResult(result);
    setCleanupView("result");

    state.logs.clear();
    state.oldestId = null;
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
    showCleanupError(`清理失败：${error.message}`);
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

function pauseResumeAt(days, startsToday) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + (startsToday ? 0 : 1) + days);
  return date.getTime();
}

function updatePauseSummary() {
  const task = state.tasks.find((entry) => entry.id === state.pause.taskId);
  if (!task) {
    els.pauseSummary.textContent = "";
    return;
  }
  const days = Number(els.pauseDays.value);
  const startsToday = pauseStartsToday();
  const resumeAt = pauseResumeAt(days, startsToday);
  els.pauseSummary.textContent =
    `将从 ${formatTime(resumeAt)} 起恢复调度（${startsToday ? "今天" : "明天"}起算 ${days} 天）。` +
    `暂停期间不会执行，恢复当天在窗口 ${task.window_start}–${task.window_end} 内随机执行一次。`;
}

function openPauseDialog(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  state.pause.taskId = taskId;
  state.pause.busy = false;
  els.pauseTask.textContent = `任务「${task.name}」`;
  els.pauseError.hidden = true;
  els.pauseError.textContent = "";
  els.pauseDays.value = "1";
  const tomorrow = document.querySelector('input[name="pause-start"][value="tomorrow"]');
  if (tomorrow) tomorrow.checked = true;
  els.pauseConfirm.disabled = false;
  els.pauseConfirm.textContent = "暂停任务";
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
    setStatus(`任务「${task.name}」已暂停 ${days} 天`);
    await loadTasks({ silent: true });
    if (state.selectedTaskId === task.id) await loadLogs({ reset: false });
  } catch (error) {
    state.pause.busy = false;
    els.pauseConfirm.disabled = false;
    els.pauseConfirm.textContent = "暂停任务";
    els.pauseError.textContent = error.message;
    els.pauseError.hidden = false;
  }
}

function bindEvents() {
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", syncMode);
  });
  els.notifyEnabled.addEventListener("change", syncNotify);
  els.form.addEventListener("submit", onCreate);

  els.refreshTasks.addEventListener("click", async () => {
    await loadTasks();
    if (state.selectedTaskId) await loadLogs({ reset: true });
  });
  els.refreshLogs.addEventListener("click", () => loadLogs({ reset: true }));
  els.loadMore.addEventListener("click", () => loadLogs({ older: true }));

  els.openCleanup.addEventListener("click", openCleanup);
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

  els.taskList.addEventListener("click", (event) => {
    const card = event.target.closest(".task-card");
    if (!card) return;
    const button = event.target.closest("button[data-action]");
    if (button) {
      event.stopPropagation();
      if (button.dataset.action === "pause") {
        openPauseDialog(card.dataset.id);
      } else {
        onTaskAction(button);
      }
      return;
    }
    selectTask(card.dataset.id);
  });

  els.taskList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("button")) return;
    const card = event.target.closest(".task-card");
    if (card) {
      event.preventDefault();
      selectTask(card.dataset.id);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll();
  });
}

function startPolling() {
  const configured = Number(state.clientConfig.pollIntervalMs);
  const delay = Number.isFinite(configured) && configured >= 500 ? configured : 4000;
  setInterval(async () => {
    if (document.hidden || state.polling) return;
    state.polling = true;
    try {
      await loadTasks({ silent: true });
      if (state.selectedTaskId) await loadLogs({ reset: false });
    } finally {
      state.polling = false;
    }
  }, delay);
}

async function init() {
  syncMode();
  syncNotify();
  initPauseDays();
  bindEvents();
  setStatus("加载中…");
  await loadClientConfig();
  setDefaultWindow();
  await loadTasks();
  if (state.selectedTaskId) {
    await loadLogs({ reset: true });
  } else {
    renderLogs();
  }
  startPolling();
}

init();
