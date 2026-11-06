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
};

const LOG_LIMIT = 50;

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
  const end = new Date(now.getTime() + 5 * 60_000);
  els.windowStart.value = hhmm(now);
  els.windowEnd.value = hhmm(end);
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

function renderTaskCard(task) {
  const cross = task.window_end < task.window_start;
  const active = task.status === "active";
  const conditions = [];
  if (task.expect_status !== null) conditions.push(`状态=${task.expect_status}`);
  if (task.expect_body !== null) conditions.push("响应体相等");
  if (!conditions.length) conditions.push("任意 2xx");

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
              class: `badge ${active ? "badge-active" : "badge-stopped"}`,
            },
            active ? "运行中" : "已停止",
          ),
          cross ? h("span", { class: "badge badge-cross" }, "跨午夜") : null,
          h("span", {}, `窗口 ${task.window_start}–${task.window_end}`),
        ),
      ),
      h(
        "div",
        { class: "task-actions" },
        active
          ? h("button", { class: "btn btn-danger", type: "button", dataset: { action: "stop" } }, "停止")
          : h("button", { class: "btn", type: "button", dataset: { action: "resume" } }, "恢复"),
      ),
    ),
    h("div", { class: "task-request" }, `${task.request_method} ${task.request_url}`),
    h(
      "div",
      { class: "task-extra" },
      active ? `下次执行：${formatTime(task.next_run_at)}` : `已停止，历史日志保留`,
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
    const signature = JSON.stringify(tasks);
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
    let url = `/api/tasks/${encodeURIComponent(taskId)}/logs?limit=${LOG_LIMIT}`;
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
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    setStatus(action === "stop" ? "任务已停止" : "任务已恢复");
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

  els.taskList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) {
      event.stopPropagation();
      onTaskAction(button);
      return;
    }
    const card = event.target.closest(".task-card");
    if (card) selectTask(card.dataset.id);
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
  setInterval(async () => {
    if (document.hidden || state.polling) return;
    state.polling = true;
    try {
      await loadTasks({ silent: true });
      if (state.selectedTaskId) await loadLogs({ reset: false });
    } finally {
      state.polling = false;
    }
  }, 4000);
}

async function init() {
  setDefaultWindow();
  syncMode();
  syncNotify();
  bindEvents();
  setStatus("加载中…");
  await loadTasks();
  if (state.selectedTaskId) {
    await loadLogs({ reset: true });
  } else {
    renderLogs();
  }
  startPolling();
}

init();
