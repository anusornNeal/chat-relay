let csrf = "";
let currentUser = null;
let activeView = "overview";
let liveSocket = null;
let reconnectTimer = null;
let fallbackStartTimer = null;
let fallbackPollTimer = null;
let heartbeatTimer = null;
let lastPongAt = 0;
let liveRefreshTimer = null;
let reconnectAttempt = 0;
let socketEverOpened = false;
let refreshRunning = false;
let refreshQueued = false;
const pendingLiveTopics = new Set();
const agentNameCache = new Map();
let pendingDeleteUser = null;
let dashboardPeriod = null;
let adminUsersCache = [];
const PAGE_SIZE = 50;
let callFilters = { userId: "", status: "", query: "", activityId: "", from: "", to: "", drilldown: false };
const callPaging = { cursor: "", stack: [], nextCursor: null };
const errorPaging = { cursor: "", stack: [], nextCursor: null };
let runningClockTimer = null;

const BKK_TZ = "Asia/Bangkok";
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtNum = (v) => new Intl.NumberFormat("en-US").format(Number(v || 0));
const fmtMs = (v) => Number(v || 0) >= 1000 ? (Number(v) / 1000).toFixed(1) + "s" : Math.round(Number(v || 0)) + " ms";
const fmtPct = (v) => ((Number(v || 0)) * 100).toFixed(1) + "%";
const bkkTime = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(iso));
const bkkHourMinute = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));
const elapsedClock = (iso) => {
  const total = Math.max(0, Math.floor((Date.now() - Date.parse(iso || "")) / 1000));
  if (!Number.isFinite(total)) return "--:--";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
};
function updateRunningTimers() {
  document.querySelectorAll("[data-running-start]").forEach((node) => {
    node.textContent = elapsedClock(node.dataset.runningStart);
  });
}
function ensureRunningClock() {
  if (!document.querySelector("[data-running-start]")) {
    clearInterval(runningClockTimer);
    runningClockTimer = null;
    return;
  }
  if (!runningClockTimer) runningClockTimer = setInterval(updateRunningTimers, 1000);
  updateRunningTimers();
}

const ICONS = {
  overview: '<path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/>',
  activity: '<path d="M4 12h3l2-6 4 12 2-6h5"/><path d="M3 4v16h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0 1.7 5"/><path d="M20 4v7h-7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5"/>',
};
function icon(name, cls = "") {
  return '<svg class="icon ' + cls + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.info) + "</svg>";
}

const humanTool = (tool) => ({
  terminal_exec: "One-shot command",
  terminal_start: "Command session",
  terminal_start_shell: "Interactive shell",
  terminal_batch_start: "Terminal batch",
  terminal_read: "Session output",
  terminal_write: "Session input",
  terminal_kill: "End session",
  read_file: "Read source file",
  read_multiple_files: "Read source files",
  list_directory: "List directory",
  start_search: "Search files",
  write_file: "Write file",
  edit_block: "Edit file",
  screenshot: "Capture desktop",
  keyboard_input: "Keyboard input",
  mouse_click: "Mouse input",
}[tool] || String(tool || "").replaceAll("_", " "));

const detailRecords = new Map();
let detailSeq = 0;
const SAFE_DETAIL_KEYS = [
  "userId", "tool", "agentId", "activityId", "toolCallId", "timestamp", "startedAt",
  "durationMs", "status", "statusCode", "exitCode", "errorClass", "errorSource", "errorCode",
  "failureStage", "retryable", "agentName", "requestBytes", "responseBytes", "ok",
  "workerOverheadMs", "relayRoundTripMs", "transportMs", "agentQueueWaitMs", "agentHandlerMs",
];
function registerDetail(event) {
  const safe = {};
  for (const key of SAFE_DETAIL_KEYS) if (event?.[key] !== undefined) safe[key] = event[key];
  const id = "detail-" + (++detailSeq);
  detailRecords.set(id, safe);
  return id;
}
function activityLabel(value) {
  const id = String(value || "");
  if (!id) return "Single call";
  if (id.startsWith("call_")) return "Call " + id.slice(5, 13).toUpperCase();
  if (id.startsWith("act_")) return "Activity " + id.slice(-8).toUpperCase();
  return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-5) : id;
}
function showDetail(id, title = "Safe metadata") {
  const data = detailRecords.get(id);
  if (!data) return;
  $("detailTitle").textContent = title;
  const rows = Object.entries(data).map(([key, value]) =>
    '<div class="detail-row"><span class="detail-key">' + esc(key) + '</span><strong class="' + (key.endsWith("Id") ? "mono" : "") + '">' + esc(value) + "</strong></div>"
  ).join("");
  const related = data.activityId
    ? '<div class="detail-actions"><button id="detailRelated" class="button subtle" type="button">' + icon("activity") + "View related tool calls</button></div>"
    : "";
  $("detailBody").innerHTML = rows + related;
  const relatedButton = $("detailRelated");
  if (relatedButton) relatedButton.onclick = async () => {
    $("detailDialog").close();
    callFilters.activityId = String(data.activityId || "");
    resetCallPaging();
    activeView = "calls";
    renderNav();
    showLoading();
    await loadCalls({ patch: false });
  };
  $("detailDialog").showModal();
}
function bindDetailRows() {
  document.querySelectorAll("[data-detail-id]").forEach((row) => {
    row.tabIndex = 0;
    row.onclick = (event) => {
      if (event.target.closest("button,select,input,a")) return;
      showDetail(row.dataset.detailId, row.dataset.detailTitle || "Safe metadata");
    };
    row.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showDetail(row.dataset.detailId, row.dataset.detailTitle || "Safe metadata");
      }
    };
  });
}
function bindTableFilter(inputId) {
  const input = $(inputId);
  if (!input) return;
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll("[data-filter-row]").forEach((row) => {
      row.hidden = Boolean(q && !row.textContent.toLowerCase().includes(q));
    });
  };
  input.oninput();
}

