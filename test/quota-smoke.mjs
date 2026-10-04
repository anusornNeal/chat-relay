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

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8804").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || vars.ADMIN_TOKEN || "test-admin";
const quotaAgentId = "quota-smoke-" + Date.now().toString(36);

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

async function setPolicy(policy) {
  const result = await admin("/admin/api/limits", "POST", policy);
  if (!result.response.ok) throw new Error("policy update failed: " + result.text);
  return result.data;
}

async function createReader(label) {
  const suffix = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  const created = await admin("/admin/users", "POST", {
    name: label,
    id: "quota-" + suffix,
  });
  if (!created.response.ok || !created.data.token) {
    throw new Error("user creation failed: " + created.text);
  }
  const grant = await admin("/admin/grants", "POST", {
    userId: created.data.user.id,
    agentId: quotaAgentId,
    scopes: ["read"],
  });
  if (!grant.response.ok) throw new Error("grant failed: " + grant.text);
  return { id: created.data.user.id, token: created.data.token };
}

async function mcpTool(user, id, name = "ping_agent") {
  return request("/mcp?key=" + encodeURIComponent(user.token), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: name === "ping_agent" ? { agentId: quotaAgentId } : {} },
    }),
  });
}

async function recentCalls(user) {
  const result = await request("/relay?agentId=" + encodeURIComponent(quotaAgentId), {
    method: "POST",
    headers: {
      authorization: "Bearer " + user.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ payload: { action: "agent.recentCalls", limit: 100 } }),
  });
  if (!result.response.ok || !Array.isArray(result.data.payload)) {
    throw new Error("recentCalls failed: " + result.text);
  }
  return result.data.payload;
}

function pingCount(items) {
  return items.filter((item) => item.action === "ping").length;
}

const createdAgent = await admin("/admin/agents", "POST", {
  name: "Quota Test Agent",
  id: quotaAgentId,
});
if (!createdAgent.response.ok || !createdAgent.data.token) {
  throw new Error("quota agent creation failed: " + createdAgent.text);
}

const recentAgentCalls = [];
const agentSocket = new WebSocket(
  base.replace(/^http/, "ws") + "/agent?agentId=" + encodeURIComponent(quotaAgentId),
  { headers: { authorization: "Bearer " + createdAgent.data.token } },
);
await new Promise((resolve, reject) => {
  agentSocket.once("open", resolve);
  agentSocket.once("error", reject);
});
agentSocket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  const action = message.payload?.action;
  let payload;
  if (action === "agent.recentCalls") {
    payload = recentAgentCalls.slice(-100);
  } else if (action === "ping") {
    recentAgentCalls.push({ action: "ping", at: Date.now() });
    payload = { ok: true, action: "pong" };
  } else {
    payload = { ok: true, action };
  }
  agentSocket.send(JSON.stringify({ requestId: message.requestId, payload }));
});

await setPolicy({ rateLimit: 2, rateWindowSeconds: 1, dailyCallQuota: 0 });
const rateUser = await createReader("Rate Limit Test");
const before = pingCount(await recentCalls(rateUser));

for (let id = 1; id <= 2; id++) {
  const allowed = await mcpTool(rateUser, id);
  if (!allowed.response.ok) throw new Error("rate boundary allowed call failed: " + allowed.text);
}
const rejectedRate = await mcpTool(rateUser, 3);
if (rejectedRate.response.status !== 429 ||
    rejectedRate.data.error !== "rate_limited" ||
    !rejectedRate.data.retryAt ||
    !rejectedRate.response.headers.get("retry-after")) {
  throw new Error("rate limit rejection metadata invalid: " + rejectedRate.text);
}
const after = pingCount(await recentCalls(rateUser));
if (after - before !== 2) {
  throw new Error("rate rejected call reached agent: before=" + before + " after=" + after);
}

await new Promise((resolve) => setTimeout(resolve, 1100));
const afterReset = await mcpTool(rateUser, 4);
if (!afterReset.response.ok) throw new Error("rate window did not reset: " + afterReset.text);

const otherRateUser = await createReader("Rate Isolation Test");
const isolated = await mcpTool(otherRateUser, 5);
if (!isolated.response.ok) throw new Error("second user inherited first user's rate counter");

await setPolicy({ rateLimit: 0, rateWindowSeconds: 60, dailyCallQuota: 2 });
const quotaUser = await createReader("Daily Quota Test");
for (let id = 10; id < 12; id++) {
  const allowed = await mcpTool(quotaUser, id);
  if (!allowed.response.ok) throw new Error("daily quota allowed call failed: " + allowed.text);
}
const rejectedQuota = await mcpTool(quotaUser, 12);
if (rejectedQuota.response.status !== 429 ||
    rejectedQuota.data.error !== "quota_exceeded" ||
    !rejectedQuota.data.resetAt) {
  throw new Error("daily quota rejection metadata invalid: " + rejectedQuota.text);
}

const otherQuotaUser = await createReader("Quota Isolation Test");
const isolatedQuota = await mcpTool(otherQuotaUser, 13);
if (!isolatedQuota.response.ok) throw new Error("second user inherited first user's daily quota");

await setPolicy({ rateLimit: 1, rateWindowSeconds: 60, dailyCallQuota: 0 });
const concurrentUser = await createReader("Concurrent Limit Test");
const concurrentBefore = pingCount(await recentCalls(concurrentUser));
const concurrent = await Promise.all([
  mcpTool(concurrentUser, 20),
  mcpTool(concurrentUser, 21),
]);
const concurrentAllowed = concurrent.filter((result) => result.response.ok).length;
const concurrentRejected = concurrent.filter((result) =>
  result.response.status === 429 && result.data.error === "rate_limited"
).length;
if (concurrentAllowed !== 1 || concurrentRejected !== 1) {
  throw new Error("concurrent rate enforcement was not atomic");
}
const concurrentAfter = pingCount(await recentCalls(concurrentUser));
if (concurrentAfter - concurrentBefore !== 1) {
  throw new Error("concurrent rejected call reached agent");
}

await setPolicy({ rateLimit: 0, rateWindowSeconds: 60, dailyCallQuota: 0 });
const disabled = await mcpTool(quotaUser, 14);
if (!disabled.response.ok) throw new Error("disabled quota policy still rejected calls");

const limits = await admin("/admin/api/limits");
if (!limits.response.ok ||
    limits.data.policy?.rateLimit !== 0 ||
    limits.data.policy?.dailyCallQuota !== 0 ||
    limits.data.source !== "admin") {
  throw new Error("admin quota status invalid: " + limits.text);
}
if ("recentRejections" in limits.data) {
  throw new Error("removed quota rejection history is still exposed");
}

await setPolicy({ resetToDefaults: true });
try { agentSocket.close(); } catch {}
console.log("quota/rate-limit smoke test passed");
