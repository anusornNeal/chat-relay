import WebSocket from "ws";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8808").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";

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

async function authorizeDevice({ agentId, agentName, login, password, name }) {
  const started = await request("/auth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, agentName }),
  });
  if (!started.response.ok) throw new Error("device start failed: " + started.text);

  const approved = await fetch(base + "/auth/device/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      userCode: started.data.userCode,
      login,
      password,
      name,
    }),
  });
  if (!approved.ok) throw new Error("device approval failed: " + approved.status);

  const exchanged = await request("/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: started.data.deviceCode }),
  });
  if (!exchanged.response.ok) throw new Error("device exchange failed: " + exchanged.text);
  return exchanged.data;
}

function wsUrl(agentId) {
  return base.replace(/^http/, "ws") + "/agent?agentId=" + encodeURIComponent(agentId);
}

async function connectAgent(agentId, token) {
  const socket = new WebSocket(wsUrl(agentId), {
    headers: { authorization: "Bearer " + token },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, response) => {
      response.resume();
      reject(new Error("unexpected response " + response.statusCode));
    });
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.control === "credential_revoked") {
        socket.close(4001, "credential_revoked");
      }
    } catch {}
  });
  return socket;
}

async function expectRejectedAgent(agentId, token) {
  const socket = new WebSocket(wsUrl(agentId), {
    headers: { authorization: "Bearer " + token },
  });
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rejected agent handshake timed out")), 4000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("revoked agent credential unexpectedly connected"));
    });
    socket.once("unexpected-response", (_req, response) => {
      clearTimeout(timer);
      const code = response.statusCode;
      response.resume();
      resolve(code);
    });
    socket.once("error", () => {});
  });
  if (status !== 401) throw new Error("revoked credential returned " + status + " instead of 401");
}

async function statusFor(userToken, agentId) {
  return request("/status?agentId=" + encodeURIComponent(agentId), {
    headers: { authorization: "Bearer " + userToken },
  });
}

const suffix = Date.now().toString(36);
const userALogin = "devices-a-" + suffix;
const userBLogin = "devices-b-" + suffix;
const passwordA = "Devices-A-" + suffix + "-Password!";
const passwordB = "Devices-B-" + suffix + "-Password!";
const agentA1Id = "pc-a1-" + suffix;
const agentA2Id = "pc-a2-" + suffix;

const a1 = await authorizeDevice({
  agentId: agentA1Id,
  agentName: "Alice Laptop",
  login: userALogin,
  password: passwordA,
  name: "Alice",
});
const a2 = await authorizeDevice({
  agentId: agentA2Id,
  agentName: "Alice Desktop",
  login: userALogin,
  password: passwordA,
  name: "Alice",
});
if (a1.user.id !== a2.user.id) throw new Error("same login produced different users");
if (a1.agent.id === a2.agent.id) throw new Error("multiple PCs collapsed into one agent");

const bOwn = await authorizeDevice({
  agentId: agentA1Id,
  agentName: "Bob Collision Attempt",
  login: userBLogin,
  password: passwordB,
  name: "Bob",
});
if (bOwn.user.id === a1.user.id) throw new Error("distinct login reused Alice identity");
if (bOwn.agent.id === agentA1Id) throw new Error("second user took over Alice agent id");

const socketA1 = await connectAgent(agentA1Id, a1.agentToken);
const socketA2 = await connectAgent(agentA2Id, a2.agentToken);

const listBefore = await admin("/admin/api/agents?limit=100");
if (!listBefore.response.ok) throw new Error("admin agents list failed: " + listBefore.text);
const aliceAgents = (listBefore.data.items || []).filter((agent) => agent.ownerUserId === a1.user.id);
if (!aliceAgents.some((agent) => agent.id === agentA1Id && agent.online) ||
    !aliceAgents.some((agent) => agent.id === agentA2Id && agent.online)) {
  throw new Error("multi-PC owner/online state missing: " + listBefore.text);
}
const collisionAgent = (listBefore.data.items || []).find((agent) => agent.id === bOwn.agent.id);
if (!collisionAgent || collisionAgent.ownerUserId !== bOwn.user.id) {
  throw new Error("second user distinct agent ownership missing");
}

const renamed = await admin("/admin/api/agents/rename", "POST", {
  agentId: agentA1Id,
  name: "Alice Workstation",
  expectedOwnerUserId: a1.user.id,
});
if (!renamed.response.ok || renamed.data.agent?.name !== "Alice Workstation") {
  throw new Error("agent rename failed: " + renamed.text);
}