function liveNodeKey(node) {
  if (!(node instanceof Element)) return "";
  return node.id || node.getAttribute("data-live-key") || node.getAttribute("data-chart-from") || "";
}
function sameLiveNode(current, next) {
  if (current.nodeType !== next.nodeType) return false;
  if (current.nodeType !== Node.ELEMENT_NODE) return true;
  if (current.tagName !== next.tagName) return false;
  const currentKey = liveNodeKey(current);
  const nextKey = liveNodeKey(next);
  return !currentKey || !nextKey || currentKey === nextKey;
}
function syncLiveAttributes(current, next) {
  const preserveControl = current instanceof HTMLInputElement || current instanceof HTMLSelectElement || current instanceof HTMLTextAreaElement;
  for (const attr of [...current.attributes]) {
    if (preserveControl && ["value", "checked", "selected"].includes(attr.name)) continue;
    if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
  for (const attr of [...next.attributes]) {
    if (preserveControl && ["value", "checked", "selected"].includes(attr.name)) continue;
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
}
function patchLiveNode(current, next) {
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return current;
  }
  if (!sameLiveNode(current, next)) {
    const replacement = next.cloneNode(true);
    current.replaceWith(replacement);
    return replacement;
  }
  if (!(current instanceof Element) || !(next instanceof Element)) return current;

  const preserveValue = current instanceof HTMLInputElement || current instanceof HTMLSelectElement || current instanceof HTMLTextAreaElement;
  const controlValue = preserveValue ? current.value : null;
  const selectionStart = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement ? current.selectionStart : null;
  const selectionEnd = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement ? current.selectionEnd : null;
  syncLiveAttributes(current, next);

  const nextChildren = [...next.childNodes];
  let index = 0;
  while (index < nextChildren.length || index < current.childNodes.length) {
    const existing = current.childNodes[index];
    const desired = nextChildren[index];
    if (!desired) {
      existing?.remove();
      continue;
    }
    if (!existing) {
      current.appendChild(desired.cloneNode(true));
      index += 1;
      continue;
    }
    if (!sameLiveNode(existing, desired) && desired instanceof Element) {
      const desiredKey = liveNodeKey(desired);
      if (desiredKey) {
        const match = [...current.childNodes].slice(index + 1).find((node) => node instanceof Element && liveNodeKey(node) === desiredKey);
        if (match) current.insertBefore(match, existing);
      }
    }
    patchLiveNode(current.childNodes[index], desired);
    index += 1;
  }

  if (preserveValue && controlValue !== null) {
    current.value = controlValue;
    if ((current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement) && document.activeElement === current && selectionStart !== null) {
      try { current.setSelectionRange(selectionStart, selectionEnd ?? selectionStart); } catch {}
    }
  }
  return current;
}
function renderContent(markup, patch = false) {
  const content = $("content");
  if (!patch || !content.firstChild) {
    content.innerHTML = markup;
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = markup;
  const desired = [...template.content.childNodes];
  let index = 0;
  while (index < desired.length || index < content.childNodes.length) {
    const existing = content.childNodes[index];
    const next = desired[index];
    if (!next) {
      existing?.remove();
      continue;
    }
    if (!existing) {
      content.appendChild(next.cloneNode(true));
      index += 1;
      continue;
    }
    patchLiveNode(existing, next);
    index += 1;
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== "GET") {
    headers["content-type"] = "application/json";
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (response.status === 401) {
    signOutUi("Session expired. Sign in again.");
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}

function signOutUi(message = "") {
  stopLiveChannel();
  csrf = "";
  currentUser = null;
  dashboardPeriod = null;
  $("appView").hidden = true;
  $("loginView").hidden = false;
  $("loginError").textContent = message;
}
function setNotice(message = "", error = false) {
  const node = $("notice");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("notice-error", Boolean(error));
}
function touchFreshness() { $("freshness").textContent = "Updated just now"; }
function setLiveState(state) {
  const node = $("liveStatus");
  if (!node) return;
  const labels = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", fallback: "Fallback" };
  node.textContent = labels[state] || labels.connecting;
  node.className = "live-pill " + state;
  node.title = state === "live" ? "Receiving realtime dashboard events over WebSocket" : state === "fallback" ? "WebSocket unavailable; using temporary fallback refresh" : "Realtime connection is being restored";
}
function isAdmin() { return currentUser?.admin === true; }

function navItems() {
  return isAdmin()
    ? [["overview", "Overview", "overview"], ["calls", "Tool Calls", "activity"], ["users", "Users", "users"], ["errors", "Errors", "alert"]]
    : [["overview", "My Overview", "overview"], ["calls", "My Tool Calls", "activity"]];
}
function renderNav() {
  $("nav").innerHTML = navItems().map(([id, label, glyph]) =>
    '<button class="nav-button ' + (activeView === id ? "active" : "") + '" data-view="' + id + '">' +
      icon(glyph) + '<span class="nav-label">' + esc(label) + "</span></button>"
  ).join("");
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.onclick = () => switchView(button.dataset.view);
  });
}
function setHeader(title, subtitle) {
  $("eyebrow").textContent = isAdmin() ? "Admin" : "User";
  $("pageTitle").textContent = title;
  $("pageSubtitle").textContent = subtitle;
}
function showLoading() {
  $("content").innerHTML =
    '<div class="loading-shell"><div class="skeleton" style="width:170px"></div>' +
    '<div class="metric-grid loading-grid">' +
    Array.from({ length: 4 }, () => '<div class="metric"><div class="skeleton"></div><div class="skeleton skeleton-tall"></div></div>').join("") +
    '</div><div class="skeleton loading-panel"></div></div>';
}
async function switchView(view) {
  if (!navItems().some(([id]) => id === view)) view = "overview";
  if (view !== "calls") {
    clearInterval(runningClockTimer);
    runningClockTimer = null;
  }
  activeView = view;
  renderNav();
  showLoading();
  await loadActive({ patch: false });
}
async function loadActive({ patch = false } = {}) {
  setNotice("");
  try {
    if (activeView === "overview") await loadOverview({ patch });
    else if (activeView === "calls") await loadCalls({ patch });
    else if (activeView === "users") await loadUsers({ patch });
    else if (activeView === "errors") await loadErrors({ patch });
    touchFreshness();
  } catch (error) {
    if (error.message !== "unauthorized") {
      setNotice("Dashboard data is temporarily unavailable. Live updates will retry automatically.", true);
    }
  }
}

async function refreshActiveIncrementally() {
  if (!currentUser) return;
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  try {
    do {
      refreshQueued = false;
      await loadActive({ patch: true });
    } while (refreshQueued);
  } finally {
    refreshRunning = false;
  }
}
function topicsTouchActiveView(topics) {
  const set = new Set(topics);
  if (activeView === "overview") return ["overview", "calls", "users", "errors", "agents"].some((topic) => set.has(topic));
  if (activeView === "calls") return callPaging.stack.length === 0 && (set.has("calls") || set.has("agents"));
  if (activeView === "users") return set.has("users") || set.has("agents");
  if (activeView === "errors") return errorPaging.stack.length === 0 && set.has("errors");
  return false;
}
function queueLiveRefresh(topics = []) {
  for (const topic of topics) pendingLiveTopics.add(topic);
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(async () => {
    const topicsNow = [...pendingLiveTopics];
    pendingLiveTopics.clear();
    if (topicsTouchActiveView(topicsNow)) await refreshActiveIncrementally();
  }, 120);
}
function stopFallbackPolling() {
  clearTimeout(fallbackStartTimer);
  fallbackStartTimer = null;
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
}
function scheduleFallbackPolling() {
  if (fallbackStartTimer || fallbackPollTimer) return;
  fallbackStartTimer = setTimeout(() => {
    fallbackStartTimer = null;
    if (liveSocket?.readyState === WebSocket.OPEN || !currentUser) return;
    setLiveState("fallback");
    void refreshActiveIncrementally();
    fallbackPollTimer = setInterval(() => {
      if (liveSocket?.readyState === WebSocket.OPEN) return;
      void refreshActiveIncrementally();
    }, 15000);
  }, 8000);
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!currentUser) return;
  const delay = Math.min(10000, 500 * (2 ** Math.min(reconnectAttempt, 5)));
  reconnectAttempt += 1;
  setLiveState("reconnecting");
  reconnectTimer = setTimeout(connectLiveChannel, delay);
  scheduleFallbackPolling();
}
function stopLiveChannel() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearInterval(runningClockTimer);
  runningClockTimer = null;
  lastPongAt = 0;
  stopFallbackPolling();
  pendingLiveTopics.clear();
  const socket = liveSocket;
  liveSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    try { socket.close(1000, "dashboard_closed"); } catch {}
  }
}
function connectLiveChannel() {
  if (!currentUser) return;
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return;
  setLiveState(reconnectAttempt ? "reconnecting" : "connecting");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(scheme + "//" + location.host + "/admin/ws");
  liveSocket = socket;
  socket.onopen = async () => {
    if (liveSocket !== socket) return;
    const reconnect = socketEverOpened;
    socketEverOpened = true;
    reconnectAttempt = 0;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopFallbackPolling();
    clearInterval(heartbeatTimer);
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > 60000) {
        try { socket.close(4000, "heartbeat_timeout"); } catch {}
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    setLiveState("live");
    if (reconnect) await refreshActiveIncrementally();
  };
  socket.onmessage = (event) => {
    if (liveSocket !== socket || typeof event.data !== "string") return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === "pong" || data?.type === "ready") {
      lastPongAt = Date.now();
      return;
    }
    if (data?.type === "tool_started" || data?.type === "tool_finished") {
      applyToolLifecycle(data);
      return;
    }
    if (data?.type === "invalidate" && Array.isArray(data.topics)) queueLiveRefresh(data.topics);
  };
  socket.onerror = () => {
    try { socket.close(); } catch {}
  };
  socket.onclose = () => {
    if (liveSocket !== socket) return;
    liveSocket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    scheduleReconnect();
  };
}
function startLiveChannel() {
  stopLiveChannel();
  reconnectAttempt = 0;
  socketEverOpened = false;
  setLiveState("connecting");
  connectLiveChannel();
}
function metricCard(label, value, meta = "", tone = "") {
  return '<div class="metric ' + esc(tone) + '"><div class="metric-label">' + esc(label) + '</div>' +
    '<div class="metric-value">' + esc(value) + '</div><div class="metric-meta">' + esc(meta) + "</div></div>";
}
function periodChips(period) {
  return '<div class="period-chips"><span class="period-chip primary">' + icon("clock") + esc(period?.label || "Today") + "</span></div>";
}

