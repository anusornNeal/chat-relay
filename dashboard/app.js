let csrf = "";
let currentUser = null;
let activeView = "overview";
let pollTimer = null;
let pendingDeleteUser = null;
let dashboardPeriod = null;
let adminUsersCache = [];
let callFilters = { userId: "", status: "", query: "", from: "", to: "", drilldown: false };

const BKK_TZ = "Asia/Bangkok";
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtNum = (v) => new Intl.NumberFormat("en-US").format(Number(v || 0));
const fmtMs = (v) => Number(v || 0) >= 1000 ? (Number(v) / 1000).toFixed(1) + "s" : Math.round(Number(v || 0)) + " ms";
const fmtPct = (v) => ((Number(v || 0)) * 100).toFixed(1) + "%";
const bkkDateTime = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(new Date(iso));
const bkkTime = (iso) => new Intl.DateTimeFormat("en-GB", {
  timeZone: BKK_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));
const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "-";
  if (ms < 60000) return Math.max(0, Math.floor(ms / 1000)) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h";
  return Math.floor(ms / 86400000) + "d";
};

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
  "requestBytes", "responseBytes", "ok",
];
function registerDetail(event) {
  const safe = {};
  for (const key of SAFE_DETAIL_KEYS) if (event?.[key] !== undefined) safe[key] = event[key];
  const id = "detail-" + (++detailSeq);
  detailRecords.set(id, safe);
  return id;
}
function showDetail(id, title = "Safe metadata") {
  const data = detailRecords.get(id);
  if (!data) return;
  $("detailTitle").textContent = title;
  $("detailBody").innerHTML = Object.entries(data).map(([key, value]) =>
    '<div class="detail-row"><span class="detail-key">' + esc(key) + '</span><strong class="' + (key.endsWith("Id") ? "mono" : "") + '">' + esc(value) + "</strong></div>"
  ).join("");
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
  clearInterval(pollTimer);
  pollTimer = null;
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
  activeView = view;
  renderNav();
  showLoading();
  await loadActive();
}
async function loadActive() {
  setNotice("");
  try {
    if (activeView === "overview") await loadOverview();
    else if (activeView === "calls") await loadCalls();
    else if (activeView === "users") await loadUsers();
    else if (activeView === "errors") await loadErrors();
    touchFreshness();
  } catch (error) {
    if (error.message !== "unauthorized") {
      setNotice("Dashboard data is temporarily unavailable. Retrying automatically in 5 seconds.", true);
    }
  }
}
function metricCard(label, value, meta = "", tone = "") {
  return '<div class="metric ' + esc(tone) + '"><div class="metric-label">' + esc(label) + '</div>' +
    '<div class="metric-value">' + esc(value) + '</div><div class="metric-meta">' + esc(meta) + "</div></div>";
}
function periodChips(period) {
  return '<div class="period-chips"><span class="period-chip primary">' + icon("clock") + esc(period?.label || "Today") + '</span>' +
    '<span class="period-chip">' + esc(period?.timezoneLabel || "BKK · UTC+7") + "</span></div>";
}

function chartMarkup(buckets = []) {
  const max = Math.max(1, ...buckets.map((bucket) => Number(bucket.calls || 0)));
  const half = Math.ceil(max / 2);
  const yLabels = '<div class="chart-y-axis" aria-hidden="true"><span>' + fmtNum(max) + '</span><span>' + fmtNum(half) + '</span><span>0</span></div>';
  const bars = buckets.map((bucket, index) => {
    const calls = Number(bucket.calls || 0);
    const errors = Number(bucket.errors || 0);
    const height = Math.max(calls ? 6 : 2, (calls / max) * 100);
    const start = bkkTime(bucket.from);
    const end = bkkTime(new Date(Date.parse(bucket.to) + 1).toISOString());
    const label = start + "–" + end;
    return '<button class="chart-bar" data-chart-from="' + esc(bucket.from) + '" data-chart-to="' + esc(bucket.to) + '"' +
      ' aria-label="' + esc(label + ", " + calls + " tool calls, " + errors + " errors") + '">' +
      '<span class="chart-tooltip"><strong>' + esc(label) + '</strong><span>' + fmtNum(calls) + ' calls · ' + fmtNum(errors) + ' errors</span><small>Open filtered tool calls</small></span>' +
      '<span class="bar-fill" style="height:' + height + '%"></span>' +
      (index % 4 === 0 || index === buckets.length - 1 ? '<span class="chart-x-label">' + esc(start) + "</span>" : "") +
      "</button>";
  }).join("");
  return '<div class="chart-frame">' + yLabels + '<div class="chart-plot"><div class="chart-grid-lines"><i></i><i></i><i></i></div><div class="chart-bars">' + bars + "</div></div></div>";
}

