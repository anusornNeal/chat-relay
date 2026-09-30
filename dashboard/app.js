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
      ? data.items.map((agent) => {
          const owner = agent.owner
            ? esc(agent.owner.name || agent.owner.login || agent.owner.id) + "<br>" + esc(agent.owner.id)
            : esc(agent.ownerUserId || "-");
          const grants = (agent.grants || []).length
            ? (agent.grants || []).map((grant) =>
                esc(grant.userId) + ": " + esc((grant.scopes || []).join(","))
              ).join("<br>")
            : "-";
          const lifecycle = agent.lifecycle || (agent.enabled ? "active" : "disabled");
          const stateLabel = lifecycle === "retired"
            ? "Retired - re-authorize on device"
            : lifecycle === "active"
              ? (agent.online ? "Online" : "Offline")
              : "Disabled";
          const stateClass = lifecycle === "active" && agent.online ? "ok" : "bad";
          const actions =
            '<button data-agent-usage="' + esc(agent.id) + '">Usage</button> ' +
            '<button data-agent-rename="' + esc(agent.id) + '" data-agent-name="' +
              esc(agent.name) + '" data-agent-owner="' + esc(agent.ownerUserId || "") +
              '">Rename</button> ' +
            (lifecycle === "retired"
              ? '<span>Run login --force on this device</span>'
              : '<button data-agent-retire="' + esc(agent.id) + '" data-agent-owner="' +
                esc(agent.ownerUserId || "") + '">Retire</button>');
          return '<tr><td><b>' + esc(agent.name) + "</b><br>" + esc(agent.id) +
            '</td><td class="' + stateClass + '">' + esc(stateLabel) +
            "</td><td>" + owner +
            "</td><td>" + esc(agent.lastSeenAt || "-") +
            "</td><td>" + grants +
            "</td><td>" + actions + "</td></tr>";
        }).join("")
      : '<tr><td colspan="6">No agents</td></tr>';

    document.querySelectorAll("[data-agent-usage]").forEach((button) => {
      button.onclick = () => {
        $("aid").value = button.dataset.agentUsage;
        show("usage");
      };
    });

    document.querySelectorAll("[data-agent-rename]").forEach((button) => {
      button.onclick = async () => {
        const nextName = prompt("Device name", button.dataset.agentName || "");
        if (!nextName || !nextName.trim() || nextName.trim() === button.dataset.agentName) return;
        await mutate("/admin/api/agents/rename", {
          agentId: button.dataset.agentRename,
          name: nextName.trim(),
          ...(button.dataset.agentOwner ? { expectedOwnerUserId: button.dataset.agentOwner } : {}),
        });
      };
    });

    document.querySelectorAll("[data-agent-retire]").forEach((button) => {
      button.onclick = async () => {
        if (!confirm("Retire this device? Its current credential will stop reconnecting until the device is authorized again.")) return;
        await mutate("/admin/api/agents/retire", {
          agentId: button.dataset.agentRetire,
          ...(button.dataset.agentOwner ? { expectedOwnerUserId: button.dataset.agentOwner } : {}),
        });
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