function resetCallPaging() {
  callPaging.cursor = "";
  callPaging.stack = [];
  callPaging.nextCursor = null;
}
function resetErrorPaging() {
  errorPaging.cursor = "";
  errorPaging.stack = [];
  errorPaging.nextCursor = null;
}
function paginationMarkup(kind, paging, hasMore) {
  const page = paging.stack.length + 1;
  return '<div class="pagination-bar" data-live-key="' + kind + '-pagination">' +
    '<span class="pagination-summary">Page ' + page + ' · up to ' + PAGE_SIZE + ' rows</span>' +
    '<div class="pagination-actions">' +
      '<button class="button small" type="button" data-page-newer="' + kind + '"' + (page === 1 ? " disabled" : "") + '>← Newer</button>' +
      '<button class="button small" type="button" data-page-older="' + kind + '"' + (!hasMore ? " disabled" : "") + '>Older →</button>' +
    "</div></div>";
}
function bindPaging(kind, paging, load) {
  const newer = document.querySelector('[data-page-newer="' + kind + '"]');
  const older = document.querySelector('[data-page-older="' + kind + '"]');
  if (newer) newer.onclick = async () => {
    if (!paging.stack.length) return;
    paging.cursor = paging.stack.pop() || "";
    await load({ patch: true });
  };
  if (older) older.onclick = async () => {
    if (!paging.nextCursor) return;
    paging.stack.push(paging.cursor);
    paging.cursor = paging.nextCursor;
    await load({ patch: true });
  };
}