const ownerMismatch = await admin("/admin/api/agents/rename", "POST", {
  agentId: agentA1Id,
  name: "Should Not Apply",
  expectedOwnerUserId: bOwn.user.id,
});
if (ownerMismatch.response.status !== 409 || ownerMismatch.data.error !== "owner_mismatch") {
  throw new Error("rename owner guard failed: " + ownerMismatch.text);
}

const closePromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("retired agent socket did not close")), 4000);
  socketA1.once("close", (code, reason) => {
    clearTimeout(timer);
    resolve({ code, reason: reason.toString() });
  });
});

const retired = await admin("/admin/api/agents/retire", "POST", {
  agentId: agentA1Id,
  expectedOwnerUserId: a1.user.id,
});
if (!retired.response.ok || retired.data.agent?.retiredAt == null) {
  throw new Error("agent retire failed: " + retired.text);
}
if ((retired.data.disconnect?.disconnected || 0) < 1) {
  throw new Error("relay disconnect saw no live sockets: " + retired.text);
}
const closed = await closePromise;
if (closed.code !== 4001 || closed.reason !== "credential_revoked") {
  throw new Error("retired socket closed incorrectly: " + JSON.stringify(closed));
}

await expectRejectedAgent(agentA1Id, a1.agentToken);

const retiredStatus = await statusFor(a1.userToken, agentA1Id);
if (!retiredStatus.response.ok ||
    retiredStatus.data.authorized !== false ||
    retiredStatus.data.reauthorizationRequired !== true ||
    retiredStatus.data.online !== false ||
    retiredStatus.data.agentName !== "Alice Workstation") {
  throw new Error("retired status is not actionable: " + retiredStatus.text);
}

const detail = await admin("/admin/api/agents/" + encodeURIComponent(agentA1Id));
if (!detail.response.ok ||
    detail.data.agent?.lifecycle !== "retired" ||
    detail.data.agent?.owner?.id !== a1.user.id ||
    !detail.data.agent?.grants?.some((grant) => grant.userId === a1.user.id)) {
  throw new Error("retired dashboard detail incomplete: " + detail.text);
}

const enableRetired = await admin("/admin/agents/enabled", "POST", {
  agentId: agentA1Id,
  enabled: true,
});
if (enableRetired.response.status !== 409 || enableRetired.data.error !== "reauthorization_required") {
  throw new Error("retired agent was re-enabled without authorization: " + enableRetired.text);
}

const bCollisionAfterRetire = await authorizeDevice({
  agentId: agentA1Id,
  agentName: "Bob Retired Collision",
  login: userBLogin,
  password: passwordB,
  name: "Bob",
});
if (bCollisionAfterRetire.agent.id === agentA1Id) {
  throw new Error("other owner reclaimed retired agent id");
}

const a1Reauthorized = await authorizeDevice({
  agentId: agentA1Id,
  agentName: "Stale Local Name",
  login: userALogin,
  password: passwordA,
  name: "Alice",
});
if (a1Reauthorized.agent.id !== agentA1Id) throw new Error("owner did not reclaim original agent id");
if (a1Reauthorized.agent.name !== "Alice Workstation") {
  throw new Error("reauthorization overwrote server-side rename");
}

const socketA1Reauthorized = await connectAgent(agentA1Id, a1Reauthorized.agentToken);
const activeStatus = await statusFor(a1Reauthorized.userToken, agentA1Id);
if (!activeStatus.response.ok ||
    activeStatus.data.authorized !== true ||
    activeStatus.data.reauthorizationRequired !== false ||
    activeStatus.data.online !== true ||
    activeStatus.data.agentName !== "Alice Workstation") {
  throw new Error("reauthorized status invalid: " + activeStatus.text);
}

const finalDetail = await admin("/admin/api/agents/" + encodeURIComponent(agentA1Id));
if (!finalDetail.response.ok ||
    finalDetail.data.agent?.retiredAt !== null ||
    finalDetail.data.agent?.owner?.id !== a1.user.id ||
    !finalDetail.data.agent?.grants?.some((grant) => grant.userId === a1.user.id)) {
  throw new Error("reauthorization lost lifecycle/ownership/grant state: " + finalDetail.text);
}

socketA1Reauthorized.close();
socketA2.close();
console.log("device management lifecycle smoke test passed");
