let csrf = sessionStorage.getItem("chat_relay_csrf") || "";
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
let dataRetryTimer = null;
let dataRetryAttempt = 0;
const pendingLiveTopics = new Set();
let dashboardPeriod = null;
let dashboardRange = "today";

const BKK_TZ = "Asia/Bangkok";
const API_TIMEOUT_MS = 12000;
const DATA_RETRY_MAX_MS = 300000;
let lastLiveRefreshAt = 0;
function dashboardAvailable() { return !document.hidden && navigator.onLine !== false; }
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtNum = (v) => new Intl.NumberFormat("en-US").format(Number(v || 0));
const fmtMs = (v) => v === null || v === undefined ? "\u2014" : Number(v || 0) >= 1000 ? (Number(v) / 1000).toFixed(1) + "s" : Math.round(Number(v || 0)) + " ms";
const fmtPct = (v) => v === null || v === undefined ? "\u2014" : ((Number(v || 0)) * 100).toFixed(1) + "%";
const bkkTime = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(iso));
const bkkHourMinute = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));
const bkkDayLabel = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, day: "2-digit", month: "short",
}).format(new Date(iso));
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
  mouse: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 2v6"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
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

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (data.csrfToken) {
      csrf = String(data.csrfToken);
      sessionStorage.setItem("chat_relay_csrf", csrf);
    }
    if (response.status === 401) {
      signOutUi("Session expired. Sign in again.");
      throw new Error("unauthorized");
    }
    const canRetryCsrf = options.method && options.method !== "GET" && options._csrfRetry !== false;
    if (!response.ok && canRetryCsrf && (data.error === "csrf_required" || data.error === "csrf_invalid")) {
      await api("/admin/session?refreshCsrf=1", { _csrfRetry: false });
      const retryOptions = { ...options, _csrfRetry: false };
      delete retryOptions.signal;
      return api(path, retryOptions);
    }
    if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
    return data;
  } catch (error) {
    if (timedOut) throw new Error("request_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.("abort", forwardAbort);
  }
}

function clearDataRetry() {
  clearTimeout(dataRetryTimer);
  dataRetryTimer = null;
  dataRetryAttempt = 0;
}
function scheduleDataRetry() {
  if (!currentUser || !dashboardAvailable() || dataRetryTimer) return;
  const delay = Math.min(DATA_RETRY_MAX_MS, 60000 * (2 ** Math.min(dataRetryAttempt, 4)));
  dataRetryAttempt += 1;
  const freshness = $("freshness");
  if (freshness) freshness.textContent = "Retrying data\u2026";
  dataRetryTimer = setTimeout(() => {
    dataRetryTimer = null;
    void refreshActiveIncrementally();
  }, delay);
}
function signOutUi(message = "") {
  sessionStorage.removeItem("chat_relay_csrf");
  clearDataRetry();
  stopLiveChannel();
  csrf = "";
  currentUser = null;
  dashboardPeriod = null;
  $("appView").hidden = true;
  $("loginView").hidden = false;
  const loginError = $("loginError");
  if (loginError) {
    loginError.textContent = message;
    loginError.hidden = !message;
  }
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
    ? [["overview", "Overview", "overview"], ["usage", "Usage", "activity"]]
    : [["overview", "My Overview", "overview"], ["usage", "My usage", "activity"]];
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
  activeView = view;
  renderNav();
  showLoading();
  await refreshActiveIncrementally({ initial: true });
}
async function loadActive({ patch = false } = {}) {
  setNotice("");
  try {
    if (activeView === "overview") await loadOverview({ patch });
    else if (activeView === "usage") await loadUsage({ patch });
    clearDataRetry();
    touchFreshness();
    return true;
  } catch (error) {
    if (error.message !== "unauthorized") {
      const timeout = error.message === "request_timeout";
      setNotice(timeout
        ? "Dashboard data timed out. Retrying automatically\u2026"
        : "Dashboard data is temporarily unavailable. Retrying automatically\u2026", true);
      scheduleDataRetry();
    }
    return false;
  }
}