function chartMarkup(buckets = []) {
  const max = Math.max(1, ...buckets.map((bucket) => Number(bucket.calls || 0)));
  const yTicks = [1, .75, .5, .25, 0].map((ratio) => Math.round(max * ratio));
  const yLabels = '<div class="chart-y-axis" aria-hidden="true">' +
    yTicks.map((value) => '<span>' + fmtNum(value) + "</span>").join("") +
    "</div>";
  const bars = buckets.map((bucket, index) => {
    const calls = Number(bucket.calls || 0);
    const errors = Number(bucket.errors || 0);
    const height = Math.max(calls ? 4 : 0, (calls / max) * 100);
    const start = bkkHourMinute(bucket.from);
    const end = bkkHourMinute(new Date(Date.parse(bucket.to) + 1).toISOString());
    const label = start + "–" + end;
    const current = index === buckets.length - 1 ? " current" : "";
    return '<button class="chart-bar' + current + '" style="--bar-height:' + height + '%" data-chart-from="' + esc(bucket.from) + '" data-chart-to="' + esc(bucket.to) + '"' +
      ' aria-label="' + esc(label + ", " + calls + " tool invocations, " + errors + " errors") + '">' +
      '<span class="chart-tooltip"><strong>' + esc(label) + '</strong><span>' + fmtNum(calls) + ' invocations · ' + fmtNum(errors) + ' errors</span><small>Open filtered tool calls</small></span>' +
      '<span class="bar-fill"></span>' +
      "</button>";
  }).join("");
  const xLabels = buckets.map((bucket, index) => {
    const show = index % 3 === 0 || index === buckets.length - 1;
    return '<span class="' + (show ? "" : "muted") + '">' + (show ? esc(bkkHourMinute(bucket.from)) : "") + "</span>";
  }).join("");
  return '<div class="chart-frame">' + yLabels +
    '<div class="chart-main"><div class="chart-plot"><div class="chart-grid-lines"><i></i><i></i><i></i><i></i><i></i></div><div class="chart-bars">' + bars +
    '</div></div><div class="chart-x-axis" aria-hidden="true">' + xLabels + "</div></div></div>";
}

async function loadOverview({ patch = false } = {}) {
  setHeader(isAdmin() ? "System overview" : "My overview", isAdmin() ? "Today across Chat Relay" : "Your activity today");
  const data = await api("/admin/api/overview");
  dashboardPeriod = data.period || dashboardPeriod || { label: "Today" };
  const m = data.usage || {};
  const exactMeta = data.bounded ? "partial — safety bound reached" : "today";
  const cards = [
    metricCard(isAdmin() ? "Tool invocations" : "My tool invocations", fmtNum(m.calls), data.bounded ? exactMeta : "MCP tools only · excludes Worker HTTP requests"),
    metricCard(isAdmin() ? "Active terminals" : "My active terminals", fmtNum(data.activeTerminals), "sessions and running batches"),
    metricCard("Avg / p95 latency", fmtMs(m.avgDurationMs) + " / " + fmtMs(m.p95DurationMs), exactMeta),
    metricCard(isAdmin() ? "Error rate" : "My error rate", fmtPct(m.errorRate), fmtNum(m.errors) + " failed calls", Number(m.errors || 0) ? "metric-alert" : ""),
  ];
  if (isAdmin()) {
    cards.push(metricCard("Online agents", (data.agents?.online || 0) + " / " + (data.agents?.total || 0), "connected agents"));
    cards.push(metricCard("Active users", fmtNum(data.activeUsers ?? data.users?.enabled), "enabled users"));
  }
  const top = Array.isArray(data.topTools) ? data.topTools : [];
  const boundedNotice = data.bounded
    ? '<div class="data-warning">' + icon("alert") + '<span>This view reached its safe event bound. Counts shown are partial rather than falsely exact.</span></div>'
    : "";
  const health = data.agentHealth || {};
  const operationalHealth = isAdmin()
    ? '<div class="data-warning"><span><strong>Relay health</strong> · Active ' + fmtNum(health.active || 0) +
      ' · Queued ' + fmtNum(health.queued || 0) +
      ' · Reconnects ' + fmtNum(health.reconnectCount || 0) +
      (health.versions?.length ? ' · Agent ' + esc(health.versions.join(", ")) : '') +
      (health.capabilities?.length ? ' · Capabilities ' + esc(health.capabilities.slice(0, 6).join(", ")) : '') +
      (health.lastDisconnectReason ? ' · Last disconnect ' + esc(health.lastDisconnectReason) : '') +
      '</span></div>'
    : "";
  const liveMarkup =
    '<div class="overview-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + (isAdmin() ? "System-wide safe metadata" : "Only your activity") + "</span></div>" +
    boundedNotice +
    operationalHealth +
    '<div class="metric-grid">' + cards.join("") + "</div>" +
    '<div class="layout-2 overview-layout"><section class="panel chart-panel"><div class="panel-heading"><div><div class="panel-kicker">Activity</div><h2>Usage by hour</h2></div><span class="panel-meta">Click a bar to inspect invocations</span></div>' +
      chartMarkup(data.buckets || []) + "</section>" +
    '<section class="panel"><div class="panel-heading"><div><div class="panel-kicker">Breakdown</div><h2>Top tools</h2></div></div><div class="list top-tools">' +
      (top.length ? top.map((item, index) =>
        '<div class="list-row"><div class="tool-rank">' + (index + 1) + '</div><div class="list-copy"><div class="primary-text">' + esc(item.tool) +
        '</div><div class="secondary-text">' + esc(humanTool(item.tool)) + '</div></div><strong class="list-value">' + fmtNum(item.calls) + "</strong></div>"
      ).join("") : '<div class="empty-inline">No tool invocations yet today.</div>') +
    "</div></section></div>";
  renderContent(liveMarkup, patch);

  document.querySelectorAll("[data-chart-from]").forEach((bar) => {
    bar.onclick = async () => {
      callFilters.from = bar.dataset.chartFrom;
      callFilters.to = bar.dataset.chartTo;
      callFilters.drilldown = true;
      callFilters.activityId = "";
      resetCallPaging();
      activeView = "calls";
      renderNav();
      showLoading();
      await loadCalls();
    };
  });
}

