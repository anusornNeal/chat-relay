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
let usageUserMode = "active";

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
  folder: '<path d="M3 6.5h7l2 2h9v10H3z"/><path d="M3 6.5v-2h7l2 2"/>',
  folderOpen: '<path d="M3 7h7l2 2h9l-2.5 9H3z"/><path d="M3 7V5h7l2 2"/>',
  archive: '<path d="M4 7h16M5 7l1 12h12l1-12M9 11h6M6 4h12v3H6z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  thumbUp: '<path d="M7 10v10H3V10h4Zm0 8h10.5a2 2 0 0 0 2-1.6l1-5A2 2 0 0 0 18.5 9H14l.7-3.2A2.2 2.2 0 0 0 12.6 3L7 10v8Z"/>',
  thumbDown: '<path d="M7 14V4H3v10h4Zm0-8h10.5a2 2 0 0 1 2 1.6l1 5a2 2 0 0 1-2 2.4H14l.7 3.2a2.2 2.2 0 0 1-2.1 2.8L7 14V6Z"/>',
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
    ? [["overview", "Overview", "overview"], ["usage", "Usage", "activity"], ["learn", "My Learn", "info"]]
    : [["overview", "My Overview", "overview"], ["usage", "My usage", "activity"], ["learn", "My Learn", "info"]];
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
    else if (activeView === "learn") await loadLearn({ patch });
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
    if (!dataRetryTimer && activeView !== "learn") void refreshActiveIncrementally();
    fallbackPollTimer = setInterval(() => {
      if (liveSocket?.readyState === WebSocket.OPEN || !dashboardAvailable() || dataRetryTimer || activeView === "learn") return;
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
  const items = Array.isArray(buckets) ? buckets : [];
  const byDay = period?.range === "7d" || period?.range === "30d";
  const callsByBucket = items.map((bucket) => Number(bucket.calls || 0));
  const total = callsByBucket.reduce((sum, calls) => sum + calls, 0);
  const max = Math.max(1, ...callsByBucket);
  const average = items.length ? total / items.length : 0;
  const averageHeight = Math.min(100, Math.max(0, (average / max) * 100));
  const peakIndex = callsByBucket.indexOf(Math.max(0, ...callsByBucket));
  const peakBucket = peakIndex >= 0 ? items[peakIndex] : null;
  const peakLabel = peakBucket ? (byDay ? bkkDayLabel(peakBucket.from) : bkkHourMinute(peakBucket.from)) : "\u2014";
  const yTicks = [1, .75, .5, .25, 0].map((ratio) => Math.round(max * ratio));
  const yLabels = '<div class="chart-y-axis" aria-hidden="true">' + yTicks.map((value) => '<span>' + fmtNum(value) + "</span>").join("") + "</div>";
  const bars = items.map((bucket, index) => {
    const calls = Number(bucket.calls || 0);
    const errors = Number(bucket.operationalErrors ?? bucket.errors ?? 0);
    const height = Math.max(calls ? 4 : 0, (calls / max) * 100);
    const start = bkkHourMinute(bucket.from);
    const end = bkkHourMinute(new Date(Date.parse(bucket.to) + 1).toISOString());
    const label = byDay ? bkkDayLabel(bucket.from) : start + "\u2013" + end;
    const current = index === items.length - 1 ? " current" : "";
    return '<div class="chart-bar' + current + '" style="--bar-height:' + height + '%" tabindex="0" role="img" aria-label="' +
      esc(label + ", " + calls + " tool invocations, " + errors + " operational errors") + '">' +
      '<span class="chart-tooltip"><strong>' + esc(label) + '</strong><span>' + fmtNum(calls) + ' invocations</span><small>' + fmtNum(errors) + ' operational errors</small></span>' +
      '<span class="bar-fill"></span>' + (errors > 0 ? '<span class="chart-error-dot" aria-hidden="true"></span>' : "") + "</div>";
  }).join("");
  const labelEvery = byDay ? (items.length > 14 ? 5 : 1) : 3;
  const xLabels = items.map((bucket, index) => {
    const show = index % labelEvery === 0 || index === items.length - 1;
    const label = byDay ? bkkDayLabel(bucket.from) : bkkHourMinute(bucket.from);
    return '<span class="' + (show ? "" : "muted") + '">' + (show ? esc(label) : "") + "</span>";
  }).join("");
  const intervalLabel = byDay ? "day" : "hour";
  const stats = '<div class="chart-stats">' +
    '<div><span>Total</span><strong>' + fmtNum(total) + '</strong></div>' +
    '<div><span>Avg / ' + intervalLabel + '</span><strong>' + fmtNum(Math.round(average)) + '</strong></div>' +
    '<div><span>Peak</span><strong>' + esc(peakLabel) + '</strong></div>' +
    "</div>";
  if (!items.length) return stats + '<div class="chart-empty">No tool activity in this period.</div>';
  return stats + '<div class="chart-frame">' + yLabels +
    '<div class="chart-main"><div class="chart-plot"><div class="chart-grid-lines"><i></i><i></i><i></i><i></i><i></i></div>' +
    '<div class="chart-average-line" style="--avg-height:' + averageHeight + '%"><span>Avg ' + fmtNum(Math.round(average)) + '</span></div>' +
    '<div class="chart-bars">' + bars + '</div></div><div class="chart-x-axis" aria-hidden="true">' + xLabels + "</div></div></div>";
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
  const boundedNotice = data.bounded
    ? '<div class="data-warning">' + icon("alert") + '<span>Some detailed history is unavailable. Counts cover retained history.</span></div>'
    : "";
  const chartUnit = dashboardRange === "today" ? "hour" : "day";
  const liveMarkup =
    '<div class="overview-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + (isAdmin() ? "System-wide safe metadata" : "Only your activity") + "</span></div>" +
    boundedNotice +
    '<div class="metric-grid">' + cards.join("") + "</div>" +
    '<section class="panel overview-chart-panel"><div class="overview-chart-heading"><div><div class="panel-kicker">Activity</div><h2>Tool activity</h2><p>Invocations by ' + chartUnit + ' for ' + esc(periodLabel.toLowerCase()) + '.</p></div>' +
      '<div class="chart-legend"><span class="legend-invocations"><i></i>Invocations</span><span class="legend-errors"><i></i>Operational error</span></div></div>' +
      chartMarkup(data.buckets || [], dashboardPeriod) + "</section>";
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
  const showDeleted = isAdmin() && usageUserMode === "deleted";
  const data = await api("/admin/api/overview?range=" + encodeURIComponent(dashboardRange) + (isAdmin() ? "&deleted=" + String(showDeleted) : ""));
  dashboardPeriod = data.period || dashboardPeriod || { range: dashboardRange, label: "Today" };
  dashboardRange = dashboardPeriod.range || dashboardRange;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];

  const accountMarkup = accounts.length ? accounts.map((account) => {
    const agents = Array.isArray(account.agents) ? account.agents : [];
    const activeAgents = agents.filter((agent) => Number(agent.calls || 0) > 0);
    const visibleAgents = activeAgents.length ? activeAgents : agents.slice(0, 1);
    const agentRows = visibleAgents.length ? visibleAgents.map((agent) =>
      '<div class="agent-usage-row" data-live-key="' + esc(account.userId + ":" + agent.agentId) + '">' +
        '<div class="agent-usage-name"><span class="agent-dot ' + (agent.online ? "online" : "") + '"></span><div><strong>' + esc(agent.name || agent.agentId) +
        '</strong><small>' + esc(agent.agentId) + '</small></div></div>' +
        '<strong class="agent-usage-count">' + fmtNum(agent.calls) + '</strong>' +
      '</div>'
    ).join("") : '<div class="empty-inline">No agents for this account.</div>';
    const userAction = !isAdmin() || account.userId === currentUser?.id
      ? ""
      : showDeleted
        ? '<button type="button" class="usage-user-action" data-restore-user="' + esc(account.userId) + '" title="Restore user" aria-label="Restore ' + esc(account.name || account.userId) + '">' + icon("refresh") + '</button>'
        : '<button type="button" class="usage-user-action danger" data-delete-user="' + esc(account.userId) + '" data-user-name="' + esc(account.name || account.userId) + '" title="Delete user" aria-label="Delete ' + esc(account.name || account.userId) + '">' + icon("trash") + '</button>';

    return '<section class="panel account-agent-panel" data-live-key="' + esc(account.userId) + '">' +
      '<div class="panel-heading"><div><div class="panel-kicker">Account</div><h2>' + esc(account.name || account.userId) +
      '</h2><div class="secondary-text">' + esc(account.login || account.userId) + '</div></div>' +
      '<div class="account-heading-actions"><div class="account-total"><strong>' + fmtNum(account.calls) + '</strong><span>tool calls</span></div>' + userAction + '</div></div>' +
      '<div class="agent-usage-list">' + agentRows + '</div></section>';
  }).join("") : '<section class="panel"><div class="empty-inline">' + (showDeleted ? "No deleted users." : "No usage in this period.") + '</div></section>';

  const userTabs = isAdmin()
    ? '<div class="usage-user-tabs" role="tablist" aria-label="User status"><button type="button" class="usage-user-tab ' + (usageUserMode === "active" ? "active" : "") + '" data-usage-user-mode="active" role="tab" aria-selected="' + String(usageUserMode === "active") + '">Active</button><button type="button" class="usage-user-tab ' + (usageUserMode === "deleted" ? "active" : "") + '" data-usage-user-mode="deleted" role="tab" aria-selected="' + String(usageUserMode === "deleted") + '">Deleted</button></div>'
    : "";

  renderContent(
    '<div class="overview-toolbar"><div class="usage-toolbar-left">' + userTabs + periodChips(dashboardPeriod) + '</div>' +
      '<span class="privacy-chip">' + icon("info") + periodDisplayLabel(dashboardRange) + "</span></div>" +
    '<div class="account-agent-grid">' + accountMarkup + "</div>",
    patch,
  );

  document.querySelectorAll("[data-usage-user-mode]").forEach((button) => {
    button.onclick = async () => {
      const nextMode = button.dataset.usageUserMode === "deleted" ? "deleted" : "active";
      if (nextMode === usageUserMode) return;
      usageUserMode = nextMode;
      await loadUsage({ patch: true });
    };
  });
  document.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.onclick = async () => {
      const userId = button.dataset.deleteUser;
      const name = button.dataset.userName || userId;
      if (!userId || !window.confirm("Delete " + name + "? The account can be restored from the Deleted tab.")) return;
      button.disabled = true;
      try {
        await api("/admin/api/users/soft-delete", { method: "POST", body: JSON.stringify({ userId }) });
        await loadUsage({ patch: true });
      } catch (error) {
        button.disabled = false;
        setNotice("Delete user failed: " + (error?.message || "request_failed"), true);
      }
    };
  });
  document.querySelectorAll("[data-restore-user]").forEach((button) => {
    button.onclick = async () => {
      const userId = button.dataset.restoreUser;
      if (!userId) return;
      button.disabled = true;
      try {
        await api("/admin/api/users/restore", { method: "POST", body: JSON.stringify({ userId }) });
        await loadUsage({ patch: true });
      } catch (error) {
        button.disabled = false;
        setNotice("Restore user failed: " + (error?.message || "request_failed"), true);
      }
    };
  });
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