async function refreshActiveIncrementally({ initial = false } = {}) {
  if (!currentUser || !dashboardAvailable()) return;
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  let patch = !initial;
  try {
    do {
      refreshQueued = false;
      const loaded = await loadActive({ patch });
      if (!loaded || !dashboardAvailable()) { refreshQueued = false; break; }
      patch = true;
    } while (refreshQueued);
  } finally {
    refreshRunning = false;
  }
}
function topicsTouchActiveView(topics) {
  return topics.includes("overview") || topics.includes("users") || topics.includes("agents");
}
function queueLiveRefresh(topics = []) {
  for (const topic of topics) pendingLiveTopics.add(topic);
  if (!dashboardAvailable() || liveRefreshTimer || dataRetryTimer) return;
  liveRefreshTimer = setTimeout(async () => {
    liveRefreshTimer = null;
    if (!dashboardAvailable()) return;
    lastLiveRefreshAt = Date.now();
    const topicsNow = [...pendingLiveTopics];
    pendingLiveTopics.clear();
    if (topicsTouchActiveView(topicsNow)) await refreshActiveIncrementally();
  }, Math.max(0, 30000 - (Date.now() - lastLiveRefreshAt)));
}
function stopFallbackPolling() {
  clearTimeout(fallbackStartTimer);
  fallbackStartTimer = null;
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
}
function scheduleFallbackPolling() {
  if (!dashboardAvailable() || fallbackStartTimer || fallbackPollTimer) return;
  fallbackStartTimer = setTimeout(() => {
    fallbackStartTimer = null;
    if (liveSocket?.readyState === WebSocket.OPEN || !currentUser || !dashboardAvailable()) return;
    setLiveState("fallback");
    if (!dataRetryTimer) void refreshActiveIncrementally();
    fallbackPollTimer = setInterval(() => {
      if (liveSocket?.readyState === WebSocket.OPEN || !dashboardAvailable() || dataRetryTimer) return;
      void refreshActiveIncrementally();
    }, 60000);
  }, 60000);
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!currentUser || !dashboardAvailable()) return;
  const delay = Math.min(300000, 5000 * (2 ** Math.min(reconnectAttempt, 6)));
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
  if (!currentUser || !dashboardAvailable()) return;
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
      if (socket.readyState !== WebSocket.OPEN || !dashboardAvailable()) return;
      if (Date.now() - lastPongAt > 120000) {
        try { socket.close(4000, "heartbeat_timeout"); } catch {}
        return;
      }
      socket.send(JSON.stringify({ type: "ping" }));
    }, 50000);
    setLiveState("live");
    if (reconnect && !dataRetryTimer) queueLiveRefresh(["overview", "users", "agents"]);
  };
  socket.onmessage = (event) => {
    if (liveSocket !== socket || typeof event.data !== "string") return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === "pong" || data?.type === "ready") {
      lastPongAt = Date.now();
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
  const current = period?.range || dashboardRange || "today";
  const ranges = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
  return '<div class="period-chips">' + ranges.map(([value, label]) =>
    '<button type="button" class="period-chip' + (current === value ? ' primary' : '') + '" data-overview-range="' + value + '">' +
      (current === value ? icon("clock") : "") + esc(label) + "</button>"
  ).join("") + "</div>";
}
function periodDisplayLabel(range = dashboardRange) {
  return range === "30d" ? "Last 30 days" : range === "7d" ? "Last 7 days" : "Today";
}
function chartMarkup(buckets = [], period = dashboardPeriod) {
  const byDay = period?.range === "7d" || period?.range === "30d";
  const max = Math.max(1, ...buckets.map((bucket) => Number(bucket.calls || 0)));
  const yTicks = [1, .75, .5, .25, 0].map((ratio) => Math.round(max * ratio));
  const yLabels = '<div class="chart-y-axis" aria-hidden="true">' +
    yTicks.map((value) => '<span>' + fmtNum(value) + "</span>").join("") +
    "</div>";
  const bars = buckets.map((bucket, index) => {
    const calls = Number(bucket.calls || 0);
    const errors = Number(bucket.operationalErrors ?? bucket.errors ?? 0);
    const height = Math.max(calls ? 4 : 0, (calls / max) * 100);
    const start = bkkHourMinute(bucket.from);
    const end = bkkHourMinute(new Date(Date.parse(bucket.to) + 1).toISOString());
    const label = byDay ? bkkDayLabel(bucket.from) : start + "\u2013" + end;
    const current = index === buckets.length - 1 ? " current" : "";
    return '<div class="chart-bar' + current + '" style="--bar-height:' + height + '%" tabindex="0" role="img"' +
      ' aria-label="' + esc(label + ", " + calls + " tool invocations, " + errors + " operational errors") + '">' +
      '<span class="chart-tooltip"><strong>' + esc(label) + '</strong><span>' + fmtNum(calls) + ' invocations \u00b7 ' + fmtNum(errors) + ' operational errors</span><small>Aggregate usage</small></span>' +
      '<span class="bar-fill"></span>' +
      "</div>";
  }).join("");
  const labelEvery = byDay ? (buckets.length > 14 ? 5 : 1) : 3;
  const xLabels = buckets.map((bucket, index) => {
    const show = index % labelEvery === 0 || index === buckets.length - 1;
    const label = byDay ? bkkDayLabel(bucket.from) : bkkHourMinute(bucket.from);
    return '<span class="' + (show ? "" : "muted") + '">' + (show ? esc(label) : "") + "</span>";
  }).join("");
  return '<div class="chart-frame">' + yLabels +
    '<div class="chart-main"><div class="chart-plot"><div class="chart-grid-lines"><i></i><i></i><i></i><i></i><i></i></div><div class="chart-bars">' + bars +
    '</div></div><div class="chart-x-axis" aria-hidden="true">' + xLabels + "</div></div></div>";
}