function statusBadge(status) {
  const normalized = String(status || "").toLowerCase();
  const tone = normalized === "success" ? "ok" : normalized === "running" ? "running" : normalized === "error" ? "bad" : "";
  const glyph = normalized === "success" ? "check" : normalized === "error" ? "x" : normalized === "running" ? "activity" : "info";
  const label = normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Unknown";
  return '<span class="status-pill ' + tone + '">' + icon(glyph) + esc(label) + "</span>";
}
function activeTerminalRows(terminals = []) {
  return terminals.flatMap((agent) => [
    ...(agent.sessions || []).map((session) => ({
      userId: session.userId || "",
      tool: session.type === "shell" ? "terminal_start_shell" : "terminal_start",
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      activityId: session.activityId || (session.toolCallId ? "call_" + String(session.toolCallId).replace(/^tc_/, "").slice(0, 12) : ""),
      toolCallId: session.toolCallId,
      startedAt: session.startedAt,
      timestamp: session.startedAt,
      status: "running",
      durationMs: Date.now() - Date.parse(session.startedAt || new Date().toISOString()),
      sessionId: session.sessionId,
      syntheticTerminal: true,
    })),
    ...(agent.batches || []).map((batch) => ({
      userId: batch.userId || "",
      tool: "terminal_batch_start",
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      activityId: batch.activityId || (batch.toolCallId ? "call_" + String(batch.toolCallId).replace(/^tc_/, "").slice(0, 12) : ""),
      toolCallId: batch.toolCallId,
      startedAt: batch.startedAt,
      timestamp: batch.startedAt,
      status: "running",
      durationMs: Date.now() - Date.parse(batch.startedAt || new Date().toISOString()),
      batchId: batch.batchId,
      syntheticTerminal: true,
    })),
  ]);
}
async function ensureCallPeriod() {
  if (dashboardPeriod?.from && dashboardPeriod?.to) return;
  const overview = await api("/admin/api/overview");
  dashboardPeriod = overview.period;
}
async function loadAdminUsersForFilter() {
  if (!isAdmin() || adminUsersCache.length) return;
  const data = await api("/admin/api/users?limit=100");
  adminUsersCache = Array.isArray(data.items) ? data.items : [];
}
function callFilterMarkup() {
  const userSelect = isAdmin()
    ? '<label class="filter-control"><span>User</span><select id="callUser"><option value="">All users</option>' +
      adminUsersCache.map((user) => '<option value="' + esc(user.id) + '"' + (callFilters.userId === user.id ? " selected" : "") + ">" + esc(user.name || user.login || user.id) + "</option>").join("") +
      "</select></label>"
    : "";
  const statusOptions = [["", "All statuses"], ["running", "Running"], ["success", "Success"], ["error", "Error"]]
    .map(([value, label]) => '<option value="' + value + '"' + (callFilters.status === value ? " selected" : "") + ">" + label + "</option>").join("");
  const windowLabel = callFilters.drilldown && callFilters.from
    ? bkkHourMinute(callFilters.from) + "–" + bkkHourMinute(new Date(Date.parse(callFilters.to) + 1).toISOString())
    : "Today";
  const related = callFilters.activityId
    ? '<button id="clearActivity" class="button subtle activity-filter-chip" type="button">' + icon("activity") + esc(activityLabel(callFilters.activityId)) + ' ' + icon("x") + "</button>"
    : "";
  return '<div class="filters-panel"><div class="filters-row">' +
    '<label class="filter-control grow"><span>Search</span><div class="input-with-icon">' + icon("search") + '<input id="toolSearch" value="' + esc(callFilters.query) + '" placeholder="Tool, agent, activity"></div></label>' +
    userSelect +
    '<label class="filter-control"><span>Status</span><select id="callStatus">' + statusOptions + "</select></label>" +
    '<div class="filter-window"><span>Window</span><div class="window-chip">' + icon("clock") + esc(windowLabel) + "</div></div>" +
    related +
    (callFilters.drilldown ? '<button id="clearDrilldown" class="button subtle" type="button">' + icon("x") + "Clear bucket</button>" : "") +
    "</div></div>";
}

