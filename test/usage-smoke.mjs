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

async function rpc(token, id, method, params = {}, sessionId = "usage-smoke-session") {
  const response = await fetch(`${base}/mcp?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
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
  } else result = { ok: true };
  socket.send(JSON.stringify({ requestId: message.requestId, payload: result }));
});

await tool(ownerToken, 1, "whoami");
await tool(ownerToken, 2, "ping_agent", { agentId: "default" });
await tool(ownerToken, 3, "read_file", { path: "SENSITIVE_PATH_SECRET.txt" });
await tool(ownerToken, 4, "read_file", { path: "fail-SENSITIVE_FAILURE_PATH.txt" }, true);
await tool(ownerToken, 41, "ping_agent", { agentId: "missing-agent" }, true);

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

const serialized = JSON.stringify(total.data.recent || []);
for (const forbidden of [
  "SENSITIVE_PATH_SECRET",
  "SENSITIVE_FAILURE_PATH",
  "PRIVATE_FILE_OUTPUT",
  "PRIVATE_ERROR_OUTPUT",
  ownerToken,
  agentToken,
]) {
  if (serialized.includes(forbidden)) throw new Error(`sensitive usage payload persisted: ${forbidden}`);
}

socket.close();
console.log("usage telemetry smoke test passed");