async function loadOverview({ patch = false } = {}) {
  const requestedPeriodLabel = periodDisplayLabel(dashboardRange);
  setHeader(
    isAdmin() ? "System overview" : "My overview",
    isAdmin() ? requestedPeriodLabel + " across Chat Relay" : requestedPeriodLabel + " \u00b7 your activity",
  );
  const data = await api("/admin/api/summary?range=" + encodeURIComponent(dashboardRange));
  dashboardPeriod = data.period || dashboardPeriod || { range: dashboardRange, label: "Today" };
  dashboardRange = dashboardPeriod.range || dashboardRange;
  const periodLabel = periodDisplayLabel(dashboardRange);
  const chartUnit = dashboardRange === "today" ? "hour" : "day";
  const m = data.usage || {};
  const exactMeta = data.bounded ? "partial \u2014 safety bound reached" : periodLabel.toLowerCase();
  const cards = [
    metricCard(isAdmin() ? "Tool invocations" : "My tool invocations", fmtNum(m.calls), data.bounded ? exactMeta : "MCP tools only \u00b7 excludes Worker HTTP requests"),
    metricCard(isAdmin() ? "Active terminals" : "My active terminals", fmtNum(data.activeTerminals), "sessions and running batches"),
    metricCard("Avg / p95 latency", fmtMs(m.avgDurationMs) + " / " + fmtMs(m.p95DurationMs), m.p95Approximate ? "p95 is approximate" : exactMeta),
    metricCard(
      isAdmin() ? "Operational error rate" : "My operational error rate",
      fmtPct(m.operationalErrorRate ?? m.errorRate),
      fmtNum(m.operationalErrors ?? m.errors) + " infrastructure failures",
      Number(m.operationalErrors ?? m.errors ?? 0) ? "metric-alert" : "",
    ),
  ];
  if (isAdmin()) {
    cards.push(metricCard("Online agents", (data.agents?.online || 0) + " / " + (data.agents?.total || 0), "connected agents"));
    cards.push(metricCard("Active users", fmtNum(data.activeUsers ?? data.users?.enabled), "enabled users"));
  }
  const top = Array.isArray(data.topTools) ? data.topTools : [];
  const boundedNotice = data.bounded
    ? '<div class="data-warning">' + icon("alert") + '<span>Some detailed history is unavailable. Counts cover retained history.</span></div>'
    : "";
  const liveMarkup =
    '<div class="overview-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + (isAdmin() ? "System-wide safe metadata" : "Only your activity") + "</span></div>" +
    boundedNotice +
    '<div class="metric-grid">' + cards.join("") + "</div>" +
    '<div class="layout-2 overview-layout"><section class="panel chart-panel"><div class="panel-heading"><div><div class="panel-kicker">Activity</div><h2>Usage by ' + chartUnit + '</h2></div><span class="panel-meta">Aggregate invocations</span></div>' +
      chartMarkup(data.buckets || [], dashboardPeriod) + "</section>" +
    '<section class="panel"><div class="panel-heading"><div><div class="panel-kicker">Breakdown</div><h2>Top tools</h2></div></div><div class="list top-tools">' +
      (top.length ? top.map((item, index) =>
        '<div class="list-row"><div class="tool-rank">' + (index + 1) + '</div><div class="list-copy"><div class="primary-text">' + esc(item.tool) +
        '</div><div class="secondary-text">' + esc(humanTool(item.tool)) + '</div></div><strong class="list-value">' + fmtNum(item.calls) + "</strong></div>"
      ).join("") : '<div class="empty-inline">No tool invocations in this period.</div>') +
    "</div></section></div>" +
    (isAdmin() ? '<section class="panel account-usage-panel"><div class="panel-heading"><div><div class="panel-kicker">Accounts</div><h2>Tool invocations by account</h2></div><span class="panel-meta">' + esc(periodLabel) + '</span></div><div class="list account-usage">' +
      ((data.accountUsage || []).length ? data.accountUsage.map((item) =>
        '<div class="list-row"><div class="list-copy"><div class="primary-text">' + esc(item.name || item.userId) + '</div><div class="secondary-text">' + esc(item.login || item.userId) + '</div></div><strong class="list-value">' + fmtNum(item.calls) + '</strong></div>'
      ).join("") : '<div class="empty-inline">No account usage in this period.</div>') +
    "</div></section>" : "");
  renderContent(liveMarkup, patch);
  document.querySelectorAll("[data-overview-range]").forEach((button) => {
    button.onclick = async () => {
      const nextRange = button.dataset.overviewRange || "today";
      if (nextRange === dashboardRange) return;
      dashboardRange = nextRange;
      dashboardPeriod = null;
      await loadOverview();
    };
  });
}

