const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8800").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";
const ownerToken = process.env.TEST_CALLER_TOKEN || "test-caller";
const authHeaders = { authorization: `Bearer ${adminToken}` };

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data, text };
}
async function admin(path, method = "GET", body) {
  return request(path, {
    method,
    headers: { ...authHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function rpc(token, id, name, args = {}) {
  const response = await fetch(`${base}/mcp?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`mcp ${response.status}: ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
}

const unauthorized = await request("/admin/api/users");
if (unauthorized.response.status !== 401) throw new Error("admin API allowed unauthenticated read");

const bootstrap = await admin("/admin/bootstrap", "POST", {
  userName: "Owner", agentId: "default", agentName: "Primary PC",
});
if (!bootstrap.response.ok) throw new Error(`bootstrap failed: ${bootstrap.text}`);

const suffix = Date.now().toString(36);
const createdUsers = [];
for (let i = 0; i < 3; i++) {
  const created = await admin("/admin/users", "POST", { name: `Admin API User ${i}`, id: `admin-api-${suffix}-${i}` });
  if (!created.response.ok || !created.data.token) throw new Error(`create user failed: ${created.text}`);
  createdUsers.push(created.data);
}

const agent = await admin("/admin/agents", "POST", { name: "Admin API Agent", id: `admin-api-agent-${suffix}` });
if (!agent.response.ok) throw new Error(`create agent failed: ${agent.text}`);
const grant = await admin("/admin/grants", "POST", {
  userId: createdUsers[0].user.id,
  agentId: agent.data.agent.id,
  scopes: ["read"],
});
if (!grant.response.ok) throw new Error(`grant failed: ${grant.text}`);

const users = await admin("/admin/api/users?limit=2&offset=0");
if (!users.response.ok || users.data.items?.length !== 2 || users.data.total < 4 || users.data.hasMore !== true) {
  throw new Error(`users pagination failed: ${users.text}`);
}
const filtered = await admin(`/admin/api/users?q=${encodeURIComponent(createdUsers[1].user.id)}`);
if (filtered.data.total !== 1 || filtered.data.items[0]?.id !== createdUsers[1].user.id) {
  throw new Error(`users filtering failed: ${filtered.text}`);
}
const assignedUser = await admin(`/admin/api/users?q=${encodeURIComponent(createdUsers[0].user.id)}&limit=100`);
if (assignedUser.data.items?.[0]?.agentCount !== 1 || assignedUser.data.items?.[0]?.onlineAgentCount !== 0) {
  throw new Error(`user agent counts failed: ${assignedUser.text}`);
}

const userDetail = await admin(`/admin/api/users/${encodeURIComponent(createdUsers[0].user.id)}`);
if (!userDetail.response.ok || userDetail.data.user?.id !== createdUsers[0].user.id) throw new Error("user detail failed");

const agents = await admin("/admin/api/agents?limit=100");
if (!agents.response.ok || !agents.data.items?.some((item) => item.id === agent.data.agent.id)) {
  throw new Error(`agents read failed: ${agents.text}`);
}
const agentDetail = await admin(`/admin/api/agents/${encodeURIComponent(agent.data.agent.id)}`);
if (!agentDetail.response.ok || agentDetail.data.agent?.id !== agent.data.agent.id) throw new Error("agent detail failed");

const grants = await admin(`/admin/api/grants?userId=${encodeURIComponent(createdUsers[0].user.id)}`);
if (grants.data.total !== 1 || grants.data.items[0]?.scopes?.[0] !== "read") {
  throw new Error(`grants read failed: ${grants.text}`);
}

const sessions = await admin(`/admin/api/sessions?userId=${encodeURIComponent(createdUsers[0].user.id)}`);
if (!sessions.response.ok || !Array.isArray(sessions.data.items)) throw new Error(`sessions read failed: ${sessions.text}`);
const revoked = await admin("/admin/api/sessions/revoke", "POST", { userId: createdUsers[0].user.id });
if (!revoked.response.ok || typeof revoked.data.revoked !== "number") throw new Error(`session revoke failed: ${revoked.text}`);

await rpc(ownerToken, 1, "whoami");
await rpc(createdUsers[0].token, 2, "whoami");
const removedCalls = await admin("/admin/api/tool-calls");
if (removedCalls.response.status !== 404) throw new Error("removed tool-call history API is still exposed");
const aggregateOverview = await admin("/admin/api/overview");
const accountRow = (aggregateOverview.data.accountUsage || []).find((item) => item.userId === createdUsers[0].user.id);
if (!aggregateOverview.response.ok || !accountRow || accountRow.calls < 1) {
  throw new Error("account aggregate usage missing: " + aggregateOverview.text);
}
const usage = await admin(`/admin/api/usage?day=${new Date().toISOString().slice(0, 10)}`);
if (!usage.response.ok || !(usage.data.metric?.calls >= 1)) throw new Error(`usage API failed: ${usage.text}`);

const range = await admin(`/admin/api/usage?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`);
if (!range.response.ok || range.data.days?.length !== 1) throw new Error(`usage range failed: ${range.text}`);

const overview = await admin("/admin/api/overview");
if (!overview.response.ok || overview.data.users?.total < 4 || overview.data.agents?.total < 2) {
  throw new Error(`overview failed: ${overview.text}`);
}
if (overview.data.period?.label !== "Today" || overview.data.period?.timezone !== "Asia/Bangkok" || overview.data.period?.timezoneLabel !== "BKK · UTC+7") {
  throw new Error(`Bangkok period contract failed: ${overview.text}`);
}
if (!Array.isArray(overview.data.buckets) || !Array.isArray(overview.data.topTools)) {
  throw new Error("overview chart payload missing");
}

const disabled = await admin("/admin/users/enabled", "POST", { userId: createdUsers[2].user.id, enabled: false });
if (!disabled.response.ok) throw new Error(`disable user failed: ${disabled.text}`);
const disabledFilter = await admin("/admin/api/users?enabled=false&limit=100");
if (!disabledFilter.data.items?.some((user) => user.id === createdUsers[2].user.id)) {
  throw new Error("disabled user filter failed");
}

const legacyState = await admin("/admin/state");
if (!legacyState.response.ok) throw new Error("legacy admin state route broke");
const allAdminData = JSON.stringify({
  users: users.data,
  agents: agents.data,
  grants: grants.data,
  sessions: sessions.data,
  overview: overview.data,
  state: legacyState.data,
});
for (const forbidden of ["passwordHash", "passwordSalt", "tokenHash", "refreshTokenHash", "ADMIN_TOKEN"]) {
  if (allAdminData.includes(forbidden)) throw new Error(`secret field leaked: ${forbidden}`);
}
console.log("admin API smoke test passed");