let learnProfileSnapshot = null;
let learnKindFilter = "all";
let learnScopeFilter = "all";
let learnScopeKeyFilter = "";
let learnSelectedMemoryId = null;
let learnSearchQuery = "";
let learnSortMode = "name";
const learnTreeExpanded = { global: true, project: true, agent: true };
const learnScopedTreeExpanded = new Set();

const LEARN_KIND_ORDER = [
  "workflow",
  "response_style",
  "work_style",
  "coding_style",
  "problem_solving",
  "tool_pattern",
  "project_context",
  "agent_context",
  "preference",
  "correction",
];

function learnKindLabel(kind) {
  return ({
    preference: "Preference",
    response_style: "Response style",
    work_style: "Work style",
    coding_style: "Coding style",
    problem_solving: "Problem solving",
    project_context: "Project context",
    tool_pattern: "Tool pattern",
    workflow: "Workflow",
    correction: "Correction",
    agent_context: "Agent context",
  })[kind] || String(kind || "Learn");
}

function learnKindClass(kind) {
  return "kind-" + String(kind || "learn").replace(/[^a-z0-9_-]/gi, "-");
}

function learnScopeLabel(item) {
  const scope = String(item?.scope || "");
  if (scope === "global") return "Global";
  return scope.charAt(0).toUpperCase() + scope.slice(1) + (item?.scopeKey ? " Â· " + item.scopeKey : "");
}

