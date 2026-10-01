import WebSocket from "ws";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8799").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";
const ownerToken = process.env.TEST_CALLER_TOKEN || "test-caller";
const agentToken = process.env.TEST_AGENT_TOKEN || "test-agent";
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
  agentName: "Usage Test Agent",
}).then(({ response, text }) => {
  if (!response.ok) throw new Error(`bootstrap failed: ${text}`);
});

const wsUrl = base.replace(/^http/, "ws") + "/agent?agentId=default";
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
  agentId: "default",
  scopes: ["*"],
});
if (!lifecycleGrant.response.ok) throw new Error(`lifecycle grant failed: ${lifecycleGrant.text}`);
const lifecycleCookie = await browserLogin(lifecycleUser.data.user.id, "lifecycle");
const dashboardSocket = await openDashboardWs(lifecycleCookie);
await new Promise((resolve) => setTimeout(resolve, 40));

const lifecycleOrder = [];
const collectLifecycle = (raw) => {
  try {
    const event = JSON.parse(String(raw));
    if (event?.type === "tool_started" || event?.type === "tool_finished") lifecycleOrder.push(event);
  } catch {}
};
dashboardSocket.on("message", collectLifecycle);
const lifecycleSensitivePath = "SENSITIVE_FAST_LIFECYCLE_PATH.txt";
const startedPromise = nextDashboardEvent(dashboardSocket, (event) => event.type === "tool_started" && event.tool === "read_file");
const finishedPromise = nextDashboardEvent(dashboardSocket, (event) => event.type === "tool_finished" && event.tool === "read_file");
const fastToolPromise = tool(lifecycleUser.data.token, 40, "read_file", { path: lifecycleSensitivePath }, false, "lifecycle-fast-session");
const [startedEvent, finishedEvent] = await Promise.all([startedPromise, finishedPromise]);
await fastToolPromise;
if (startedEvent.toolCallId !== finishedEvent.toolCallId || finishedEvent.status !== "success" || finishedEvent.ok !== true || !finishedEvent.agentName || finishedEvent.agentName === finishedEvent.agentId) {
  throw new Error(`lifecycle transition mismatch: ${JSON.stringify({ startedEvent, finishedEvent })}`);
}
const ordered = lifecycleOrder.filter((event) => event.toolCallId === startedEvent.toolCallId).map((event) => event.type);
if (ordered[0] !== "tool_started" || ordered[1] !== "tool_finished") {
  throw new Error(`lifecycle delivery order invalid: ${JSON.stringify(ordered)}`);
}
const lifecycleSerialized = JSON.stringify([startedEvent, finishedEvent]);
for (const forbidden of [lifecycleSensitivePath, "PRIVATE_FILE_OUTPUT", "command", "args", "arguments", "payload", "stdout", "stderr"]) {
  if (lifecycleSerialized.includes(forbidden)) throw new Error(`unsafe dashboard lifecycle payload: ${forbidden}`);
}
dashboardSocket.off("message", collectLifecycle);

await tool(ownerToken, 1, "whoami");
await tool(ownerToken, 2, "ping_agent", { agentId: "default" });
await tool(ownerToken, 3, "read_file", { path: "SENSITIVE_PATH_SECRET.txt" });
await tool(ownerToken, 4, "read_file", { path: "fail-SENSITIVE_FAILURE_PATH.txt" }, true);
await tool(ownerToken, 41, "ping_agent", { agentId: "missing-agent" }, true);
await tool(ownerToken, 42, "whoami", {}, false, null);

const runningPromise = tool(ownerToken, 43, "terminal_exec", { command: "echo realtime-running" }, false, "usage-running-session");
await new Promise((resolve) => setTimeout(resolve, 180));
const running = await admin("/admin/api/tool-calls?state=all&status=running&limit=50");
const runningTerminal = (running.data.items || []).find((event) => event.tool === "terminal_exec" && event.status === "running");
if (!runningTerminal || !runningTerminal.activityId) {
  throw new Error(`running tool visibility failed: ${running.text}`);
}
await runningPromise;

const suffix = Date.now().toString(36);
const created = await admin("/admin/users", "POST", { name: "Usage Reader", id: `usage-reader-${suffix}` });
if (!created.response.ok || !created.data.token) throw new Error(`create user failed: ${created.text}`);
const grant = await admin("/admin/grants", "POST", {
  userId: created.data.user.id,
  agentId: "default",
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

const agent = await admin(`/admin/usage?day=${day}&agentId=default`);
if ((agent.data.metric?.calls || 0) < 3 || (agent.data.metric?.errors || 0) < 1) {
  throw new Error(`agent attribution failed: ${agent.text}`);
}

await Promise.all([
  tool(ownerToken, 60, "whoami", {}, false, "concurrent-chat-a"),
  tool(ownerToken, 61, "whoami", {}, false, "concurrent-chat-b"),
]);
const correlated = await admin(`/admin/usage?day=${day}&recentLimit=100`);
const concurrentWhoami = (correlated.data.recent || []).filter((event) => event.tool === "whoami" && event.toolCallId && event.activityId);
const activityIds = new Set(concurrentWhoami.map((event) => event.activityId));
const callIds = new Set(concurrentWhoami.map((event) => event.toolCallId));
if (activityIds.size < 3) throw new Error(`concurrent activity correlation collapsed: ${JSON.stringify(concurrentWhoami)}`);
if (callIds.size !== concurrentWhoami.length) throw new Error("toolCallId is not unique per call");
for (const event of correlated.data.recent || []) {
  if (!event.toolCallId || !String(event.toolCallId).startsWith("tc_")) throw new Error("missing toolCallId in raw usage event");
}
const fallbackActivity = (correlated.data.recent || []).find((event) => event.tool === "whoami" && String(event.activityId || "").startsWith("call_"));
if (!fallbackActivity) throw new Error("missing safe per-call activity fallback for uncorrelated tool call");

const errors = await admin("/admin/api/errors?limit=100");
const syntheticError = (errors.data.items || []).find((event) => event.tool === "read_file" && event.errorCode === "synthetic_failure");
if (!syntheticError || syntheticError.errorSource !== "agent" || syntheticError.failureStage !== "agent" || syntheticError.retryable !== false || !syntheticError.agentName || syntheticError.agentName === syntheticError.agentId) {
  throw new Error(`safe structured error metadata missing: ${errors.text}`);
}

const firstPage = await admin("/admin/api/tool-calls?state=history&agentId=default&limit=2");
if (!firstPage.response.ok || firstPage.data.items?.length !== 2 || !firstPage.data.nextCursor || firstPage.data.items.some((event) => !event.agentName || event.agentName === event.agentId)) {
  throw new Error(`cursor page 1 failed: ${firstPage.text}`);
}
const secondPage = await admin("/admin/api/tool-calls?state=history&agentId=default&limit=2&cursor=" + encodeURIComponent(firstPage.data.nextCursor));
if (!secondPage.response.ok || !secondPage.data.items?.length) throw new Error(`cursor page 2 failed: ${secondPage.text}`);
const firstIds = new Set(firstPage.data.items.map((event) => event.toolCallId));
if (secondPage.data.items.some((event) => firstIds.has(event.toolCallId))) throw new Error("cursor pages overlap");
const invalidCursor = await admin("/admin/api/tool-calls?state=history&limit=2&cursor=not-a-valid-cursor");
if (invalidCursor.response.status !== 400) throw new Error("invalid activity cursor was accepted");

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
socket.close();
console.log("usage telemetry smoke test passed");
