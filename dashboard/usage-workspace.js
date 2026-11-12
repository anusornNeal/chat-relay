import { usageDirectory } from "./ux-insights.js";

// Investigation UI only. Server data remains authoritative for permissions and usage totals.
export function createUsageWorkspace({
  api, renderContent, setHeader, setNotice, isAdmin, getCurrentUser, getRange,
  setRange, setPeriod, periodChips, periodDisplayLabel, metricCard, icon, esc,
  fmtNum, fmtMs, fmtPct, openOverview,
}) {
  let snapshot = null;
  let loadSequence = 0;
  let selectedId = "";
  let search = "";
  let sort = "calls";
  let onlineFilter = "all";
  const summaries = new Map();

  const accountTitle = (account) => String(account?.name || account?.login || account?.userId || "Unknown account");
  const agentsOf = (account) => Array.isArray(account?.agents) ? account.agents : [];
  const summaryKey = (account) => getRange() + ":" + (isAdmin() ? account.userId : "self");
  const summaryOf = (account) => summaries.get(summaryKey(account));
  const pill = (label, value, count) => '<button type="button" class="ux-segment' + (onlineFilter === value ? ' active' : '') +
    '" aria-pressed="' + (onlineFilter === value) + '" data-agent-filter="' + value + '">' + label +
    (count == null ? '' : '<span>' + fmtNum(count) + '</span>') + '</button>';

  function agentRows(account) {
    const all = agentsOf(account);
    const shown = all.filter((agent) => onlineFilter === "all" ||
      (onlineFilter === "online" ? agent.online : !agent.online));
    if (!shown.length) return '<p class="ux-empty-inline">No agents match this connection filter.</p>';
    const peak = Math.max(1, ...all.map((agent) => Number(agent.calls || 0)));
    return shown.map((agent) => {
      const calls = Math.max(0, Number(agent.calls || 0));
      const percent = Math.min(100, Math.max(0, (calls / peak) * 100));
      return '<div class="ux-agent-line" data-live-key="' + esc(account.userId + ":" + agent.agentId) + '">' +
        '<div class="ux-agent-line-top"><div class="ux-agent-identity"><span class="agent-dot ' + (agent.online ? "online" : "") + '"></span>' +
          '<div><strong>' + esc(agent.name || agent.agentId) + '</strong><small>' + esc(agent.agentId) + '</small></div></div>' +
          '<div class="ux-agent-usage"><strong>' + fmtNum(calls) + '</strong><small>calls</small></div></div>' +
        '<div class="ux-agent-track"><span style="width:' + percent.toFixed(2) + '%"></span></div></div>';
    }).join("");
  }

  function reliabilityPanel(account) {
    const pending = summaryOf(account);
    if (!pending) return '<div class="ux-investigate-empty">' +
      '<span class="ux-investigate-mark">' + icon("activity") + '</span>' +
      '<h3>Investigate performance</h3>' +
      '<p>Load latency and operational errors for this account only when you need them. No extra requests while browsing.</p>' +
      '<button type="button" class="button primary" id="usageInspectMetrics">' + icon("activity") + 'Inspect latency & errors</button></div>';
    const metrics = pending.usage || {};
    const bounded = pending.bounded === true;
    return '<div class="ux-insight-metrics">' +
      '<div><span>Average latency</span><strong>' + esc(fmtMs(metrics.avgDurationMs)) + '</strong></div>' +
      '<div><span>p95 latency</span><strong>' + esc(fmtMs(metrics.p95DurationMs)) + '</strong></div>' +
      '<div><span>Operational errors</span><strong>' + fmtNum(metrics.operationalErrors ?? metrics.errors ?? 0) + '</strong></div>' +
      '<div><span>Operational error rate</span><strong>' + esc(fmtPct(metrics.operationalErrorRate ?? metrics.errorRate)) + '</strong></div>' +
    '</div>' + (bounded ? '<p class="ux-insight-note">Detailed history is partially bounded; metrics may not cover the full period.</p>' : '') +
    '<div class="ux-insight-foot"><span>Account metrics · ' + esc(periodDisplayLabel(getRange())) + '</span>' +
      '<button type="button" class="button small" id="usageInspectMetrics">Refresh metrics</button></div>';
  }

  function render({ patch = false } = {}) {
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const matching = usageDirectory(accounts, search, sort);
    const showDeleted = isAdmin() && snapshot?.showDeleted;
    if (!matching.some((account) => account.userId === selectedId)) selectedId = matching[0]?.userId || "";
    const chosen = matching.find((account) => account.userId === selectedId);
    const totalCalls = accounts.reduce((sum, acc) => sum + Math.max(0, Number(acc.calls || 0)), 0);
    const totalAgents = accounts.reduce((sum, acc) => sum + agentsOf(acc).length, 0);
    const onlineCount = accounts.reduce((sum, acc) => sum + agentsOf(acc).filter((agent) => agent.online).length, 0);

    const userTabs = isAdmin()
      ? '<div class="usage-user-tabs" role="group" aria-label="Account status">' +
        ['active', 'deleted'].map((mode) =>
          '<button type="button" class="usage-user-tab ' + ((showDeleted ? 'deleted' : 'active') === mode ? 'active' : '') +
          '" data-usage-user-mode="' + mode + '" aria-pressed="' + ((showDeleted ? 'deleted' : 'active') === mode) + '">' +
            (mode === "deleted" ? 'Deleted' : 'Active') + '</button>').join("") + '</div>'
      : '<span class="ux-own-account">Your account only</span>';

    const accountRows = matching.map((account) => {
      const active = chosen?.userId === account.userId;
      const amount = Math.max(0, Number(account.calls || 0));
      const share = totalCalls ? Math.round(amount / totalCalls * 100) : 0;
      return '<button class="ux-account-row' + (active ? ' active' : '') +
        '" type="button" aria-pressed="' + active + '" data-usage-account="' + esc(account.userId) + '">' +
          '<span class="ux-account-avatar" aria-hidden="true">' + esc(accountTitle(account).trim().slice(0, 2).toUpperCase()) + '</span>' +
          '<span class="ux-account-text"><strong>' + esc(accountTitle(account)) + '</strong><small>' + esc(account.login || account.userId) + '</small></span>' +
          '<span class="ux-account-amount"><strong>' + fmtNum(amount) + '</strong><small>' + share + '%</small></span>' +
        '</button>';
    }).join("");

    let detail = '<div class="ux-empty-panel"><strong>No matching accounts</strong><p>Try clearing the search, or switch account status.</p>' +
      '<button class="button small" id="usageClearSearch" type="button">Clear search</button></div>';
    if (chosen) {
      const agents = agentsOf(chosen);
      const connected = agents.filter((agent) => agent.online).length;
      const accountActions = isAdmin() && chosen.userId !== getCurrentUser()?.id
        ? showDeleted
          ? '<button type="button" class="button small" data-restore-user="' + esc(chosen.userId) + '">' + icon("refresh") + 'Restore account</button>'
          : '<button type="button" class="button small danger" data-delete-user="' + esc(chosen.userId) + '">' + icon("trash") + 'Delete account</button>'
        : '';
      detail =
        '<div class="ux-selected-header"><div><div class="panel-kicker">ACCOUNT DETAILS</div>' +
          '<h2>' + esc(accountTitle(chosen)) + '</h2><p>' + esc(chosen.login || chosen.userId) + '</p></div>' +
          '<div class="ux-detail-actions">' +
            '<button type="button" class="button small" id="usageOpenOverview">View activity timeline ' + icon("chevron") + '</button>' +
            accountActions + '</div></div>' +
        '<div class="ux-account-stats">' +
          '<div><span>Invocations</span><strong>' + fmtNum(chosen.calls || 0) + '</strong></div>' +
          '<div><span>Connected</span><strong>' + fmtNum(connected) + '<small> / ' + fmtNum(agents.length) + '</small></strong></div>' +
          '<div><span>Time window</span><strong>' + esc(periodDisplayLabel(getRange())) + '</strong></div></div>' +
        '<section class="ux-detail-section"><div class="ux-section-heading"><div><h3>Agent activity</h3><p>Per-agent invocations in the selected period</p></div>' +
          '<div class="ux-inline-segments" role="group" aria-label="Agent connection status">' +
            pill("All","all",agents.length) + pill("Online","online",connected) + pill("Offline","offline",agents.length-connected) +
          '</div></div><div class="ux-agent-list">' + agentRows(chosen) + '</div></section>' +
        '<section class="ux-detail-section ux-reliability"><div class="ux-section-heading"><div><h3>Reliability & latency</h3>' +
          '<p>Account-level summary, not individual agent timings</p></div></div>' +
          reliabilityPanel(chosen) + '</section>';
    }
    const heading = isAdmin() ? 'Usage investigation' : 'My usage';
    setHeader(heading, 'Find an account, inspect agents, and investigate performance without losing context');
    renderContent(
      '<div class="ux-page-intro"><span class="ux-eyebrow">INVESTIGATION WORKSPACE</span><strong>Follow the signal. Find the source.</strong>' +
        '<p>Usage totals, agent activity, and reliability signals in one place.</p></div>' +
      '<div class="overview-toolbar ux-usage-toolbar"><div class="usage-toolbar-left">' + userTabs +
        periodChips(snapshot?.period || {range:getRange()}) + '</div>' +
        '<span class="privacy-chip">' + icon("info") + (isAdmin() ? 'Admin account visibility' : 'Your activity only') + '</span></div>' +
      '<div class="metric-grid usage-metric-grid">' +
        (isAdmin() ? metricCard(showDeleted ? 'Deleted accounts' : 'Accounts', fmtNum(accounts.length), 'In this account status') : metricCard('Calls / agent', fmtNum(Math.round(totalCalls / Math.max(1,totalAgents))), 'Average across assigned agents')) +
        metricCard('Tool invocations', fmtNum(totalCalls), 'Across these accounts') +
        metricCard('Connected agents', fmtNum(onlineCount) + ' / ' + fmtNum(totalAgents), 'Live connection snapshot') +
      '</div>' +
      '<div class="ux-usage-workspace">' +
        '<section class="panel ux-directory"><div class="ux-directory-head"><div class="panel-kicker">DIRECTORY</div><h2>Accounts</h2>' +
          '<p>' + fmtNum(matching.length) + ' of ' + fmtNum(accounts.length) + ' accounts</p></div>' +
          '<div class="ux-directory-controls"><label class="ux-search">' + icon("search") +
            '<input id="usageSearch" type="search" placeholder="Search accounts or agents" aria-label="Search accounts or agents" value="' + esc(search) + '"></label>' +
            '<label class="ux-sort-label">Sort <select id="usageSort" aria-label="Sort accounts">' +
              '<option value="calls"' + (sort === "calls" ? ' selected' : '') + '>Most active</option>' +
              '<option value="name"' + (sort === "name" ? ' selected' : '') + '>Name A-Z</option></select></label></div>' +
          '<div class="ux-directory-list">' +
            (accountRows || '<div class="ux-empty-accounts">No matching accounts.</div>') +
          '</div></section>' +
        '<section class="panel ux-account-detail">' + detail + '</section></div>',
      patch,
    );

    const searchInput = document.getElementById("usageSearch");
    if (searchInput) searchInput.oninput = () => { search = searchInput.value; render({patch:true}); };
    const sortInput = document.getElementById("usageSort");
    if (sortInput) sortInput.onchange = () => { sort = sortInput.value === "name" ? "name" : "calls"; render({patch:true}); };
    document.querySelectorAll("[data-usage-account]").forEach((button) => {
      button.onclick = () => { selectedId = button.dataset.usageAccount || ""; onlineFilter = "all"; render({patch:true}); };
    });
    document.querySelectorAll("[data-agent-filter]").forEach((button) => {
      button.onclick = () => { onlineFilter = button.dataset.agentFilter || "all"; render({patch:true}); };
    });
    // The live DOM patcher preserves controls; replace handlers per render so
    // a stale closure cannot inspect, delete, or navigate to the wrong account.
    const clearSearch = document.getElementById("usageClearSearch");
    if (clearSearch) clearSearch.onclick = () => { search=""; render({patch:true}); document.getElementById("usageSearch")?.focus(); };
    const openTimeline = document.getElementById("usageOpenOverview");
    if (openTimeline) openTimeline.onclick = () => { if (chosen) openOverview(chosen.userId); };
    const inspectMetrics = document.getElementById("usageInspectMetrics");
    if (inspectMetrics) inspectMetrics.onclick = async (event) => {
      if (!chosen) return;
      const userId = chosen.userId;
      const key = summaryKey(chosen);
      event.currentTarget.disabled = true;
      try {
        // Explicit, on-demand drilldown only; never background-poll latency or errors.
        const result = await api('/admin/api/summary?range=' + encodeURIComponent(getRange()) +
          (isAdmin() ? '&userId=' + encodeURIComponent(userId) : ''));
        summaries.set(key,result);
        render({patch:true});
      } catch (error) {
        event.currentTarget.disabled = false;
        setNotice('Could not load performance details. Try again.',true);
      }
    };
    document.querySelectorAll("[data-overview-range]").forEach((button) => {
      button.onclick = () => {
        const nextRange = button.dataset.overviewRange || 'today';
        if (nextRange === getRange()) return;
        setRange(nextRange);
        void load({patch:true});
      };
    });
    document.querySelectorAll("[data-usage-user-mode]").forEach((button) => {
      button.onclick = () => {
        const next = button.dataset.usageUserMode || "active";
        if (next === (showDeleted ? "deleted" : "active")) return;
        snapshot = null;
        mode = next === "deleted" ? "deleted" : "active";
        selectedId = "";
        void load({patch:true});
      };
    });
    document.querySelectorAll("[data-delete-user]").forEach((button) => {
      button.onclick = async () => {
        if (!isAdmin() || !chosen || chosen.userId === getCurrentUser()?.id) return;
        if (!window.confirm('Delete ' + accountTitle(chosen) + '? You can restore the account from Deleted.')) return;
        button.disabled = true;
        try {
          await api("/admin/api/users/soft-delete",{method:"POST",body:JSON.stringify({userId:chosen.userId})});
          selectedId="";
          await load({patch:true});
        } catch { button.disabled=false;setNotice("Delete account failed. Please retry.",true); }
      };
    });
    document.querySelectorAll("[data-restore-user]").forEach((button) => {
      button.onclick = async () => {
        if (!isAdmin() || !chosen || chosen.userId === getCurrentUser()?.id) return;
        button.disabled = true;
        try {
          await api("/admin/api/users/restore",{method:"POST",body:JSON.stringify({userId:chosen.userId})});
          selectedId="";
          await load({patch:true});
        } catch { button.disabled=false;setNotice("Restore account failed. Please retry.",true); }
      };
    });
  }

  let mode = "active";
  async function load({patch=false}={}) {
    const sequence = ++loadSequence;
    const showDeleted = isAdmin() && mode === "deleted";
    const response = await api("/admin/api/overview?range=" + encodeURIComponent(getRange()) +
      (isAdmin() ? "&deleted=" + showDeleted : ""));
    // Ignore outdated replies after a rapid period or status switch.
    if (sequence !== loadSequence) return;
    setPeriod(response.period);
    snapshot = {...response,showDeleted};
    render({patch});
  }
  return {load};
}
