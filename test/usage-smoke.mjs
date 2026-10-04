import WebSocket from "ws";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8799").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";
const ownerToken = process.env.TEST_CALLER_TOKEN || "test-caller";
const usageAgentId = "usage-smoke-" + Date.now().toString(36);
const day = new Date().toISOString().slice(0, 10);

async function jsonFetch(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data, text };
}

async function admin(path, method = "GET", body) {
  return jsonFetch(path, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function browserLogin(userId, label) {
  const suffix = Date.now().toString(36) + "-" + label;
  const login = "usage-" + suffix;
  const password = "Usage-" + suffix + "-Password!";
  const attached = await admin("/admin/users/login", "POST", { userId, login, password });
  if (!attached.response.ok) throw new Error(`browser credentials failed: ${attached.text}`);
  const auth = await jsonFetch("/admin/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, password }),
  });
  if (!auth.response.ok) throw new Error(`browser login failed: ${auth.text}`);
  return (auth.response.headers.get("set-cookie") || "").split(";")[0];
}

async function openDashboardWs(cookie) {
  const socket = new WebSocket(base.replace(/^http/, "ws") + "/admin/ws", { headers: { cookie } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextDashboardEvent(socket, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("dashboard lifecycle event timeout"));
    }, timeout);
    const onMessage = (raw) => {
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }
      if (!predicate(data)) return;
      cleanup();
      resolve(data);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

async function rpc(token, id, method, params = {}, sessionId = "usage-smoke-session") {
  const response = await fetch(`${base}/mcp?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`rpc ${response.status}: ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
}

async function tool(token, id, name, args = {}, expectError = false, sessionId = "usage-smoke-session") {
  const result = await rpc(token, id, "tools/call", { name, arguments: args }, sessionId);
  if (Boolean(result.result?.isError) !== expectError) {
    throw new Error(`${name} error mismatch: ${JSON.stringify(result)}`);
  }
  return result;
}

await admin("/admin/bootstrap", "POST", {
  userName: "Owner",
  agentId: "default",
  agentName: "Bootstrap Agent",
}).then(({ response, text }) => {
  if (!response.ok) throw new Error(`bootstrap failed: ${text}`);
});

const createdUsageAgent = await admin("/admin/agents", "POST", {
  name: "Usage Test Agent",
  id: usageAgentId,
  ownerUserId: "owner",
});
if (!createdUsageAgent.response.ok || !createdUsageAgent.data.token) {
  throw new Error(`usage agent create failed: ${createdUsageAgent.text}`);
}
const agentToken = createdUsageAgent.data.token;
const ownerUsageGrant = await admin("/admin/grants", "POST", {
  userId: "owner",
  agentId: usageAgentId,
  scopes: ["*"],
});
if (!ownerUsageGrant.response.ok) throw new Error(`owner usage grant failed: ${ownerUsageGrant.text}`);

const wsUrl = base.replace(/^http/, "ws") + "/agent?agentId=" + encodeURIComponent(usageAgentId);
const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${agentToken}` } });
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  const payload = message.payload || {};
  let result;
  if (payload.action === "ping") result = { ok: true, action: "pong" };
  else if (payload.action === "fs.read" && String(payload.path).includes("fail")) {
    result = { ok: false, error: "synthetic_failure", content: "PRIVATE_ERROR_OUTPUT" };
  } else if (payload.action === "fs.read") {
    result = { ok: true, content: "PRIVATE_FILE_OUTPUT", path: payload.path };
  } else if (payload.action === "terminal.exec") {
    setTimeout(() => socket.send(JSON.stringify({ requestId: message.requestId, payload: { ok: true, exitCode: 0, stdout: "PRIVATE_TERMINAL_OUTPUT" } })), 1200);
    return;
  } else result = { ok: true };
  socket.send(JSON.stringify({ requestId: message.requestId, payload: result }));
});

const lifecycleSuffix = Date.now().toString(36);
const lifecycleUser = await admin("/admin/users", "POST", { name: "Lifecycle Reader", id: "lifecycle-" + lifecycleSuffix });
if (!lifecycleUser.response.ok || !lifecycleUser.data.token) throw new Error(`lifecycle user create failed: ${lifecycleUser.text}`);
const lifecycleGrant = await admin("/admin/grants", "POST", {
  userId: lifecycleUser.data.user.id,
  agentId: usageAgentId,
  scopes: ["*"],
});
if (!lifecycleGrant.response.ok) throw new Error(`lifecycle grant failed: ${lifecycleGrant.text}`);
const lifecycleCookie = await browserLogin(lifecycleUser.data.user.id, "lifecycle");
const dashboardSocket = await openDashboardWs(lifecycleCookie);
await new Promise((resolve) => setTimeout(resolve, 40));

const aggregateInvalidation = nextDashboardEvent(dashboardSocket, (event) => event.type === "invalidate" && event.topics?.includes("overview"));
const lifecycleSensitivePath = "SENSITIVE_FAST_LIFECYCLE_PATH.txt";
await tool(lifecycleUser.data.token, 40, "read_file", { path: lifecycleSensitivePath }, false, "lifecycle-fast-session");
const aggregateEvent = await aggregateInvalidation;
if (JSON.stringify(aggregateEvent).includes(lifecycleSensitivePath)) throw new Error("aggregate invalidation leaked tool arguments");

await tool(ownerToken, 1, "whoami");
await tool(ownerToken, 2, "ping_agent", { agentId: usageAgentId });
await tool(ownerToken, 3, "read_file", { agentId: usageAgentId, path: "SENSITIVE_PATH_SECRET.txt" });
await tool(ownerToken, 4, "read_file", { agentId: usageAgentId, path: "fail-SENSITIVE_FAILURE_PATH.txt" }, true);
await tool(ownerToken, 41, "ping_agent", { agentId: "missing-agent" }, true);
await tool(ownerToken, 42, "whoami", {}, false, null);

const runningPromise = tool(ownerToken, 43, "terminal_exec", { agentId: usageAgentId, command: "echo realtime-running" }, false, "usage-running-session");
await new Promise((resolve) => setTimeout(resolve, 180));
const removedRunning = await admin("/admin/api/tool-calls?state=all&status=running&limit=50");
if (removedRunning.response.status !== 404) throw new Error("removed running tool-call API is still exposed");
await runningPromise;

const suffix = Date.now().toString(36);
const created = await admin("/admin/users", "POST", { name: "Usage Reader", id: `usage-reader-${suffix}` });
if (!created.response.ok || !created.data.token) throw new Error(`create user failed: ${created.text}`);
const grant = await admin("/admin/grants", "POST", {
  userId: created.data.user.id,
  agentId: usageAgentId,
  scopes: ["read"],
});
if (!grant.response.ok) throw new Error(`grant failed: ${grant.text}`);
await tool(created.data.token, 5, "whoami");

const total = await admin(`/admin/usage?day=${day}&recentLimit=100`);
if (!total.response.ok) throw new Error(`usage query failed: ${total.text}`);
if ((total.data.metric?.calls || 0) < 6 || (total.data.metric?.errors || 0) < 2) {
  throw new Error(`unexpected total usage: ${total.text}`);
}
if (!(total.data.metric.avgDurationMs >= 0)) throw new Error("missing duration aggregate");

const reader = await admin(`/admin/usage?day=${day}&userId=${encodeURIComponent(created.data.user.id)}`);
if (reader.data.metric?.calls !== 1) throw new Error(`user attribution failed: ${reader.text}`);

const reads = await admin(`/admin/usage?day=${day}&tool=read_file`);
if ((reads.data.metric?.calls || 0) < 2 || (reads.data.metric?.errors || 0) < 1) {
  throw new Error(`tool attribution failed: ${reads.text}`);
}

const missingAgent = await admin(`/admin/usage?day=${day}&agentId=missing-agent`);
if ((missingAgent.data.metric?.calls || 0) < 1 || (missingAgent.data.metric?.errors || 0) < 1) {
  throw new Error(`missing-agent attribution failed: ${missingAgent.text}`);
}

const agent = await admin(`/admin/usage?day=${day}&agentId=${encodeURIComponent(usageAgentId)}`);
if ((agent.data.metric?.calls || 0) < 3 || (agent.data.metric?.errors || 0) < 1) {
  throw new Error(`agent attribution failed: ${agent.text}`);
}

await Promise.all([
  tool(ownerToken, 60, "whoami", {}, false, "concurrent-chat-a"),
  tool(ownerToken, 61, "whoami", {}, false, "concurrent-chat-b"),
]);
const aggregateAfterConcurrent = await admin("/admin/api/overview");
const ownerAggregate = (aggregateAfterConcurrent.data.accountUsage || []).find((item) => item.userId === "owner");
if (!aggregateAfterConcurrent.response.ok || !ownerAggregate || ownerAggregate.calls < 1) throw new Error("owner aggregate usage missing");
const correlated = await admin("/admin/usage?day=" + day + "&recentLimit=100");
for (const event of correlated.data.recent || []) {
  if (event.ok !== false) throw new Error("successful raw usage event persisted");
  if (!event.toolCallId || !String(event.toolCallId).startsWith("tc_")) throw new Error("missing toolCallId in retained error event");
}

const errors = await admin("/admin/api/errors?limit=100");
const syntheticError = (errors.data.items || []).find((event) => event.tool === "read_file" && event.errorCode === "synthetic_failure");
if (!syntheticError || syntheticError.errorSource !== "agent" || syntheticError.failureStage !== "agent" || syntheticError.retryable !== false || syntheticError.failureCategory !== "tool" || syntheticError.operational !== false || !syntheticError.diagnosticLabel || !syntheticError.agentName || syntheticError.agentName === syntheticError.agentId) {
  throw new Error(`safe structured error metadata missing: ${errors.text}`);
}
const operationalErrors = await admin("/admin/api/errors?operational=true&limit=100");
if (!operationalErrors.response.ok || (operationalErrors.data.items || []).some((event) => event.operational !== true || event.failureCategory !== "infrastructure")) {
  throw new Error(`operational error filtering failed: ${operationalErrors.text}`);
}
const handledErrors = await admin("/admin/api/errors?operational=false&limit=100");
if (!handledErrors.response.ok || !(handledErrors.data.items || []).some((event) => event.errorCode === "synthetic_failure" && event.operational === false)) {
  throw new Error(`handled error filtering failed: ${handledErrors.text}`);
}

const removedHistory = await admin("/admin/api/tool-calls?state=history&limit=2");
if (removedHistory.response.status !== 404) throw new Error("removed tool-call history API is still exposed");

const errorPage = await admin("/admin/api/errors?limit=1");
if (!errorPage.response.ok || errorPage.data.items?.length !== 1 || !errorPage.data.nextCursor) throw new Error(`error cursor page failed: ${errorPage.text}`);

const serialized = JSON.stringify(total.data.recent || []);
for (const forbidden of [
  "SENSITIVE_PATH_SECRET",
  "SENSITIVE_FAILURE_PATH",
  "SENSITIVE_FAST_LIFECYCLE_PATH",
  "PRIVATE_FILE_OUTPUT",
  "PRIVATE_ERROR_OUTPUT",
  "PRIVATE_TERMINAL_OUTPUT",
  ownerToken,
  agentToken,
]) {
  if (serialized.includes(forbidden)) throw new Error(`sensitive usage payload persisted: ${forbidden}`);
}

// Prove the Bangkok Today overview does not silently stop at the old 1,000-event read bound.
const bulkCalls = 1005;
for (let offset = 0; offset < bulkCalls; offset += 25) {
  const count = Math.min(25, bulkCalls - offset);
  await Promise.all(Array.from({ length: count }, (_, index) =>
    tool(ownerToken, 1000 + offset + index, "whoami", {}, false, "usage-bulk-session")
  ));
}
const todayOverview = await admin("/admin/api/overview");
if (!todayOverview.response.ok || todayOverview.data.period?.timezoneLabel !== "BKK · UTC+7") {
  throw new Error(`Bangkok Today overview contract missing: ${todayOverview.text}`);
}
if ((todayOverview.data.usage?.calls || 0) <= 1000) {
  throw new Error(`Today overview silently capped at 1,000 calls: ${todayOverview.text}`);
}
if (todayOverview.data.bounded === true) {
  throw new Error(`Today overview unexpectedly bounded near 1,000 calls: ${todayOverview.text}`);
}
if (!Array.isArray(todayOverview.data.buckets) || !Array.isArray(todayOverview.data.topTools)) {
  throw new Error("Today overview missing chart data");
}

dashboardSocket.terminate();
const retiredUsageAgent = await admin("/admin/api/agents/retire", "POST", {
  agentId: usageAgentId,
  expectedOwnerUserId: "owner",
});
if (!retiredUsageAgent.response.ok) throw new Error(`usage agent cleanup failed: ${retiredUsageAgent.text}`);
socket.terminate();
console.log("usage telemetry smoke test passed");
