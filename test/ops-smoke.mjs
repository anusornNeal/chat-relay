import fs from "node:fs";
import WebSocket from "ws";

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
const agentToken = process.env.TEST_AGENT_TOKEN || vars.AGENT_TOKEN;
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

const usageSocket = new WebSocket(base.replace(/^http/, "ws") + "/agent?agentId=default", {
  headers: { authorization: `Bearer ${agentToken}` },
});
await new Promise((resolve, reject) => {
  usageSocket.once("open", resolve);
  usageSocket.once("error", reject);
});
usageSocket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (!message?.requestId) return;
  usageSocket.send(JSON.stringify({ requestId: message.requestId, payload: { ok: true, action: "pong" } }));
});

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
    params: { name: "ping_agent", arguments: { agentId: "default" } },
  }),
});
if (!rpc.response.ok) throw new Error("usage fixture MCP call failed: " + rpc.text);

const usageBefore = await admin("/admin/api/overview");
const ownerUsageBefore = (usageBefore.data.accounts || []).find((account) => account.userId === "owner");
if (!usageBefore.response.ok || !ownerUsageBefore?.calls) {
  throw new Error("usage fixture missing before cleanup: " + usageBefore.text);
}
const aggregateCalls = ownerUsageBefore.calls;

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
    !operationsBefore.data.components?.audit?.ok || operationsBefore.data.components?.usage) {
  throw new Error("operations health invalid: " + operationsBefore.text);
}

const cleanup = await admin("/admin/api/operations/cleanup", "POST", {
  auditRetentionDays: 365,
  limit: 500,
});
if (!cleanup.response.ok || !cleanup.data.ok || cleanup.data.usage) {
  throw new Error("cleanup failed: " + cleanup.text);
}

const usageAfter = await admin("/admin/api/overview");
const ownerUsageAfter = (usageAfter.data.accounts || []).find((account) => account.userId === "owner");
if (!usageAfter.response.ok || ownerUsageAfter?.calls !== aggregateCalls) {
  throw new Error("usage count changed during unrelated cleanup: " + usageAfter.text);
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
  auditRetentionDays: 365,
  limit: 500,
});
if (!cleanupAgain.response.ok || !cleanupAgain.data.ok || cleanupAgain.data.usage) {
  throw new Error("second cleanup failed");
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

const usageSource = fs.readFileSync("src/usage.ts", "utf8");
const usageType = usageSource.match(/export type UsageEvent = \{([\s\S]*?)\n\};/)?.[1] || "";
for (const field of ["workerOverheadMs", "relayRoundTripMs", "transportMs", "agentQueueWaitMs", "agentHandlerMs"]) {
  if (!usageType.includes(field)) throw new Error("missing safe timing field: " + field);
}
for (const forbidden of ["command", "arguments", "payload", "stdout", "stderr", "clipboard", "screenshot"]) {
  if (new RegExp("\\b" + forbidden + "\\b", "i").test(usageType)) throw new Error("content field leaked into UsageEvent: " + forbidden);
}

try { usageSocket.close(); } catch {}
console.log("operations/audit/retention smoke test passed");