async function loadUsage({ patch = false } = {}) {
  setHeader(isAdmin() ? "Usage" : "My usage", "Tool calls by account and agent");
  const data = await api("/admin/api/overview?range=" + encodeURIComponent(dashboardRange));
  dashboardPeriod = data.period || dashboardPeriod || { range: dashboardRange, label: "Today" };
  dashboardRange = dashboardPeriod.range || dashboardRange;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];

  const accountMarkup = accounts.length ? accounts.map((account) => {
    const agents = Array.isArray(account.agents) ? account.agents : [];
    const agentRows = agents.length ? agents.map((agent) =>
      '<div class="agent-usage-row" data-live-key="' + esc(account.userId + ":" + agent.agentId) + '">' +
        '<div class="agent-usage-name"><span class="agent-dot"></span><div><strong>' + esc(agent.name || agent.agentId) +
        '</strong><small>' + esc(agent.agentId) + '</small></div></div>' +
        '<strong class="agent-usage-count">' + fmtNum(agent.calls) + '</strong>' +
      '</div>'
    ).join("") : '<div class="empty-inline">No agents for this account.</div>';

    return '<section class="panel account-agent-panel" data-live-key="' + esc(account.userId) + '">' +
      '<div class="panel-heading"><div><div class="panel-kicker">Account</div><h2>' + esc(account.name || account.userId) +
      '</h2><div class="secondary-text">' + esc(account.login || account.userId) + '</div></div>' +
      '<div class="account-total"><strong>' + fmtNum(account.calls) + '</strong><span>tool calls</span></div></div>' +
      '<div class="agent-usage-list">' + agentRows + '</div></section>';
  }).join("") : '<section class="panel"><div class="empty-inline">No usage in this period.</div></section>';

  renderContent(
    '<div class="overview-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + periodDisplayLabel(dashboardRange) + "</span></div>" +
    '<div class="account-agent-grid">' + accountMarkup + "</div>",
    patch,
  );

  document.querySelectorAll("[data-overview-range]").forEach((button) => {
    button.onclick = async () => {
      const nextRange = button.dataset.overviewRange || "today";
      if (nextRange === dashboardRange) return;
      dashboardRange = nextRange;
      dashboardPeriod = null;
      await loadUsage({ patch: true });
    };
  });
}

$("logout").onclick = async () => {
  try { await api("/admin/session/logout", { method: "POST", body: "{}" }); } catch {}
  signOutUi();
};
$("refresh").innerHTML = icon("refresh");
$("refresh").setAttribute("aria-label", "Refresh dashboard");
$("refresh").onclick = () => {
  clearDataRetry();
  void refreshActiveIncrementally();
};
$("logout").insertAdjacentHTML("afterbegin", icon("logout"));


(async () => {
  try {
    const data = await api("/admin/session?refreshCsrf=1");
    currentUser = data.user;
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("who").textContent = (currentUser.name || currentUser.login) + " \u00b7 " + (isAdmin() ? "Admin" : "User");
    $("roleBadge").innerHTML = icon(isAdmin() ? "server" : "users") + (isAdmin() ? "Admin workspace" : "User workspace");
    renderNav();
    showLoading();
    startLiveChannel();
    await refreshActiveIncrementally({ initial: true });
  } catch (error) {
    if (error?.message === "unauthorized") return;
    const loginError = $("loginError");
    if (loginError) {
      loginError.textContent = error?.message === "request_timeout"
        ? "Dashboard session check timed out. Refresh to retry."
        : "Dashboard session is temporarily unavailable. Refresh to retry.";
      loginError.hidden = false;
    }
  }
})();

function updateDashboardAvailability() {
  if (!dashboardAvailable()) {
    clearTimeout(dataRetryTimer);
    dataRetryTimer = null;
    refreshQueued = false;
    stopLiveChannel();
    return;
  }
  if (!currentUser) return;
  connectLiveChannel();
  void refreshActiveIncrementally();
}
window.addEventListener("online", updateDashboardAvailability);
window.addEventListener("offline", updateDashboardAvailability);
document.addEventListener("visibilitychange", updateDashboardAvailability);