function rememberAgentName(event) {
  if (event?.agentId && event?.agentName) agentNameCache.set(String(event.agentId), String(event.agentName));
}
function callAgentName(event) {
  return event?.agentName || (event?.agentId ? agentNameCache.get(String(event.agentId)) : "") || "Resolving…";
}
function callEventMatchesFilters(event) {
  const when = Date.parse(event.startedAt || event.timestamp || "");
  if (callFilters.from && Number.isFinite(when) && when < Date.parse(callFilters.from)) return false;
  if (callFilters.to && Number.isFinite(when) && when > Date.parse(callFilters.to)) return false;
  if (isAdmin() && callFilters.userId && event.userId !== callFilters.userId) return false;
  if (callFilters.activityId && event.activityId !== callFilters.activityId) return false;
  if (callFilters.status && event.status !== callFilters.status) return false;
  return true;
}
function callRowMarkup(event) {
  rememberAgentName(event);
  const detailId = registerDetail(event);
  const when = event.startedAt || event.timestamp;
  const rowKey = event.toolCallId || [when, event.userId, event.tool, event.agentId].join(":");
  const duration = event.status === "running"
    ? '<span class="running-duration" data-running-start="' + esc(event.startedAt || event.timestamp) + '">' + esc(elapsedClock(event.startedAt || event.timestamp)) + "</span>"
    : esc(fmtMs(event.durationMs));
  return '<tr data-filter-row data-live-key="' + esc(rowKey) + '" data-detail-id="' + detailId + '" data-detail-title="Tool call detail">' +
    '<td class="time-cell"><strong>' + esc(when ? bkkTime(when) : "-") + "</strong></td>" +
    (isAdmin() ? '<td><span class="user-cell">' + esc(event.userId || "-") + "</span></td>" : "") +
    '<td><div class="tool-cell"><span class="tool-icon">' + icon(event.tool?.startsWith("terminal") ? "terminal" : "activity") + '</span><div><strong>' + esc(event.tool || "-") + '</strong><span>' + esc(humanTool(event.tool)) + "</span></div></div></td>" +
    '<td><div class="agent-cell"><strong>' + esc(callAgentName(event)) + "</strong></div></td>" +
    '<td class="activity-cell" title="' + esc(event.activityId || "") + '">' + esc(activityLabel(event.activityId)) + "</td>" +
    "<td>" + duration + "</td>" +
    "<td>" + statusBadge(event.status || (event.ok ? "success" : "error")) + "</td>" +
    '<td class="row-chevron">' + icon("chevron") + "</td></tr>";
}
function applyCallSearchFilter() {
  const search = $("toolSearch");
  const q = String(search?.value || callFilters.query || "").trim().toLowerCase();
  document.querySelectorAll("[data-filter-row]").forEach((row) => {
    row.hidden = Boolean(q && !row.textContent.toLowerCase().includes(q));
  });
}
function lifecycleCallEvent(data) {
  const started = data.startedAt || data.timestamp;
  const status = data.type === "tool_started" ? "running" : (data.status || (data.ok ? "success" : "error"));
  const event = {
    ...data,
    status,
    startedAt: started,
    timestamp: data.type === "tool_started" ? started : data.timestamp,
    ...(data.agentId && agentNameCache.has(String(data.agentId)) ? { agentName: agentNameCache.get(String(data.agentId)) } : {}),
  };
  delete event.type;
  return event;
}
function applyToolLifecycle(data) {
  if (!data?.toolCallId || activeView !== "calls" || callPaging.cursor) return;
  const tbody = document.querySelector(".calls-table tbody");
  if (!tbody) return;

  const event = lifecycleCallEvent(data);
  const existing = [...tbody.querySelectorAll("[data-live-key]")].find((row) => row.dataset.liveKey === event.toolCallId);
  if (!callEventMatchesFilters(event)) {
    existing?.remove();
    ensureRunningClock();
    touchFreshness();
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = callRowMarkup(event).trim();
  const nextRow = template.content.firstElementChild;
  if (!nextRow) return;

  const empty = tbody.querySelector(".table-empty")?.closest("tr");
  empty?.remove();
  if (existing) patchLiveNode(existing, nextRow);
  else tbody.prepend(nextRow);

  const rows = [...tbody.querySelectorAll("[data-filter-row]")];
  for (const row of rows.slice(PAGE_SIZE)) row.remove();
  bindDetailRows();
  applyCallSearchFilter();
  ensureRunningClock();
  touchFreshness();
}

async function loadCalls({ patch = false } = {}) {
  detailRecords.clear();
  detailSeq = 0;
  setHeader(isAdmin() ? "Tool calls" : "My tool calls", "Live running and completed activity");
  await ensureCallPeriod();
  await loadAdminUsersForFilter();
  const from = callFilters.from || dashboardPeriod?.from;
  const to = callFilters.to || new Date().toISOString();
  const params = new URLSearchParams({ state: "all", limit: String(PAGE_SIZE) });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (callPaging.cursor) params.set("cursor", callPaging.cursor);
  if (callFilters.status) params.set("status", callFilters.status);
  if (callFilters.activityId) params.set("activityId", callFilters.activityId);
  if (isAdmin() && callFilters.userId) params.set("userId", callFilters.userId);
  const data = await api("/admin/api/tool-calls?" + params);
  callPaging.nextCursor = data.nextCursor || null;
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const terminalItems = (!callPaging.cursor && (!callFilters.status || callFilters.status === "running")
    ? activeTerminalRows(data.terminals || [])
    : []).filter((item) => !isAdmin() || !callFilters.userId || item.userId === callFilters.userId);
  const seen = new Set(rawItems.map((item) => item.toolCallId).filter(Boolean));
  const items = [...terminalItems.filter((item) => !item.toolCallId || !seen.has(item.toolCallId)), ...rawItems]
    .sort((a, b) => Date.parse(b.timestamp || b.startedAt || "") - Date.parse(a.timestamp || a.startedAt || ""));

  items.forEach(rememberAgentName);
  const tableRows = items.length ? items.map(callRowMarkup).join("") : '<tr><td colspan="' + (isAdmin() ? "8" : "7") + '"><div class="table-empty">' + icon("activity") + '<strong>No tool calls in this window</strong><span>New activity appears here in realtime.</span></div></td></tr>';

  const liveMarkup =
    '<div class="section-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + "Safe metadata only</span></div>" +
    (data.bounded ? '<div class="data-warning">' + icon("alert") + "<span>History reached its safe bound; results are partial.</span></div>" : "") +
    callFilterMarkup() +
    '<div class="table-wrap calls-table"><table><thead><tr><th>Time</th>' + (isAdmin() ? "<th>User</th>" : "") +
      "<th>Tool</th><th>Agent</th><th>Activity</th><th>Duration</th><th>Status</th><th></th></tr></thead><tbody>" + tableRows + "</tbody></table></div>" +
    paginationMarkup("calls", callPaging, Boolean(data.hasMore));
  renderContent(liveMarkup, patch);
  ensureRunningClock();

  const search = $("toolSearch");
  if (search) {
    search.oninput = () => {
      callFilters.query = search.value;
      applyCallSearchFilter();
    };
    search.dispatchEvent(new Event("input"));
  }
  if ($("callUser")) $("callUser").onchange = async () => {
    callFilters.userId = $("callUser").value;
    resetCallPaging();
    await loadCalls({ patch: true });
  };
  if ($("callStatus")) $("callStatus").onchange = async () => {
    callFilters.status = $("callStatus").value;
    resetCallPaging();
    await loadCalls({ patch: true });
  };
  if ($("clearActivity")) $("clearActivity").onclick = async () => {
    callFilters.activityId = "";
    resetCallPaging();
    await loadCalls({ patch: true });
  };
  if ($("clearDrilldown")) $("clearDrilldown").onclick = async () => {
    callFilters.from = "";
    callFilters.to = "";
    callFilters.drilldown = false;
    resetCallPaging();
    await loadCalls({ patch: true });
  };
  bindPaging("calls", callPaging, loadCalls);
  bindDetailRows();
}

async function loadUsers({ patch = false } = {}) {
  if (!isAdmin()) return switchView("overview");
  setHeader("Users", "Access, roles, and connected agents");
  const data = await api("/admin/api/users?limit=100");
  adminUsersCache = Array.isArray(data.items) ? data.items : adminUsersCache;
  const rows = (data.items || []).map((user) => {
    const agentMeta = fmtNum(user.agentCount) + " assigned · " + fmtNum(user.onlineAgentCount) + " online";
    return '<tr data-filter-row data-live-key="' + esc(user.id) + '"><td><div class="identity-stack"><span class="avatar">' + esc((user.name || user.login || "?").slice(0, 1).toUpperCase()) + '</span><div><div class="primary-text">' + esc(user.name) + '</div><div class="secondary-text">' + esc(user.login || user.id) + "</div></div></div></td>" +
      '<td><span class="role-tag">' + esc(user.admin ? "Admin" : "User") + "</span></td>" +
      '<td>' + statusBadge(user.deletedAt ? "error" : user.enabled ? "success" : "disabled").replace("Success", "Enabled").replace("Error", "Deleted") + "</td>" +
      '<td><div class="agent-count"><strong>' + fmtNum(user.agentCount) + '</strong><span>' + esc(agentMeta) + "</span></div></td>" +
      '<td>' + esc(user.createdAt ? new Intl.DateTimeFormat("en-GB", { timeZone: BKK_TZ, day: "2-digit", month: "short", year: "numeric" }).format(new Date(user.createdAt)) : "-") + "</td>" +
      '<td>' + (user.id === currentUser.id
        ? '<span class="current-user-label">Current user</span>'
        : user.deletedAt
          ? '<button class="button small" data-restore="' + esc(user.id) + '">' + icon("refresh") + "Restore</button>"
          : '<button class="button small danger" data-delete="' + esc(user.id) + '" data-name="' + esc(user.name) + '">' + icon("trash") + "Soft delete</button>") +
      "</td></tr>";
  }).join("");

  const liveMarkup =
    '<div class="filters-panel compact"><div class="filters-row"><label class="filter-control grow"><span>Search users</span><div class="input-with-icon">' +
      icon("search") + '<input id="userSearch" placeholder="Name, login, role, agent"></div></label>' +
      '<button id="addUser" class="button primary" type="button">' + icon("plus") + "Add user</button></div></div>" +
    '<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Agents</th><th>Created</th><th>Action</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6"><div class="table-empty">No users.</div></td></tr>') + "</tbody></table></div>";
  renderContent(liveMarkup, patch);

  bindTableFilter("userSearch");
  $("addUser").onclick = () => { $("userForm").reset(); $("userFormError").textContent = ""; $("userDialog").showModal(); };
  document.querySelectorAll("[data-delete]").forEach((button) => button.onclick = () => {
    pendingDeleteUser = button.dataset.delete;
    $("confirmCopy").textContent = "Disable dashboard and relay access for " + button.dataset.name + "?";
    $("confirmDialog").showModal();
  });
  document.querySelectorAll("[data-restore]").forEach((button) => button.onclick = async () => {
    await api("/admin/api/users/restore", { method: "POST", body: JSON.stringify({ userId: button.dataset.restore }) });
    await loadUsers({ patch: true });
  });
}