function learnSummary(items) {
  const byScope = { global: 0, project: 0, agent: 0 };
  const byKind = {};
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(byScope, item.scope)) byScope[item.scope] += 1;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
  }
  return { total: items.length, byScope, byKind };
}

function exportLearnProfile() {
  if (!learnProfileSnapshot) return;
  const blob = new Blob([JSON.stringify(learnProfileSnapshot, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "chat-relay-learn-profile.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

function applyLearnMutation(result) {
  if (!learnProfileSnapshot || !result) return;
  let items = Array.isArray(learnProfileSnapshot.items) ? [...learnProfileSnapshot.items] : [];

  if (result.deleted && result.change?.memoryId) {
    items = items.filter((item) => item.id !== result.change.memoryId);
  } else if (result.item) {
    const index = items.findIndex((item) => item.id === result.item.id);
    if (index >= 0) items[index] = result.item;
    else items.unshift(result.item);
  }

  learnProfileSnapshot = {
    ...learnProfileSnapshot,
    items,
    summary: learnSummary(items),
  };

  const scopedItems = learnItemsForScope(items, learnScopeFilter, learnScopeKeyFilter);
  if (learnKindFilter !== "all" && !scopedItems.some((item) => item.kind === learnKindFilter)) {
    learnKindFilter = "all";
  }
}

async function mutateLearn(path, body) {
  const result = await api(path, { method: "POST", body: JSON.stringify(body) });
  applyLearnMutation(result);
  renderLearnProfile({ patch: true });
}

function learnCountByKind(items) {
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
  return counts;
}

function learnItemsForScope(items, scope, scopeKey = "") {
  if (scope === "all") return items;
  return items.filter((item) =>
    item.scope === scope && (!scopeKey || String(item.scopeKey || "") === scopeKey)
  );
}

function learnVisibleItems(items) {
  let visible = learnItemsForScope(items, learnScopeFilter, learnScopeKeyFilter);
  if (learnKindFilter !== "all") visible = visible.filter((item) => item.kind === learnKindFilter);
  const query = learnSearchQuery.trim().toLowerCase();
  if (query) {
    visible = visible.filter((item) =>
      [item.key, item.content, item.kind, item.scope, item.scopeKey]
        .some((value) => String(value || "").toLowerCase().includes(query))
    );
  }
  return [...visible].sort((a, b) => {
    if (learnSortMode === "updated") {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    }
    if (learnSortMode === "confidence") {
      return Number(b.confidence || 0) - Number(a.confidence || 0) ||
        String(a.key || "").localeCompare(String(b.key || ""));
    }
    return String(a.key || "").localeCompare(String(b.key || ""));
  });
}

function learnTreeKindRows(items, scope, scopeKey = "") {
  const counts = learnCountByKind(learnItemsForScope(items, scope, scopeKey));
  return LEARN_KIND_ORDER.filter((kind) => Number(counts[kind]) > 0).map((kind) => {
    const active = learnScopeFilter === scope &&
      String(learnScopeKeyFilter || "") === String(scopeKey || "") &&
      learnKindFilter === kind;
    return '<button class="learn-tree-row learn-tree-child' + (active ? " selected" : "") + '" type="button" data-learn-tree-scope="' + esc(scope) + '" data-learn-tree-key="' + esc(scopeKey) + '" data-learn-tree-kind="' + esc(kind) + '">' +
      '<span></span><i class="learn-tree-dot ' + esc(learnKindClass(kind)) + '"></i><span>' + esc(learnKindLabel(kind)) + '</span><em>' + esc(counts[kind]) + '</em></button>';
  }).join("");
}

function learnTreeScopedRows(items, scope) {
  const grouped = new Map();
  for (const item of items.filter((entry) => entry.scope === scope)) {
    const key = String(item.scopeKey || (scope === "project" ? "Unscoped project" : "Unscoped agent"));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([scopeKey, groupedItems]) => {
    const treeKey = scope + "::" + scopeKey;
    const expanded = learnScopedTreeExpanded.has(treeKey);
    const selected = learnScopeFilter === scope && learnScopeKeyFilter === scopeKey && learnKindFilter === "all";
    return '<div class="learn-tree-project">' +
      '<button class="learn-tree-row learn-tree-child learn-tree-project-row' + (selected ? " selected" : "") + '" type="button" data-learn-tree-toggle="scoped" data-learn-tree-scope="' + esc(scope) + '" data-learn-tree-key="' + esc(scopeKey) + '" data-learn-tree-kind="all">' +
        '<span class="learn-tree-chevron' + (expanded ? " open" : "") + '"></span>' + icon(expanded ? "folderOpen" : "folder") +
        '<span>' + esc(scopeKey) + '</span><em>' + esc(groupedItems.length) + '</em></button>' +
      (expanded ? '<div class="learn-tree-nested">' + learnTreeKindRows(items, scope, scopeKey) + '</div>' : "") +
    '</div>';
  }).join("");
}

function renderLearnProfile({ patch = false } = {}) {
  const data = learnProfileSnapshot || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const summary = data.summary || learnSummary(items);
  const byScope = summary.byScope || {};
  const visibleItems = learnVisibleItems(items);

  if (!visibleItems.some((item) => item.id === learnSelectedMemoryId)) {
    learnSelectedMemoryId = visibleItems[0]?.id || null;
  }
  const selected = visibleItems.find((item) => item.id === learnSelectedMemoryId) || null;

  const allActive = learnScopeFilter === "all" && learnKindFilter === "all";
  const globalActive = learnScopeFilter === "global" && !learnScopeKeyFilter && learnKindFilter === "all";
  const projectsActive = learnScopeFilter === "project" && !learnScopeKeyFilter && learnKindFilter === "all";
  const agentsActive = learnScopeFilter === "agent" && !learnScopeKeyFilter && learnKindFilter === "all";

  const treeHtml =
    '<button class="learn-tree-row' + (allActive ? " selected" : "") + '" type="button" data-learn-tree-scope="all" data-learn-tree-key="" data-learn-tree-kind="all">' +
      '<span></span>' + icon("archive") + '<strong>All memories</strong><em>' + esc(summary.total || items.length) + '</em></button>' +
    '<button class="learn-tree-row' + (globalActive ? " selected" : "") + '" type="button" data-learn-tree-toggle="root" data-learn-tree-scope="global" data-learn-tree-key="" data-learn-tree-kind="all">' +
      '<span class="learn-tree-chevron' + (learnTreeExpanded.global ? " open" : "") + '"></span>' + icon("globe") + '<strong>Global</strong><em>' + esc(byScope.global || 0) + '</em></button>' +
    (learnTreeExpanded.global ? '<div class="learn-tree-nested">' + learnTreeKindRows(items, "global") + '</div>' : "") +
    '<button class="learn-tree-row' + (projectsActive ? " selected" : "") + '" type="button" data-learn-tree-toggle="root" data-learn-tree-scope="project" data-learn-tree-key="" data-learn-tree-kind="all">' +
      '<span class="learn-tree-chevron' + (learnTreeExpanded.project ? " open" : "") + '"></span>' + icon(learnTreeExpanded.project ? "folderOpen" : "folder") + '<strong>Projects</strong><em>' + esc(byScope.project || 0) + '</em></button>' +
    (learnTreeExpanded.project ? '<div class="learn-tree-nested">' + learnTreeScopedRows(items, "project") + '</div>' : "") +
    '<button class="learn-tree-row' + (agentsActive ? " selected" : "") + '" type="button" data-learn-tree-toggle="root" data-learn-tree-scope="agent" data-learn-tree-key="" data-learn-tree-kind="all">' +
      '<span class="learn-tree-chevron' + (learnTreeExpanded.agent && Number(byScope.agent || 0) > 0 ? " open" : "") + '"></span>' + icon("cpu") + '<strong>Agents</strong><em>' + esc(byScope.agent || 0) + '</em></button>' +
    (learnTreeExpanded.agent && Number(byScope.agent || 0) > 0 ? '<div class="learn-tree-nested">' + learnTreeScopedRows(items, "agent") + '</div>' : "");

  const rowsHtml = visibleItems.length ? visibleItems.map((item) => {
    const active = selected?.id === item.id ? " active" : "";
    return '<button class="learn-folder-row' + active + '" type="button" data-learn-memory="' + esc(item.id) + '" data-live-key="learn-row-' + esc(item.id) + '">' +
      '<span class="learn-folder-file">' + icon("folder") + '</span>' +
      '<span class="learn-folder-copy"><strong>' + esc(item.key) + '</strong><small>' + esc(learnKindLabel(item.kind)) + '</small></span>' +
      '<span class="learn-folder-confidence">' + esc(item.confidence) + '%</span>' +
      '<span class="learn-folder-updated">' + esc(bkkHourMinute(item.updatedAt)) + '</span>' +
    '</button>';
  }).join("") : '<div class="learn-folder-empty">' + icon("search") + '<strong>No memories found</strong><span>Try another folder or search term.</span></div>';

  let detailHtml = '<div class="learn-detail-empty">' + icon("info") + '<strong>Select a memory</strong><span>Choose a row to inspect its details.</span></div>';
  if (selected) {
    const positive = Number(selected.positiveFeedback || 0);
    const negative = Number(selected.negativeFeedback || 0);
    const positiveChecked = positive > negative ? " checked" : "";
    const negativeChecked = negative > positive ? " checked" : "";
    const radioName = "learn-feedback-detail-" + String(selected.id).replace(/[^a-z0-9_-]/gi, "-");
    const scopePath = selected.scope === "global" ? "Global" : learnScopeLabel(selected);
    detailHtml =
      '<div class="learn-detail-top"><span class="learn-type-pill ' + esc(learnKindClass(selected.kind)) + '"><i class="learn-tree-dot ' + esc(learnKindClass(selected.kind)) + '"></i>' + esc(learnKindLabel(selected.kind)) + '</span>' +
        '<button class="learn-detail-more" type="button" aria-label="More memory actions">' + icon("more") + '</button></div>' +
      '<h3>' + esc(selected.key) + '</h3>' +
      '<div class="learn-detail-path">' + icon("folder") + esc(scopePath) + ' / ' + esc(learnKindLabel(selected.kind)) + '</div>' +
      '<div class="learn-detail-rule"></div>' +
      '<div class="learn-detail-section"><label>Memory</label><p>' + esc(selected.content) + '</p></div>' +
      '<div class="learn-detail-meta">' +
        '<div><span>Confidence</span><strong>' + esc(selected.confidence) + '%</strong></div>' +
        '<div><span>Updated</span><strong>' + esc(bkkTime(selected.updatedAt)) + '</strong></div>' +
        '<div><span>Scope</span><strong>' + esc(selected.scope === "global" ? "Global" : selected.scope.charAt(0).toUpperCase() + selected.scope.slice(1)) + '</strong></div>' +
        '<div><span>' + esc(selected.scope === "agent" ? "Agent" : selected.scope === "project" ? "Project" : "Level") + '</span><strong>' + esc(selected.scopeKey || "Global") + '</strong></div>' +
      '</div>' +
      '<div class="learn-detail-rule"></div>' +
      '<div class="learn-detail-section"><label>Feedback</label><div class="learn-detail-feedback" role="radiogroup" aria-label="Feedback for ' + esc(selected.key) + '">' +
        '<label class="learn-detail-radio useful' + (positiveChecked ? " active" : "") + '"><input type="radio" name="' + esc(radioName) + '" value="positive" data-learn-feedback="positive" data-memory-id="' + esc(selected.id) + '"' + positiveChecked + '>' + icon("thumbUp") + '<span>Useful</span></label>' +
        '<label class="learn-detail-radio not-useful' + (negativeChecked ? " active" : "") + '"><input type="radio" name="' + esc(radioName) + '" value="negative" data-learn-feedback="negative" data-memory-id="' + esc(selected.id) + '"' + negativeChecked + '>' + icon("thumbDown") + '<span>Not useful</span></label>' +
      '</div></div>' +
      '<div class="learn-detail-footer"><button class="button danger learn-detail-remove" type="button" data-learn-delete="' + esc(selected.id) + '">' + icon("trash") + 'Remove memory</button></div>';
  }

  const scopeTitle = learnScopeFilter === "all"
    ? "All memories"
    : learnScopeKeyFilter || ({ global: "Global", project: "Projects", agent: "Agents" })[learnScopeFilter] || "Learn";
  const typeTitle = learnKindFilter === "all" ? "" : learnKindLabel(learnKindFilter);
  const heading = typeTitle || scopeTitle;
  const subtitle = typeTitle
    ? (learnScopeKeyFilter ? "Reusable " + typeTitle.toLowerCase() + " patterns for " + learnScopeKeyFilter : typeTitle + " memories")
    : "Your reusable preferences and working patterns";

  renderContent(
    '<section class="learn-folder-shell">' +
      '<aside class="learn-folder-tree">' +
        '<label class="learn-folder-search">' + icon("search") + '<input id="learnSearch" type="search" placeholder="Search memories" value="' + esc(learnSearchQuery) + '"><kbd>/</kbd></label>' +
        '<div class="learn-tree-section">Library</div>' + treeHtml +
      '</aside>' +
      '<div class="learn-folder-main">' +
        '<div class="learn-folder-heading"><div><div class="learn-folder-breadcrumbs"><span>Learn</span><b>/</b><strong>' + esc(heading) + '</strong></div><h2>' + esc(heading) + '</h2><p>' + esc(subtitle) + '</p></div>' +
          '<div class="learn-folder-heading-actions"><span class="privacy-chip learn-profile-chip">' + icon("info") + 'Only your Learn profile</span><span class="learn-folder-count"><strong>' + esc(visibleItems.length) + '</strong> memories</span><button id="learnExport" class="button small learn-export-button" type="button">' + icon("download") + 'Export JSON</button></div></div>' +
        '<div class="learn-folder-list-toolbar"><div class="learn-folder-sort">' +
          '<button class="' + (learnSortMode === "name" ? "active" : "") + '" type="button" data-learn-sort="name">Name</button>' +
          '<button class="' + (learnSortMode === "updated" ? "active" : "") + '" type="button" data-learn-sort="updated">Updated</button>' +
          '<button class="' + (learnSortMode === "confidence" ? "active" : "") + '" type="button" data-learn-sort="confidence">Confidence</button>' +
        '</div><span>Folder view</span></div>' +
        '<div class="learn-folder-workspace">' +
          '<div class="learn-folder-list"><div class="learn-folder-list-head"><span>Name</span><span>Confidence</span><span>Updated</span></div><div class="learn-folder-list-scroll">' + rowsHtml + '</div></div>' +
          '<aside class="learn-detail-pane">' + detailHtml + '</aside>' +
        '</div>' +
      '</div>' +
    '</section>',
    patch,
  );

  const exportButton = $("learnExport");
  if (exportButton) exportButton.onclick = exportLearnProfile;

  const searchInput = $("learnSearch");
  if (searchInput) {
    searchInput.oninput = () => {
      learnSearchQuery = searchInput.value;
      renderLearnProfile({ patch: true });
      requestAnimationFrame(() => {
        const next = $("learnSearch");
        if (next) {
          next.focus();
          const pos = next.value.length;
          next.setSelectionRange?.(pos, pos);
        }
      });
    };
  }

  document.querySelectorAll("[data-learn-tree-scope]").forEach((button) => {
    button.onclick = () => {
      const scope = button.dataset.learnTreeScope || "all";
      const scopeKey = button.dataset.learnTreeKey || "";
      const toggle = button.dataset.learnTreeToggle || "";
      if (toggle === "root" && Object.prototype.hasOwnProperty.call(learnTreeExpanded, scope)) {
        learnTreeExpanded[scope] = !learnTreeExpanded[scope];
      } else if (toggle === "scoped" && scopeKey) {
        const treeKey = scope + "::" + scopeKey;
        if (learnScopedTreeExpanded.has(treeKey)) learnScopedTreeExpanded.delete(treeKey);
        else learnScopedTreeExpanded.add(treeKey);
      }
      learnScopeFilter = scope;
      learnScopeKeyFilter = scopeKey;
      learnKindFilter = button.dataset.learnTreeKind || "all";
      learnSelectedMemoryId = null;
      renderLearnProfile({ patch: true });
    };
  });

  document.querySelectorAll("[data-learn-sort]").forEach((button) => {
    button.onclick = () => {
      learnSortMode = button.dataset.learnSort || "name";
      renderLearnProfile({ patch: true });
    };
  });

  document.querySelectorAll("[data-learn-memory]").forEach((button) => {
    button.onclick = () => {
      learnSelectedMemoryId = button.dataset.learnMemory || null;
      renderLearnProfile({ patch: true });
    };
  });

  document.querySelectorAll("input[data-learn-feedback]").forEach((input) => {
    input.onchange = () => {
      if (!input.checked) return;
      mutateLearn("/admin/api/learn/feedback", {
        id: input.dataset.memoryId,
        value: input.dataset.learnFeedback,
      });
    };
  });

  document.querySelectorAll("[data-learn-delete]").forEach((button) => {
    button.onclick = () => mutateLearn("/admin/api/learn/delete", { id: button.dataset.learnDelete });
  });
}


async function loadLearn({ patch = false } = {}) {
  setHeader("My Learn", "Your adaptive preferences and reusable working patterns");
  const data = await api("/admin/api/learn?limit=100");
  learnProfileSnapshot = {
    ...data,
    summary: data.summary || learnSummary(Array.isArray(data.items) ? data.items : []),
  };
  renderLearnProfile({ patch });
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
  if (activeView !== "learn") void refreshActiveIncrementally();
}
window.addEventListener("online", updateDashboardAvailability);
window.addEventListener("offline", updateDashboardAvailability);
document.addEventListener("visibilitychange", updateDashboardAvailability);