async function loadOverview() {
  setHeader(isAdmin() ? "System overview" : "My overview", isAdmin() ? "Today across Chat Relay" : "Your activity today");
  const data = await api("/admin/api/overview");
  dashboardPeriod = data.period || dashboardPeriod || { label: "Today", timezoneLabel: "BKK · UTC+7" };
  const m = data.usage || {};
  const exactMeta = data.bounded ? "partial — safety bound reached" : "today";
  const cards = [
    metricCard(isAdmin() ? "Tool calls" : "My tool calls", fmtNum(m.calls), exactMeta),
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
  $("content").innerHTML =
    '<div class="overview-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + (isAdmin() ? "System-wide safe metadata" : "Only your activity") + "</span></div>" +
    boundedNotice +
    '<div class="metric-grid">' + cards.join("") + "</div>" +
    '<div class="layout-2 overview-layout"><section class="panel chart-panel"><div class="panel-heading"><div><div class="panel-kicker">Activity</div><h2>Usage by hour</h2></div><span class="panel-meta">Click a bar to inspect calls</span></div>' +
      chartMarkup(data.buckets || []) + "</section>" +
    '<section class="panel"><div class="panel-heading"><div><div class="panel-kicker">Breakdown</div><h2>Top tools</h2></div></div><div class="list top-tools">' +
      (top.length ? top.map((item, index) =>
        '<div class="list-row"><div class="tool-rank">' + (index + 1) + '</div><div class="list-copy"><div class="primary-text">' + esc(item.tool) +
        '</div><div class="secondary-text">' + esc(humanTool(item.tool)) + '</div></div><strong class="list-value">' + fmtNum(item.calls) + "</strong></div>"
      ).join("") : '<div class="empty-inline">No tool calls yet today.</div>') +
    "</div></section></div>";

  document.querySelectorAll("[data-chart-from]").forEach((bar) => {
    bar.onclick = async () => {
      callFilters.from = bar.dataset.chartFrom;
      callFilters.to = bar.dataset.chartTo;
      callFilters.drilldown = true;
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
      activityId: session.activityId,
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
      activityId: batch.activityId,
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
    ? bkkTime(callFilters.from) + "–" + bkkTime(new Date(Date.parse(callFilters.to) + 1).toISOString()) + " BKK"
    : "Today · BKK UTC+7";
  return '<div class="filters-panel"><div class="filters-row">' +
    '<label class="filter-control grow"><span>Search</span><div class="input-with-icon">' + icon("search") + '<input id="toolSearch" value="' + esc(callFilters.query) + '" placeholder="Tool, agent, activity"></div></label>' +
    userSelect +
    '<label class="filter-control"><span>Status</span><select id="callStatus">' + statusOptions + "</select></label>" +
    '<div class="filter-window"><span>Window</span><div class="window-chip">' + icon("clock") + esc(windowLabel) + "</div></div>" +
    (callFilters.drilldown ? '<button id="clearDrilldown" class="button subtle" type="button">' + icon("x") + "Clear bucket</button>" : "") +
    "</div></div>";
}

async function loadCalls() {
  setHeader(isAdmin() ? "Tool calls" : "My tool calls", "Running and completed activity in one timeline");
  await ensureCallPeriod();
  await loadAdminUsersForFilter();
  const from = callFilters.from || dashboardPeriod?.from;
  const to = callFilters.to || dashboardPeriod?.to;
  const params = new URLSearchParams({ state: "all", limit: "250" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (callFilters.status) params.set("status", callFilters.status);
  if (isAdmin() && callFilters.userId) params.set("userId", callFilters.userId);
  const data = await api("/admin/api/tool-calls?" + params);
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const terminalItems = (callFilters.status && callFilters.status !== "running" ? [] : activeTerminalRows(data.terminals || []))
    .filter((item) => !isAdmin() || !callFilters.userId || item.userId === callFilters.userId);
  const seen = new Set(rawItems.map((item) => item.toolCallId).filter(Boolean));
  const items = [...terminalItems.filter((item) => !item.toolCallId || !seen.has(item.toolCallId)), ...rawItems]
    .sort((a, b) => Date.parse(b.timestamp || b.startedAt || "") - Date.parse(a.timestamp || a.startedAt || ""));

  const tableRows = items.length ? items.map((event) => {
    const detailId = registerDetail(event);
    const when = event.timestamp || event.startedAt;
    const duration = event.status === "running" ? age(event.startedAt || event.timestamp) : fmtMs(event.durationMs);
    return '<tr data-filter-row data-detail-id="' + detailId + '" data-detail-title="Tool call detail">' +
      '<td class="time-cell"><strong>' + esc(when ? bkkTime(when) : "-") + '</strong><span>' + esc(when ? bkkDateTime(when) : "") + "</span></td>" +
      (isAdmin() ? '<td><span class="user-cell">' + esc(event.userId || "-") + "</span></td>" : "") +
      '<td><div class="tool-cell"><span class="tool-icon">' + icon(event.tool?.startsWith("terminal") ? "terminal" : "activity") + '</span><div><strong>' + esc(event.tool || "-") + '</strong><span>' + esc(humanTool(event.tool)) + "</span></div></div></td>" +
      '<td>' + esc(event.agentId || "-") + "</td>" +
      '<td class="mono">' + esc(event.activityId || "Ungrouped") + "</td>" +
      '<td>' + esc(duration) + "</td>" +
      '<td>' + statusBadge(event.status || (event.ok ? "success" : "error")) + "</td>" +
      '<td class="row-chevron">' + icon("chevron") + "</td></tr>";
  }).join("") : '<tr><td colspan="' + (isAdmin() ? "8" : "7") + '"><div class="table-empty">' + icon("activity") + '<strong>No tool calls in this window</strong><span>Activity will appear on the next refresh.</span></div></td></tr>';

  $("content").innerHTML =
    '<div class="section-toolbar">' + periodChips(dashboardPeriod) +
      '<span class="privacy-chip">' + icon("info") + "Safe metadata only</span></div>" +
    (data.bounded ? '<div class="data-warning">' + icon("alert") + "<span>History reached its safe bound; results are partial.</span></div>" : "") +
    callFilterMarkup() +
    '<div class="table-wrap calls-table"><table><thead><tr><th>Time</th>' + (isAdmin() ? "<th>User</th>" : "") +
      "<th>Tool</th><th>Agent</th><th>Activity</th><th>Duration</th><th>Status</th><th></th></tr></thead><tbody>" + tableRows + "</tbody></table></div>";

  const search = $("toolSearch");
  if (search) {
    search.oninput = () => {
      callFilters.query = search.value;
      const q = search.value.trim().toLowerCase();
      document.querySelectorAll("[data-filter-row]").forEach((row) => {
        row.hidden = Boolean(q && !row.textContent.toLowerCase().includes(q));
      });
    };
    search.dispatchEvent(new Event("input"));
  }
  if ($("callUser")) $("callUser").onchange = async () => { callFilters.userId = $("callUser").value; showLoading(); await loadCalls(); };
  if ($("callStatus")) $("callStatus").onchange = async () => { callFilters.status = $("callStatus").value; showLoading(); await loadCalls(); };
  if ($("clearDrilldown")) $("clearDrilldown").onclick = async () => {
    callFilters.from = "";
    callFilters.to = "";
    callFilters.drilldown = false;
    showLoading();
    await loadCalls();
  };
  bindDetailRows();
}

async function loadUsers() {
  if (!isAdmin()) return switchView("overview");
  setHeader("Users", "Access, roles, and connected agents");
  const data = await api("/admin/api/users?limit=100");
  adminUsersCache = Array.isArray(data.items) ? data.items : adminUsersCache;
  const rows = (data.items || []).map((user) => {
    const agentMeta = fmtNum(user.agentCount) + " assigned · " + fmtNum(user.onlineAgentCount) + " online";
    return '<tr data-filter-row><td><div class="identity-stack"><span class="avatar">' + esc((user.name || user.login || "?").slice(0, 1).toUpperCase()) + '</span><div><div class="primary-text">' + esc(user.name) + '</div><div class="secondary-text">' + esc(user.login || user.id) + "</div></div></div></td>" +
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

  $("content").innerHTML =
    '<div class="filters-panel compact"><div class="filters-row"><label class="filter-control grow"><span>Search users</span><div class="input-with-icon">' +
      icon("search") + '<input id="userSearch" placeholder="Name, login, role, agent"></div></label>' +
      '<button id="addUser" class="button primary" type="button">' + icon("plus") + "Add user</button></div></div>" +
    '<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Agents</th><th>Created</th><th>Action</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6"><div class="table-empty">No users.</div></td></tr>') + "</tbody></table></div>";

  bindTableFilter("userSearch");
  $("addUser").onclick = () => { $("userForm").reset(); $("userFormError").textContent = ""; $("userDialog").showModal(); };
  document.querySelectorAll("[data-delete]").forEach((button) => button.onclick = () => {
    pendingDeleteUser = button.dataset.delete;
    $("confirmCopy").textContent = "Disable dashboard and relay access for " + button.dataset.name + "?";
    $("confirmDialog").showModal();
  });
  document.querySelectorAll("[data-restore]").forEach((button) => button.onclick = async () => {
    await api("/admin/api/users/restore", { method: "POST", body: JSON.stringify({ userId: button.dataset.restore }) });
    await loadUsers();
  });
}

async function loadErrors() {
  if (!isAdmin()) return switchView("overview");
  setHeader("Errors", "Safe failure metadata for today");
  await ensureCallPeriod();
  const params = new URLSearchParams({ limit: "150" });
  if (dashboardPeriod?.from) params.set("from", dashboardPeriod.from);
  if (dashboardPeriod?.to) params.set("to", dashboardPeriod.to);
  const data = await api("/admin/api/errors?" + params);
  const items = data.items || [];
  const rows = items.length ? items.map((event) => {
    const detailId = registerDetail(event);
    const code = event.errorCode || event.errorClass || "tool_error";
    const source = event.errorSource || "tool";
    return '<tr data-filter-row data-detail-id="' + detailId + '" data-detail-title="Error detail">' +
      '<td class="time-cell"><strong>' + esc(bkkTime(event.timestamp)) + '</strong><span>' + esc(bkkDateTime(event.timestamp)) + "</span></td>" +
      '<td><div class="error-cell"><span class="error-icon">' + icon("alert") + '</span><div><strong>' + esc(code) + '</strong><span>' + esc(source + " · " + (event.errorClass || "tool_error")) + "</span></div></div></td>" +
      '<td>' + esc(event.userId) + "</td><td>" + esc(event.tool) + "</td><td>" + esc(event.agentId || "-") + "</td>" +
      '<td>' + esc(fmtMs(event.durationMs)) + '</td><td class="mono">' + esc(event.activityId || "Ungrouped") + "</td>" +
      '<td>' + esc(event.exitCode ?? event.statusCode ?? "-") + '</td><td class="row-chevron">' + icon("chevron") + "</td></tr>";
  }).join("") : '<tr><td colspan="9"><div class="table-empty">' + icon("check") + '<strong>No errors today</strong><span>Safe error metadata will appear here if a call fails.</span></div></td></tr>';

  $("content").innerHTML =
    '<div class="section-toolbar">' + periodChips(dashboardPeriod) + '<span class="privacy-chip">' + icon("info") + "No commands, args, payloads, or output stored</span></div>" +
    (data.bounded ? '<div class="data-warning">' + icon("alert") + "<span>Error history reached its safe bound; results are partial.</span></div>" : "") +
    '<div class="filters-panel compact"><div class="filters-row"><label class="filter-control grow"><span>Search errors</span><div class="input-with-icon">' + icon("search") +
      '<input id="errorSearch" placeholder="Code, source, user, tool, agent"></div></label></div></div>' +
    '<div class="table-wrap error-table"><table><thead><tr><th>Time</th><th>Error</th><th>User</th><th>Tool</th><th>Agent</th><th>Duration</th><th>Activity</th><th>Code</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table></div>";
  bindDetailRows();
  bindTableFilter("errorSearch");
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
    await loadActive();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => loadActive(), 5000);
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
    await loadUsers();
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
  await loadUsers();
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
    await loadActive();
    pollTimer = setInterval(() => loadActive(), 5000);
  } catch {}
})();