function diagnosticStageLabel(stage) {
  return ({
    validation: "Validation",
    policy: "Policy",
    process: "Process",
    worker: "Worker",
    relay: "Relay",
    agent: "Agent",
    timeout: "Timeout",
    tool: "Tool",
  })[stage] || "Tool";
}
function diagnosticResult(event) {
  if (event.exitCode !== null && event.exitCode !== undefined) return "Exit " + event.exitCode;
  if (event.statusCode !== null && event.statusCode !== undefined) return "HTTP " + event.statusCode;
  return "—";
}
async function loadErrors({ patch = false } = {}) {
  detailRecords.clear();
  detailSeq = 0;
  if (!isAdmin()) return switchView("overview");
  setHeader("Errors", "Safe diagnostics for failed tool invocations");
  await ensureCallPeriod();
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (dashboardPeriod?.from) params.set("from", dashboardPeriod.from);
  params.set("to", new Date().toISOString());
  if (errorPaging.cursor) params.set("cursor", errorPaging.cursor);
  const data = await api("/admin/api/errors?" + params);
  errorPaging.nextCursor = data.nextCursor || null;
  const items = data.items || [];
  const rows = items.length ? items.map((event) => {
    const detailId = registerDetail(event);
    const code = event.errorCode || event.errorClass || "tool_error";
    const stage = diagnosticStageLabel(event.failureStage);
    const retry = event.retryable ? "Retryable" : "Not retryable";
    const rowKey = event.toolCallId || [event.timestamp, event.userId, event.tool, event.agentId].join(":");
    return '<tr data-filter-row data-live-key="' + esc(rowKey) + '" data-detail-id="' + detailId + '" data-detail-title="Error diagnostic">' +
      '<td class="time-cell"><strong>' + esc(bkkTime(event.timestamp)) + "</strong></td>" +
      '<td><div class="error-cell"><span class="error-icon">' + icon("alert") + '</span><div><strong>' + esc(code) + '</strong><span>' + esc(stage + " · " + retry) + "</span></div></div></td>" +
      "<td>" + esc(event.userId) + "</td><td>" + esc(event.tool) + "</td>" +
      '<td><div class="agent-cell"><strong>' + esc(event.agentName || event.agentId || "Resolving…") + "</strong></div></td>" +
      "<td>" + esc(fmtMs(event.durationMs)) + '</td><td class="activity-cell" title="' + esc(event.activityId || "") + '">' + esc(activityLabel(event.activityId)) + "</td>" +
      '<td><span class="diagnostic-result">' + esc(diagnosticResult(event)) + '</span></td><td class="row-chevron">' + icon("chevron") + "</td></tr>";
  }).join("") : '<tr><td colspan="9"><div class="table-empty">' + icon("check") + '<strong>No errors today</strong><span>Safe diagnostics will appear here if a tool invocation fails.</span></div></td></tr>';

  const liveMarkup =
    '<div class="section-toolbar">' + periodChips(dashboardPeriod) + '<span class="privacy-chip">' + icon("info") + "No commands, args, payloads, or output stored</span></div>" +
    (data.bounded ? '<div class="data-warning">' + icon("alert") + "<span>Error history reached its safe bound; results are partial.</span></div>" : "") +
    '<div class="filters-panel compact"><div class="filters-row"><label class="filter-control grow"><span>Search errors</span><div class="input-with-icon">' + icon("search") +
      '<input id="errorSearch" placeholder="Code, stage, user, tool, agent"></div></label></div></div>' +
    '<div class="table-wrap error-table"><table><thead><tr><th>Time</th><th>Diagnostic</th><th>User</th><th>Tool</th><th>Agent</th><th>Duration</th><th>Activity</th><th>Result</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
    paginationMarkup("errors", errorPaging, Boolean(data.hasMore));
  renderContent(liveMarkup, patch);
  bindDetailRows();
  bindTableFilter("errorSearch");
  bindPaging("errors", errorPaging, loadErrors);
}

