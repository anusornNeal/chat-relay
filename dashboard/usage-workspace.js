import { usageDirectory, toolCallSeries } from "./ux-insights.js";

// A comparison-first Tool Calls workspace. One overview request per period;
// a user-specific time series is fetched only when a row is opened.
export function createUsageWorkspace({
  api, renderContent, setHeader, setNotice, isAdmin, isActive, getCurrentUser, getRange,
  setRange, setPeriod, periodChips, periodDisplayLabel, icon, esc,
  fmtNum, fmtMs, fmtPct, openOverview,
}) {
  let snapshot = null;
  let mode = "active";
  let query = "";
  let sortBy = "calls";
  let sortDirection = "desc";
  let selectedId = "";
  let loadingDetails = "";
  let detailError = "";
  let loadSequence = 0;
  const detailsCache = new Map();
  const inFlight = new Set();
  const bkkDate = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Bangkok", day: "numeric", month: "short"});
  const bkkFull = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short"});
  const bkkTime = new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false});

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
  const activeCache = () => detailsCache.get(cacheKey(selectedId));

  function adminControls(account) {
    if (!isAdmin() || account.userId === getCurrentUser()?.id) return "";
    return '<details class="ledger-admin-controls"><summary>Account actions · Admin only</summary>' +
      '<p>Account changes are separate from usage statistics and require confirmation.</p>' +
      '<button type="button" class="button small danger" data-ledger-delete="' + esc(account.userId) + '">Delete account</button></details>';
  }

  function renderTimeline(summary, account) {
    const period = summary.period || currentPeriod();
    const daily = toolCallSeries(summary.buckets, period);
    const maximum = Math.max(1, ...daily.map((row) => row.calls));
    const byHour = period.range === "today";
    const rows = daily.map((entry) => {
      const label = byHour ? bkkTime.format(new Date(entry.from)) : bkkFull.format(new Date(entry.from));
      const percentage = Math.min(100, Math.max(0, entry.calls / maximum * 100));
      return '<div class="ledger-day-row" role="listitem" aria-label="' + esc(label + ": " + fmtNum(entry.calls) + " Tool Calls") + '">' +
        '<span class="ledger-day-label">' + esc(label) + '</span>' +
        '<span class="ledger-bar-track" aria-hidden="true"><span class="ledger-bar-fill" style="width:' + percentage.toFixed(2) + '%"></span></span>' +
        '<strong class="ledger-day-value">' + fmtNum(entry.calls) + '</strong></div>';
    }).join("");
    const summaryCalls = Number(summary.usage?.calls);
    const sum = Number.isFinite(summaryCalls) ? summaryCalls : daily.reduce((a, x) => a + x.calls, 0);
    const agentRows = agentsFor(account).map((agent) =>
      '<div class="ledger-agent-row"><div><strong>' + esc(agent.name || agent.agentId) + '</strong>' +
      '<span>' + esc(agent.agentId) + '</span></div><strong>' + fmtNum(agent.calls) + '</strong></div>').join("");
    const metrics = summary.usage || {};
    return '<div class="ledger-expanded-inner"><div class="ledger-timeline-top">' +
      '<div><p class="ledger-caption">ACTIVITY OVER TIME · ' + esc(period.timezoneLabel || "BKK · UTC+7") + '</p>' +
      '<h3>' + esc(titleFor(account)) + '</h3>' +
      '<p>' + esc(dateWindow()) + ' · ' + (byHour ? 'Hourly' : 'Daily') + ' Tool Calls</p></div>' +
      '<div class="ledger-detail-total"><strong>' + fmtNum(sum) + '</strong><span>Tool Calls</span></div></div>' +
      '<div class="ledger-day-list" role="list" aria-label="Tool Calls by ' + (byHour ? 'hour' : 'day') + '">' +
        (rows || '<p class="ledger-muted">No recorded Tool Calls during this period.</p>') + '</div>' +
      '<div class="ledger-disclosures">' +
        '<details><summary>Agent breakdown <span>' + fmtNum(agentsFor(account).length) + ' agents</span></summary>' +
          '<div class="ledger-agent-list">' + (agentRows || '<p class="ledger-muted">No agents assigned.</p>') + '</div></details>' +
        '<details><summary>Performance details <span>Advanced</span></summary>' +
          '<div class="ledger-diagnostic-grid">' +
          [['Avg latency',fmtMs(metrics.avgDurationMs)],['p95 latency',fmtMs(metrics.p95DurationMs)],
           ['Operational errors',fmtNum(metrics.operationalErrors || 0)],['Error rate',fmtPct(metrics.operationalErrorRate)]]
            .map(([label,value])=>'<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('') +
          '</div></details></div>' +
      (summary.bounded === true ? '<p class="ledger-caveat">Detailed history has bounded coverage. Values may be incomplete.</p>' : '') +
      '<div class="ledger-expanded-actions"><button type="button" class="ledger-link" data-ledger-refresh="' + esc(account.userId) + '">Refresh breakdown</button>' +
      '<button type="button" class="ledger-link" data-ledger-timeline="' + esc(account.userId) + '">Open activity overview ' + icon("chevron") + '</button></div>' +
      adminControls(account) + '</div>';
  }

  function renderExpanded(account) {
    if (mode === "deleted") return '<div class="ledger-inline-error">' +
      '<p>This account is deleted. Restore it before viewing its detailed activity.</p>' +
      '<button type="button" class="button small" data-ledger-restore="' + esc(account.userId) + '">Restore account</button></div>';
    const detail = activeCache();
    if (detail) return renderTimeline(detail, account);
    if (loadingDetails === account.userId) return '<div class="ledger-loading" role="status">' +
      '<div class="skeleton" style="width:220px;height:16px"></div>' +
      '<div class="skeleton" style="width:100%;height:76px"></div>' +
      '<span>Loading ' + esc(account.name || account.login || "user") + ' daily usage…</span></div>';
    return '<div class="ledger-inline-error" role="status">' +
      '<p>' + esc(detailError || "Daily breakdown is not loaded.") + '</p>' +
      '<button class="button small" type="button" data-ledger-retry="' + esc(account.userId) + '">Load breakdown</button></div>';
  }

  function render({patch = false} = {}) {
    if (!isActive()) return;
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const matched = accountSort(accounts);
    const selected = matched.find((item) => item.userId === selectedId);
    const total = accounts.reduce((sum, x) => sum + Math.max(0, Number(x.calls || 0)), 0);
    const allAgents = new Set(accounts.flatMap((entry) => agentsFor(entry).map((agent) => agent.agentId)));
    const members = accounts.length;
    const admin = isAdmin();
    const hasDeleted = admin && mode === "deleted";
    const range = getRange();
    const header = scopeTitle();
    setHeader(header, admin
      ? "Compare Tool Calls across people, then open a row for its daily breakdown"
      : "See your Tool Calls for the selected period, broken down by day or hour");

    const rows = matched.map((account, index) => {
      const calls = Math.max(0, Number(account.calls || 0));
      const ratio = total ? calls / total * 100 : 0;
      const open = selectedId === account.userId;
      const agentCount = agentsFor(account).length;
      return '<tr class="ledger-person-row' + (open ? ' selected' : '') + '" data-live-key="ledger-user-' + esc(account.userId) + '">' +
        '<th scope="row"><button type="button" class="ledger-person" data-ledger-user="' + esc(account.userId) +
          '" aria-expanded="' + open + '" aria-label="' + esc((open ? 'Collapse' : 'Show') + ' Tool Calls by day for ' + titleFor(account)) + '">' +
          '<span class="ledger-rank" aria-hidden="true">' + String(index+1).padStart(2,'0') + '</span>' +
          '<span class="ledger-person-name"><strong>' + esc(titleFor(account)) + '</strong><span>' + esc(account.login || account.userId) + '</span></span>' +
          icon("chevron") + '</button></th>' +
        '<td class="ledger-numeric ledger-call-count">' + fmtNum(calls) + '</td>' +
        (admin ? '<td class="ledger-share"><div aria-label="' + ratio.toFixed(1) + '% of Tool Calls across listed users">' +
          '<span class="ledger-mini-track" aria-hidden="true"><span style="width:' + ratio.toFixed(2) + '%"></span></span>' +
          '<span>' + ratio.toFixed(1) + '%</span></div></td>' : '') +
        '<td class="ledger-numeric ledger-agent-count">' + fmtNum(agentCount) + '</td>' +
      '</tr>' + (open ? '<tr class="ledger-detail-row"><td colspan="' + (admin ? 4 : 3) +
        '" class="ledger-detail-cell">' + renderExpanded(account) + '</td></tr>' : '');
    }).join("");

    const adminControls = admin
      ? '<div class="ledger-role-tabs" role="group" aria-label="Account status">' +
        [['active','Active'],['deleted','Deleted']].map(([value,label]) =>
          '<button type="button" class="' + (mode===value?' active':'') + '" data-usage-user-mode="' + value +
          '" aria-pressed="' + (mode===value) + '">' + label + '</button>').join('') + '</div>'
      : '<span class="ledger-self-label">' + icon("check") + ' Personal usage</span>';

    const period = currentPeriod();
    const windowLabel = dateWindow();
    const caption = hasDeleted ? "Deleted accounts only" : admin ? "Active accounts only" : "Your account";
    renderContent(
      '<div class="ledger-heading"><div class="ledger-intro"><span class="ledger-kicker">USAGE · TOOL CALLS</span>' +
        '<h2>' + (admin ? "Every call, accounted for." : "Your activity, at a glance.") + '</h2>' +
        '<p>Understand volume first. Inspect trends and agents only when you need them.</p></div>' +
        '<div class="ledger-period"><span>TIME WINDOW · ' + esc(period.timezoneLabel || "BKK / UTC+7") + '</span>' +
           periodChips(period) + '</div></div>' +
      '<section class="ledger-summary" aria-label="Usage summary"><div class="ledger-main-number"><span>' +
        (admin ? "TOOL CALLS BY LISTED USERS" : "YOUR TOOL CALLS") + '</span><strong>' + fmtNum(total) + '</strong>' +
        '<small>' + esc(windowLabel) + ' · ' + esc(caption) + '</small></div>' +
        '<div class="ledger-summary-facts"><div><strong>' + fmtNum(members) + '</strong><span>' + (admin ? "Users in view" : "User") + '</span></div>' +
        '<div><strong>' + fmtNum(allAgents.size) + '</strong><span>Related agents</span></div></div>' +
        '<div class="ledger-summary-hint">' + icon("info") + '<span>Today begins at 00:00 Bangkok time. Recent calls may appear after a short batching delay.</span></div></section>' +
      '<section class="ledger-table-section" aria-label="User Tool Calls comparison">' +
        '<div class="ledger-table-heading"><div><span class="ledger-kicker">' + (admin ? "PEOPLE" : "PERSONAL VIEW") + '</span>' +
          '<h3>' + (admin ? "Usage by person" : "Your daily breakdown") + '</h3>' +
          '<p>Click a name to see Tool Calls by ' + (range === "today" ? "hour" : "day") + '.</p></div>' +
          '<div class="ledger-table-actions">' + adminControls +
            '<label class="ledger-search"><span class="sr-only">Search users or agents</span>' + icon("search") +
            '<input type="search" id="usageSearch" value="' + esc(query) + '" placeholder="Find a person or agent..." aria-label="Search users or agents"></label></div></div>' +
        '<div class="ledger-table-scroll"><table class="ledger-table">' +
          '<caption class="sr-only">Tool Calls per account for ' + esc(windowLabel) + ' in Asia/Bangkok</caption>' +
          '<thead><tr><th scope="col">' +
            '<button type="button" data-ledger-sort="name" aria-label="Sort by name">USER <span aria-hidden="true">' + (sortBy==="name" ? (sortDirection==="asc" ? "↑" : "↓") : "") + '</span></button></th>' +
          '<th scope="col" class="ledger-numeric" aria-sort="' + (sortBy==="calls" ? sortDirection==="desc"?"descending":"ascending" : "none") + '">' +
            '<button type="button" data-ledger-sort="calls" aria-label="Sort by Tool Calls">TOOL CALLS <span aria-hidden="true">' + (sortBy==="calls" ? (sortDirection==="desc" ? "↓" : "↑") : "") + '</span></button></th>' +
          (admin ? '<th scope="col">SHARE OF LISTED</th>' : '') +
          '<th scope="col" class="ledger-numeric">AGENTS</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="' + (admin?4:3) +
            '"><div class="ledger-empty"><strong>No matching users</strong><span>Try changing your search or account status.</span></div></td></tr>') +
          '</tbody><tfoot><tr><th scope="row">TOTAL · ' + fmtNum(accounts.length) + ' ' + (admin ? "users":"user") + '</th>' +
            '<td class="ledger-numeric">' + fmtNum(total) + '</td>' + (admin ? '<td>100% of listed Tool Calls</td>' : '') +
            '<td class="ledger-numeric">' + fmtNum(allAgents.size) + '</td></tr></tfoot></table></div></section>' +
      '<p class="ledger-footnote">' + icon("info") +
        'Tool Calls measure calls to Relay tools, not model tokens or Cloudflare requests. Time boundaries: Asia/Bangkok. ' +
        'Totals cover the users shown in this account status.</p>',
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
        selectedId = selectedId === nextId ? "" : nextId;
        detailError = "";
        render({patch:true});
        if (selectedId) void loadDetails(selectedId);
      };
    });
    document.querySelectorAll("[data-ledger-retry]").forEach((button) => button.onclick = () =>
      void loadDetails(button.dataset.ledgerRetry, true));
    document.querySelectorAll("[data-ledger-refresh]").forEach((button) => button.onclick = () =>
      void loadDetails(button.dataset.ledgerRefresh, true));
    document.querySelectorAll("[data-ledger-timeline]").forEach((button) => button.onclick = () =>
      openOverview(button.dataset.ledgerTimeline));
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
          selectedId = "";
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
        selectedId = "";
        void load({patch:true});
      };
    });
    document.querySelectorAll("[data-usage-user-mode]").forEach((button) => {
      button.onclick = () => {
        const next = button.dataset.usageUserMode;
        if (next === mode) return;
        mode = next === "deleted" ? "deleted" : "active";
        selectedId = "";
        void load({patch:true});
      };
    });
  }

  async function loadDetails(userId, force = false) {
    const key = cacheKey(userId);
    if (mode === "deleted" || inFlight.has(key)) return;
    if (!force && detailsCache.has(key)) return;
    inFlight.add(key);
    loadingDetails = userId;
    detailError = "";
    render({patch:true});
    try {
      const result = await api("/admin/api/summary?range=" + encodeURIComponent(getRange()) +
        (isAdmin() ? "&userId=" + encodeURIComponent(userId) : ""));
      detailsCache.set(key, result);
    } catch {
      detailError = "Unable to load this user's breakdown. Your comparison table remains available.";
      setNotice("Could not load the daily Tool Calls breakdown. Please retry.", true);
    } finally {
      inFlight.delete(key);
      if (loadingDetails === userId) loadingDetails = "";
      if (selectedId === userId && key === cacheKey(userId)) render({patch:true});
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
    if (selectedId && !accounts.some((account) => account.userId === selectedId)) selectedId = "";
    // A regular user has only their own row; show their time series without a second click.
    if (!isAdmin() && !selectedId) selectedId = accounts[0]?.userId || "";
    render({patch});
    if (selectedId && !detailsCache.has(cacheKey(selectedId))) void loadDetails(selectedId);
  }
  return {load};
}
