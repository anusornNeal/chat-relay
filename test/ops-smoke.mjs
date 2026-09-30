import fs from "node:fs";

const vars = fs.existsSync(".dev.vars")
  ? Object.fromEntries(
      fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
        .filter((line) => line && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    )
  : {};

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8805").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || vars.ADMIN_TOKEN;
const callerToken = process.env.TEST_CALLER_TOKEN || vars.CALLER_TOKEN;
const password = "Sensitive-Ops-Password!";
const login = "ops-owner";

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, data, text };
}

async function admin(path, method = "GET", body) {
  return request(path, {
    method,
    headers: {
      authorization: "Bearer " + adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const boot = await admin("/admin/bootstrap", "POST", {
  userName: "Owner",
  agentId: "default",
  agentName: "Primary PC",
});
if (!boot.response.ok) throw new Error("bootstrap failed: " + boot.text);

const ownerLogin = await admin("/admin/users/login", "POST", {
  userId: "owner",
  login,
  password,
});
if (!ownerLogin.response.ok) throw new Error("owner login setup failed: " + ownerLogin.text);

const badLogin = await request("/admin/session/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login, password: "Wrong-Password!" }),
});
if (badLogin.response.status !== 401) throw new Error("bad admin login was not rejected");

const goodLogin = await request("/admin/session/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login, password }),
});
if (!goodLogin.response.ok || !goodLogin.data.csrfToken) {
  throw new Error("admin login failed: " + goodLogin.text);
}
const cookie = (goodLogin.response.headers.get("set-cookie") || "").split(";")[0];
if (!cookie) throw new Error("admin session cookie missing");

const suffix = Date.now().toString(36);
const created = await admin("/admin/users", "POST", {
  name: "Ops Audit User",
  id: "ops-user-" + suffix,
});
if (!created.response.ok || !created.data.token) throw new Error("user create failed");
const createdToken = created.data.token;
const userId = created.data.user.id;

const grant = await admin("/admin/grants", "POST", {
  userId,
  agentId: "default",
  scopes: ["read"],
});
if (!grant.response.ok) throw new Error("grant failed");

for (const enabled of [false, true]) {
  const change = await admin("/admin/users/enabled", "POST", { userId, enabled });
  if (!change.response.ok) throw new Error("user enable toggle failed");
}

const rotated = await admin("/admin/users/rotate", "POST", { userId });
if (!rotated.response.ok || !rotated.data.token) throw new Error("user rotation failed");
const rotatedToken = rotated.data.token;

const policy = await admin("/admin/api/limits", "POST", {
  rateLimit: 50,
  rateWindowSeconds: 60,
  dailyCallQuota: 5000,
});
if (!policy.response.ok) throw new Error("quota policy mutation failed");

const rpc = await request("/mcp?key=" + encodeURIComponent(callerToken), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "whoami", arguments: {} },
  }),
});
if (!rpc.response.ok) throw new Error("usage fixture MCP call failed: " + rpc.text);

const day = new Date().toISOString().slice(0, 10);
const usageBefore = await admin("/admin/api/usage?day=" + day + "&recentLimit=100");
if (!usageBefore.response.ok || !usageBefore.data.metric?.calls || !usageBefore.data.recent?.length) {
  throw new Error("usage fixture missing before cleanup: " + usageBefore.text);
}
const aggregateCalls = usageBefore.data.metric.calls;

const device = await request("/auth/device/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agentId: "ops-live-" + suffix,
    agentName: "Ops Live Device",
  }),
});
if (!device.response.ok || !device.data.deviceCode) throw new Error("live device fixture failed");

const auditBefore = await admin("/admin/api/audit?limit=100");
if (!auditBefore.response.ok) throw new Error("audit query failed: " + auditBefore.text);
const actions = new Set((auditBefore.data.items || []).map((event) => event.action));
for (const expected of [
  "registry.bootstrap",
  "user.credentials.set",
  "admin.session.login",
  "user.create",
  "grant.upsert",
  "user.disable",
  "user.enable",
  "user.token.rotate",
  "policy.quota.set",
]) {
  if (!actions.has(expected)) throw new Error("missing audit action: " + expected);
}
const loginEvents = (auditBefore.data.items || []).filter((event) => event.action === "admin.session.login");
if (!loginEvents.some((event) => event.result === "failure") ||
    !loginEvents.some((event) => event.result === "success")) {
  throw new Error("admin login audit outcomes missing");
}

const auditText = JSON.stringify(auditBefore.data);
for (const secret of [password, createdToken, rotatedToken, adminToken, callerToken, device.data.deviceCode]) {
  if (secret && auditText.includes(secret)) throw new Error("sensitive value leaked into audit log");
}

const operationsBefore = await admin("/admin/api/operations");
if (!operationsBefore.response.ok || !operationsBefore.data.components?.registry?.ok ||
    !operationsBefore.data.components?.usage?.ok || !operationsBefore.data.components?.audit?.ok) {
  throw new Error("operations health invalid: " + operationsBefore.text);
}

const cleanup = await admin("/admin/api/operations/cleanup", "POST", {
  usageRawRetentionDays: 0,
  auditRetentionDays: 365,
  limit: 500,
});
if (!cleanup.response.ok || !cleanup.data.ok) throw new Error("cleanup failed: " + cleanup.text);
if ((cleanup.data.usage?.data?.deleted || 0) < 1) throw new Error("raw usage cleanup removed no eligible events");

const usageAfter = await admin("/admin/api/usage?day=" + day + "&recentLimit=100");
if (!usageAfter.response.ok || usageAfter.data.metric?.calls !== aggregateCalls) {
  throw new Error("usage aggregate changed during raw cleanup: " + usageAfter.text);
}
if ((usageAfter.data.recent || []).length !== 0) {
  throw new Error("raw usage events survived zero-day cleanup");
}

const pending = await request("/auth/device/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceCode: device.data.deviceCode }),
});
if (pending.response.status !== 428 || pending.data.error !== "authorization_pending") {
  throw new Error("live device was removed by cleanup: " + pending.text);
}

const browserSession = await request("/admin/session", {
  headers: { cookie },
});
if (!browserSession.response.ok || browserSession.data.user?.id !== "owner") {
  throw new Error("live admin session was removed by cleanup");
}

const cleanupAgain = await admin("/admin/api/operations/cleanup", "POST", {
  usageRawRetentionDays: 0,
  auditRetentionDays: 365,
  limit: 500,
});
if (!cleanupAgain.response.ok || !cleanupAgain.data.ok) throw new Error("second cleanup failed");
if ((cleanupAgain.data.usage?.data?.deleted || 0) !== 0) {
  throw new Error("cleanup was not idempotent for raw usage");
}

const auditAfter = await admin("/admin/api/audit?limit=100");
if (!auditAfter.response.ok ||
    !(auditAfter.data.items || []).some((event) => event.action === "operations.cleanup")) {
  throw new Error("cleanup audit event missing");
}
const finalAuditText = JSON.stringify(auditAfter.data);
for (const secret of [password, createdToken, rotatedToken, adminToken, callerToken, device.data.deviceCode]) {
  if (secret && finalAuditText.includes(secret)) throw new Error("sensitive value leaked after cleanup");
}

console.log("operations/audit/retention smoke test passed");