$("loginForm").onsubmit = async (event) => {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    const data = await api("/admin/session/login", { method: "POST", body: JSON.stringify({ login: $("loginName").value, password: $("password").value }) });
    csrf = data.csrfToken;
    currentUser = data.user;
    $("password").value = "";
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("who").textContent = (currentUser.name || currentUser.login) + " · " + (isAdmin() ? "Admin" : "User");
    $("roleBadge").innerHTML = icon(isAdmin() ? "server" : "users") + (isAdmin() ? "Admin workspace" : "User workspace");
    activeView = "overview";
    renderNav();
    await loadActive({ patch: false });
    startLiveChannel();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
};
$("logout").onclick = async () => {
  try { await api("/admin/session/logout", { method: "POST", body: "{}" }); } catch {}
  signOutUi();
};
$("refresh").innerHTML = icon("refresh");
$("refresh").setAttribute("aria-label", "Refresh dashboard");
$("refresh").onclick = () => void refreshActiveIncrementally();
$("logout").insertAdjacentHTML("afterbegin", icon("logout"));
$("userForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/admin/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: $("newName").value,
        login: $("newLogin").value,
        password: $("newPassword").value,
        admin: $("newAdmin").value === "true",
      }),
    });
    $("userDialog").close();
    adminUsersCache = [];
    await loadUsers({ patch: true });
  } catch (error) {
    $("userFormError").textContent = error.message;
  }
};
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.onclick = () => button.closest("dialog").close());
$("cancelDelete").onclick = () => { $("confirmDialog").close(); pendingDeleteUser = null; };
$("confirmDelete").onclick = async () => {
  if (!pendingDeleteUser) return;
  await api("/admin/api/users/soft-delete", { method: "POST", body: JSON.stringify({ userId: pendingDeleteUser }) });
  pendingDeleteUser = null;
  adminUsersCache = [];
  $("confirmDialog").close();
  await loadUsers({ patch: true });
};
$("closeDetail").onclick = () => $("detailDialog").close();

(async () => {
  try {
    const data = await api("/admin/session");
    currentUser = data.user;
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("who").textContent = (currentUser.name || currentUser.login) + " · " + (isAdmin() ? "Admin" : "User");
    $("roleBadge").innerHTML = icon(isAdmin() ? "server" : "users") + (isAdmin() ? "Admin workspace" : "User workspace");
    renderNav();
    await loadActive({ patch: false });
    startLiveChannel();
  } catch {}
})();

window.addEventListener("online", () => { if (currentUser && liveSocket?.readyState !== WebSocket.OPEN) connectLiveChannel(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && currentUser && liveSocket?.readyState !== WebSocket.OPEN) connectLiveChannel(); });
