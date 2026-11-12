import { usageDirectory, toolCallSeries } from "./ux-insights.js";

// A comparison-first Tool Calls workspace. One overview request per period;
// a user-specific time series is fetched only when a row is opened.
export function createUsageWorkspace({
  api, renderContent, setHeader, setNotice, isAdmin, isActive, getCurrentUser, getRange,
  setRange, setPeriod, periodChips, periodDisplayLabel, icon, esc,
  fmtNum, fmtMs, fmtPct, renderHourlyChart,
}) {
  let snapshot = null;
  let mode = "active";
  let query = "";
  let sortBy = "calls";
  let sortDirection = "desc";
  const expandedIds = new Set();
  const expandedMetricsIds = new Set();
  const loadingKeys = new Set();
  const detailErrors = new Map();
  let loadSequence = 0;
  const detailsCache = new Map();
  const inFlight = new Set();
  const bkkDate = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Bangkok", day: "numeric", month: "short"});
  const bkkFull = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short"});

  const titleFor = (account) => String(account.name || account.login || account.userId || "Unknown");
  const agentsFor = (account) => Array.isArray(account.agents) ? account.agents : [];
  const cacheKey = (userId, range = getRange()) => range + ":" + userId;
  const scopeTitle = () => isAdmin() ? "Usage by user" : "Your Tool Calls";
  const currentPeriod = () => snapshot?.period || {range: getRange()};
  const dateWindow = () => {
    const p = currentPeriod();
    if (!p.from || !p.to) return periodDisplayLabel(p.range);
    const from = bkkDate.format(new Date(p.from));
    const to = bkkDate.format(new Date(p.to));
    return from === to ? from : from + " – " + to;
  };
  const accountSort = (items) => {
    const arranged = usageDirectory(items, query, sortBy);
    return sortDirection === "asc" ? arranged.reverse() : arranged;
  };
  const activeCache = (userId) => detailsCache.get(cacheKey(userId));

  function adminControls(account) {
    if (!isAdmin() || account.userId === getCurrentUser()?.id) return "";
    return '<details class="ledger-admin-controls"><summary>Account actions · Admin only</summary>' +
      '<p>Account changes are separate from usage statistics and require confirmation.</p>' +
      '<button type="button" class="button small danger" data-ledger-delete="' + esc(account.userId) + '">Delete account</button></details>';
  }

  function renderTimeline(summary, account) {
    const period = summary.period || currentPeriod();
    const daily = toolCallSeries(summary.buckets, period);
    const byHour = period.range === "today";
    const monthly = period.range === "30d";
    const max = Math.max(1, ...daily.map(row => row.calls));
    const total = Number.isFinite(Number(summary.usage?.calls)) ? Number(summary.usage.calls) :
      daily.reduce((sum,row) => sum + row.calls,0);
    const shortDay = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Bangkok",weekday:"short"});
    const visualization = byHour
      ? '<div class="ledger-hour-chart">' + renderHourlyChart(summary.buckets || [], period) + '</div>'
      : '<div class="daily-bars' + (monthly ? ' thirty' : '') + '" role="list" aria-label="Tool Calls by day">' +
        daily.map((row,index) => {
          const date = new Date(row.from);
          const label = bkkFull.format(date);
          const height = row.calls ? Math.max(4,row.calls/max*100) : 0;
          const showTick = !monthly || index % 5 === 0 || index === daily.length-1;
          const amount = showTick ? fmtNum(row.calls) : ' ';
          return '<div class="daily-column" tabindex="0" role="listitem" title="' +
            esc(label + ': ' + fmtNum(row.calls) + ' Tool Calls') + '" aria-label="' +
            esc(label + ': ' + fmtNum(row.calls) + ' Tool Calls') + '">' +
            '<strong>' + amount + '</strong><div class="daily-bar-area" aria-hidden="true"><span style="height:' +
            height.toFixed(2) + '%"></span></div>' +
            '<span aria-hidden="true">' + (showTick ? esc(shortDay.format(date)) : ' ') + '</span>' +
            '<small aria-hidden="true">' + (showTick ? esc(bkkDate.format(date)) : ' ') + '</small></div>';
        }).join('') + '</div>';
    const metrics = summary.usage || {};
    const metricsOpen = expandedMetricsIds.has(account.userId);
    const agentRows = agentsFor(account).map(agent => {
      const state = agent.online === true ? "online" : agent.online === false ? "offline" : "unknown";
      const statusText = state === "online" ? "Online" : state === "offline" ? "Offline" : "Status unavailable";
      return '<div class="ledger-agent-row"><div class="ledger-agent-name"><strong>' +
        esc(agent.name || agent.agentId) + '</strong><small>' + esc(agent.agentId) + '</small></div>' +
        '<span class="ledger-agent-status ' + state + '"><i aria-hidden="true"></i>' +
        statusText + '</span><strong class="ledger-agent-calls">' + fmtNum(agent.calls) + '</strong></div>';
    }).join('');
    const performance = [['Avg latency',fmtMs(metrics.avgDurationMs)],['p95 latency',fmtMs(metrics.p95DurationMs)],
      ['Errors',fmtNum(metrics.operationalErrors || 0)],['Error rate',fmtPct(metrics.operationalErrorRate)]]
      .map(([label,value])=>'<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('');
    const toggle = (label,meta) => '<button type="button" class="ledger-metrics-button" data-ledger-metrics="' +
      esc(account.userId) + '" aria-expanded="' + metricsOpen + '">' +
      '<span>' + esc(label) + '</span><span class="ledger-metrics-meta">' + esc(meta) + '</span>' +
      '<span class="ledger-metrics-chevron" aria-hidden="true">' + (metricsOpen ? '−' : '+') + '</span></button>';
    return '<div class="ledger-expanded-inner"><div class="ledger-timeline-top"><div><h3>' +
      (byHour ? 'Today by hour' : monthly ? 'Last 30 days' : 'Last 7 days') + '</h3></div>' +
      '<div class="ledger-detail-total"><strong>' + fmtNum(total) + '</strong><span>Total</span></div></div>' +
      visualization +
      '<div class="ledger-disclosures">' +
      '<section class="ledger-metrics-card">' + toggle('Agents',fmtNum(agentsFor(account).length)) +
      (metricsOpen ? '<div class="ledger-agent-list">' + (agentRows || '<p class="ledger-muted">No agents</p>') + '</div>' : '') +
      '</section>' +
      '<section class="ledger-metrics-card">' + toggle('Performance','Details') +
      (metricsOpen ? '<div class="ledger-diagnostic-grid">' + performance + '</div>' : '') +
      '</section></div>' +
      (summary.bounded === true ? '<p class="ledger-caveat">Partial history</p>' : '') +
      adminControls(account) + '</div>';
  }

  function renderExpanded(account) {
    if (mode === "deleted") return '<div class="ledger-inline-error">' +
      '<p>This account is deleted. Restore it before viewing its detailed activity.</p>' +
      '<button type="button" class="button small" data-ledger-restore="' + esc(account.userId) + '">Restore account</button></div>';
    const detail = activeCache(account.userId);
    if (detail) return renderTimeline(detail, account);
    if (loadingKeys.has(cacheKey(account.userId))) return '<div class="ledger-loading" role="status">' +
      '<div class="skeleton" style="width:220px;height:16px"></div>' +
      '<div class="skeleton" style="width:100%;height:76px"></div>' +
      '<span>Loading ' + esc(account.name || account.login || "user") + ' daily usage…</span></div>';
    return '<div class="ledger-inline-error" role="status">' +
      '<p>' + esc(detailErrors.get(cacheKey(account.userId)) || "Daily breakdown is not loaded.") + '</p>' +
      '<button class="button small" type="button" data-ledger-retry="' + esc(account.userId) + '">Load breakdown</button></div>';
  }

  function render({patch = false} = {}) {
    if (!isActive()) return;
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const matched = accountSort(accounts);
    const total = accounts.reduce((sum, x) => sum + Math.max(0, Number(x.calls || 0)), 0);
    const allAgents = new Set(accounts.flatMap((entry) => agentsFor(entry).map((agent) => agent.agentId)));
    const members = accounts.length;
    const highestCalls = Math.max(1,...accounts.map(account => Math.max(0,Number(account.calls || 0))));
    const admin = isAdmin();
    const header = scopeTitle();
    setHeader(header, "");

    const rows = matched.map((account, index) => {
      const calls = Math.max(0, Number(account.calls || 0));
      const open = expandedIds.has(account.userId);
      const agentCount = agentsFor(account).length;
      return '<tr class="ledger-person-row' + (open ? ' selected' : '') + '" data-live-key="ledger-user-' + esc(account.userId) + '">' +
        '<th scope="row"><button type="button" class="ledger-person" data-ledger-user="' + esc(account.userId) +
          '" aria-expanded="' + open + '" aria-label="' + esc((open ? 'Collapse' : 'Show') + ' Tool Calls by day for ' + titleFor(account)) + '">' +
          '<span class="ledger-rank" aria-hidden="true">' + String(index+1).padStart(2,'0') + '</span>' +
          '<span class="ledger-person-name"><strong>' + esc(titleFor(account)) + '</strong><span>' + esc(account.login || account.userId) + '</span></span>' +
          icon("chevron") + '</button></th>' +
        '<td class="ledger-numeric ledger-call-count"><span class="ledger-call-visual">' +
          '<span class="ledger-volume-track" aria-hidden="true"><i style="width:' +
          (calls/highestCalls*100).toFixed(2) + '%"></i></span><strong>' + fmtNum(calls) +
          '</strong></span></td>' +

        '<td class="ledger-numeric ledger-agent-count">' + fmtNum(agentCount) + '</td>' +
      '</tr>' + (open ? '<tr class="ledger-detail-row"><td colspan="' + 3 +
        '" class="ledger-detail-cell">' + renderExpanded(account) + '</td></tr>' : '');
    }).join("");

    const accountStatusControls = admin
      ? '<div class="ledger-role-tabs" role="group" aria-label="Account status">' +
        [['active','Active'],['deleted','Deleted']].map(([value,label]) =>
          '<button type="button" class="' + (mode===value?' active':'') + '" data-usage-user-mode="' + value +
          '" aria-pressed="' + (mode===value) + '">' + label + '</button>').join('') + '</div>'
      : '<span class="ledger-self-label">' + icon("check") + ' Personal usage</span>';

    const period = currentPeriod();
    const windowLabel = dateWindow();
    renderContent(
      '<div class="ledger-heading"><span class="ledger-kicker">TOOL CALLS · BKK</span><div class="ledger-period">' + periodChips(period) + '</div></div>' +
      '<section class="ledger-summary" aria-label="Usage summary"><div class="ledger-main-number"><span>Tool Calls</span><strong>'+fmtNum(total)+'</strong></div>' +
      '<div class="ledger-summary-facts"><div><strong>'+fmtNum(members)+'</strong><span>Users</span></div>' +
      '<div><strong>'+fmtNum(allAgents.size)+'</strong><span>Agents</span></div></div>' +
      '<span class="ledger-window-label">'+esc(windowLabel)+'</span></section>' +
      '<section class="ledger-table-section" aria-label="User Tool Calls comparison">' +
        '<div class="ledger-table-heading"><div><h3>' + (admin ? "By user" : "Your activity") + '</h3></div>' +
          '<div class="ledger-table-actions">' + accountStatusControls +
            '<label class="ledger-search"><span class="sr-only">Search users or agents</span>' + icon("search") +
            '<input type="search" id="usageSearch" value="' + esc(query) + '" placeholder="Find a person or agent..." aria-label="Search users or agents"></label></div></div>' +
        '<div class="ledger-table-scroll"><table class="ledger-table">' +
          '<caption class="sr-only">Tool Calls per account for ' + esc(windowLabel) + ' in Asia/Bangkok</caption>' +
          '<thead><tr><th scope="col">' +
            '<button type="button" data-ledger-sort="name" aria-label="Sort by name">USER <span aria-hidden="true">' + (sortBy==="name" ? (sortDirection==="asc" ? "↑" : "↓") : "") + '</span></button></th>' +
          '<th scope="col" class="ledger-numeric" aria-sort="' + (sortBy==="calls" ? sortDirection==="desc"?"descending":"ascending" : "none") + '">' +
            '<button type="button" data-ledger-sort="calls" aria-label="Sort by Tool Calls">TOOL CALLS <span aria-hidden="true">' + (sortBy==="calls" ? (sortDirection==="desc" ? "↓" : "↑") : "") + '</span></button></th>' +
          '<th scope="col" class="ledger-numeric">AGENTS</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="' + 3 +
            '"><div class="ledger-empty"><strong>No matching users</strong><span>Try changing your search or account status.</span></div></td></tr>') +
          '</tbody><tfoot><tr><th scope="row">TOTAL · ' + fmtNum(accounts.length) + ' ' + (admin ? "users":"user") + '</th>' +
            '<td class="ledger-numeric">' + fmtNum(total) + '</td>' +
            '<td class="ledger-numeric">' + fmtNum(allAgents.size) + '</td></tr></tfoot></table></div></section>' +
      '<span class="ledger-footnote">Tool Calls · Bangkok time</span>',
      patch,
    );

    const search = document.getElementById("usageSearch");
    if (search) search.oninput = () => {query = search.value;render({patch:true})};
    document.querySelectorAll("[data-ledger-sort]").forEach((button) => {
      button.onclick = () => {
        const key = button.dataset.ledgerSort;
        if (sortBy === key) sortDirection = sortDirection === "asc" ? "desc" : "asc";
        else {sortBy = key; sortDirection = key === "calls" ? "desc" : "asc";}
        render({patch:true});
      };
    });
    document.querySelectorAll("[data-ledger-user]").forEach((button) => {
      button.onclick = () => {
        const nextId = button.dataset.ledgerUser;
        if (expandedIds.has(nextId)) expandedIds.delete(nextId);
        else expandedIds.add(nextId);
        render({patch:true});
        if (expandedIds.has(nextId)) void loadDetails(nextId);
      };
    });
    document.querySelectorAll("[data-ledger-metrics]").forEach((button) => button.onclick = () => {
      const id = button.dataset.ledgerMetrics;
      if (expandedMetricsIds.has(id)) expandedMetricsIds.delete(id);
      else expandedMetricsIds.add(id);
      render({patch:true});
    });
    document.querySelectorAll("[data-ledger-retry]").forEach((button) => button.onclick = () =>
      void loadDetails(button.dataset.ledgerRetry, true));
    document.querySelectorAll("[data-ledger-delete],[data-ledger-restore]").forEach((button) => {
      button.onclick = async () => {
        const userId = button.dataset.ledgerDelete || button.dataset.ledgerRestore;
        const target = accounts.find((account) => account.userId === userId);
        if (!isAdmin() || !target || target.userId === getCurrentUser()?.id) return;
        const restoring = Boolean(button.dataset.ledgerRestore);
        const label = restoring ? "Restore" : "Delete";
        if (!window.confirm(label + " account " + titleFor(target) + "?")) return;
        button.disabled = true;
        try {
          await api(restoring ? "/admin/api/users/restore" : "/admin/api/users/soft-delete",
            {method:"POST",body:JSON.stringify({userId})});
          expandedIds.delete(userId);
          expandedMetricsIds.delete(userId);
          await load({patch:true});
        } catch {
          button.disabled = false;
          setNotice("Could not " + label.toLowerCase() + " this account. Please retry.",true);
        }
      };
    });
    document.querySelectorAll("[data-overview-range]").forEach((button) => {
      button.onclick = () => {
        const range = button.dataset.overviewRange;
        if (range === getRange()) return;
        setRange(range);
        void load({patch:true});
      };
    });
    document.querySelectorAll("[data-usage-user-mode]").forEach((button) => {
      button.onclick = () => {
        const next = button.dataset.usageUserMode;
        if (next === mode) return;
        mode = next === "deleted" ? "deleted" : "active";
        void load({patch:true});
      };
    });
  }

  async function loadDetails(userId, force = false) {
    const range = getRange();
    const key = cacheKey(userId, range);
    if (mode === "deleted" || inFlight.has(key)) return;
    if (!force && detailsCache.has(key)) return;
    inFlight.add(key);
    loadingKeys.add(key);
    detailErrors.delete(key);
    render({patch:true});
    try {
      const result = await api("/admin/api/summary?range=" + encodeURIComponent(range) +
        (isAdmin() ? "&userId=" + encodeURIComponent(userId) : ""));
      detailsCache.set(key, result);
    } catch {
      detailErrors.set(key,"Unable to load this user's breakdown.");
      setNotice("Could not load the daily Tool Calls breakdown. Please retry.", true);
    } finally {
      inFlight.delete(key);
      loadingKeys.delete(key);
      if (expandedIds.has(userId) && key === cacheKey(userId)) render({patch:true});
    }
  }

  async function load({patch=false}={}) {
    const sequence = ++loadSequence;
    const showDeleted = isAdmin() && mode === "deleted";
    const response = await api("/admin/api/overview?range=" + encodeURIComponent(getRange()) +
      (isAdmin() ? "&deleted=" + String(showDeleted) : ""));
    if (sequence !== loadSequence) return;
    setPeriod(response.period);
    snapshot = response;
    const accounts = Array.isArray(response.accounts) ? response.accounts : [];
    const accountIds=new Set(accounts.map(account=>account.userId));
    for(const id of expandedIds) if(!accountIds.has(id)) expandedIds.delete(id);
    for(const id of expandedMetricsIds) if(!accountIds.has(id)) expandedMetricsIds.delete(id);
    if(!isAdmin() && accounts[0]) expandedIds.add(accounts[0].userId);
    render({patch});
    for(const id of expandedIds) if(!detailsCache.has(cacheKey(id)) && !inFlight.has(cacheKey(id))) void loadDetails(id);
  }
  return {load};
}
