let csrf = "";
const $ = (id) => document.getElementById(id);
const today = new Date().toISOString().slice(0, 10);
$("from").value = $("to").value = today;

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
}

function message(text, isError = false) {
  $("status").textContent = text || "";
  $("status").className = isError ? "error" : "";
}

function showLogin(text = "") {
  $("app").hidden = true;
  $("login").hidden = false;
  $("loginError").textContent = text;
}

function showDashboard(user) {
  $("login").hidden = true;
  $("app").hidden = false;
  $("who").textContent = user?.name || user?.login || "Administrator";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== "GET") {
    headers["content-type"] = "application/json";
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (response.status === 401) {
    csrf = "";
    showLogin("Session expired. Sign in again.");
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}

function topTools(recent = []) {
  const counts = new Map();
  for (const event of recent) counts.set(event.tool, (counts.get(event.tool) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

$("loginForm").onsubmit = async (event) => {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    const data = await api("/admin/session/login", {
      method: "POST",
      body: JSON.stringify({
        login: $("loginName").value,
        password: $("password").value,
      }),
    });
    csrf = data.csrfToken;
    showDashboard(data.user);
    $("password").value = "";
    await overview();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
};

$("logout").onclick = async () => {
  try {
    await api("/admin/session/logout", { method: "POST", body: "{}" });
  } catch {}
  csrf = "";
  showLogin();
};

$("refresh").onclick = () => load();

document.querySelectorAll("nav button").forEach((button) => {
  button.onclick = () => show(button.dataset.tab);
});

function show(name) {
  document.querySelectorAll("nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name);
  });
  document.querySelectorAll(".tab").forEach((view) => {
    view.hidden = view.id !== name;
  });
  load();
}

async function overview() {
  message("Loading overview...");
  try {
    const [data, usage] = await Promise.all([
      api("/admin/api/overview"),
      api("/admin/api/usage?day=" + encodeURIComponent(today) + "&recentLimit=100"),
    ]);
    const metric = data.usage || {};
    const cards = [
      ["Users", data.users?.total ?? 0],
      ["Online agents", (data.agents?.online || 0) + "/" + (data.agents?.total || 0)],
      ["Calls", metric.calls || 0],
      ["Errors", metric.errors || 0],
      ["Avg latency", (metric.avgDurationMs || 0).toFixed(1) + " ms"],
    ];
    $("cards").innerHTML = cards.map(([label, value]) =>
      '<div class="card"><span>' + esc(label) + '</span><b>' + esc(value) + "</b></div>"
    ).join("");
    const tools = topTools(usage.recent || []);
    $("today").innerHTML =
      "<h2>Today</h2><p>Error rate " + ((metric.errorRate || 0) * 100).toFixed(1) +
      "%</p><h3>Top tools</h3>" +
      (tools.length
        ? "<ol>" + tools.map(([tool, count]) => "<li>" + esc(tool) + " - " + count + "</li>").join("") + "</ol>"
        : "<p>No tool calls yet.</p>");
    message("");
  } catch (error) {
    if (error.message !== "unauthorized") message(error.message, true);
  }
}

async function users() {
  message("Loading users...");
  try {
    const query = encodeURIComponent($("uq").value);
    const data = await api("/admin/api/users?limit=100" + (query ? "&q=" + query : ""));
    $("ub").innerHTML = data.items?.length
      ? data.items.map((user) =>
          '<tr><td><b>' + esc(user.name) + "</b><br>" + esc(user.id) +
          "</td><td>" + esc(user.login || "-") +
          '</td><td class="' + (user.enabled ? "ok" : "bad") + '">' + (user.enabled ? "Enabled" : "Disabled") +
          "</td><td>Admin: " + (user.admin ? "Yes" : "No") +
          '</td><td><button data-user-usage="' + esc(user.id) + '">Usage</button> ' +
          '<button data-revoke="' + esc(user.id) + '">Revoke sessions</button></td></tr>'
        ).join("")
      : '<tr><td colspan="5">No users</td></tr>';
    document.querySelectorAll("[data-user-usage]").forEach((button) => {
      button.onclick = () => {
        $("uid").value = button.dataset.userUsage;
        show("usage");
      };
    });
    document.querySelectorAll("[data-revoke]").forEach((button) => {
      button.onclick = () => mutate("/admin/api/sessions/revoke", { userId: button.dataset.revoke });
    });
    message("");
  } catch (error) {
    if (error.message !== "unauthorized") message(error.message, true);
  }
}

async function agents() {
  message("Loading agents...");
  try {
    const query = encodeURIComponent($("aq").value);
    const data = await api("/admin/api/agents?limit=100" + (query ? "&q=" + query : ""));
    $("ab").innerHTML = data.items?.length
      ? data.items.map((agent) =>
          '<tr><td><b>' + esc(agent.name) + "</b><br>" + esc(agent.id) +
          '</td><td class="' + (agent.online ? "ok" : "bad") + '">' + (agent.online ? "Online" : "Offline") +
          "</td><td>" + esc(agent.ownerUserId || "-") +
          "</td><td>" + esc(agent.lastSeenAt || "-") +
          '</td><td><button data-agent-usage="' + esc(agent.id) + '">Usage</button></td></tr>'
        ).join("")
      : '<tr><td colspan="5">No agents</td></tr>';
    document.querySelectorAll("[data-agent-usage]").forEach((button) => {
      button.onclick = () => {
        $("aid").value = button.dataset.agentUsage;
        show("usage");
      };
    });
    message("");
  } catch (error) {
    if (error.message !== "unauthorized") message(error.message, true);
  }
}

async function usage() {
  message("Loading usage...");
  try {
    const params = new URLSearchParams({
      from: $("from").value || today,
      to: $("to").value || today,
    });
    const filters = [
      ["uid", "userId"],
      ["tool", "tool"],
      ["aid", "agentId"],
    ];
    for (const [id, key] of filters) {
      if ($(id).value.trim()) params.set(key, $(id).value.trim());
    }
    const [range, recent] = await Promise.all([
      api("/admin/api/usage?" + params),
      api("/admin/api/usage?day=" + encodeURIComponent($("to").value || today) +
        "&recentLimit=100" +
        (params.get("userId") ? "&userId=" + encodeURIComponent(params.get("userId")) : "") +
        (params.get("tool") ? "&tool=" + encodeURIComponent(params.get("tool")) : "") +
        (params.get("agentId") ? "&agentId=" + encodeURIComponent(params.get("agentId")) : "")),
    ]);
    const rows = range.days || [];
    const max = Math.max(1, ...rows.map((row) => row.metric?.calls || 0));
    const tools = topTools(recent.recent || []);
    $("trend").innerHTML =
      "<h2>Call trend</h2>" +
      (rows.length
        ? rows.map((row) =>
            '<div class="trend"><span>' + esc(row.day) +
            '</span><div class="bar"><span style="width:' +
            (100 * (row.metric?.calls || 0) / max) +
            '%"></span></div><b>' + (row.metric?.calls || 0) + "</b></div>"
          ).join("")
        : "<p>No usage data.</p>") +
      "<h3>Top tools</h3>" +
      (tools.length
        ? "<ol>" + tools.map(([name, count]) => "<li>" + esc(name) + " - " + count + "</li>").join("") + "</ol>"
        : "<p>No matching recent tool calls.</p>");
    message("");
  } catch (error) {
    if (error.message !== "unauthorized") message(error.message, true);
  }
}

async function mutate(path, body) {
  if (!csrf) {
    message("Sign in again before making changes.", true);
    return;
  }
  message("Updating...");
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    message("Updated.");
    await load();
  } catch (error) {
    if (error.message !== "unauthorized") message(error.message, true);
  }
}

function activeTab() {
  return document.querySelector("nav button.active")?.dataset.tab || "overview";
}

function load() {
  return ({ overview, users, agents, usage }[activeTab()])();
}

$("us").onclick = users;
$("as").onclick = agents;
$("uf").onsubmit = (event) => {
  event.preventDefault();
  usage();
};

(async () => {
  try {
    const session = await api("/admin/session");
    showDashboard(session.user);
    await overview();
  } catch (error) {
    if (error.message !== "unauthorized") showLogin();
  }
})();
