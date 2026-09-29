import { spawn } from "node:child_process";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8796").replace(/\/$/, "");
const suffix = Date.now().toString(36);
const login = `device-test-${suffix}`;
const password = `Smoke-${suffix}-Password!`;
const agentId = `device-test-${suffix}`;

async function jsonFetch(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, data };
}

const started = await jsonFetch("/auth/device/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId, agentName: "Device Auth Smoke" }),
});
if (!started.response.ok || !started.data.deviceCode || !started.data.userCode) {
  throw new Error(`device start failed: ${JSON.stringify(started.data)}`);
}
console.log("device start ok");

const form = new URLSearchParams({
  userCode: started.data.userCode,
  login,
  password,
  name: "Device Test",
});
const approved = await fetch(base + "/auth/device/approve", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form,
});
if (!approved.ok) throw new Error(`device approve failed: ${approved.status}`);
console.log("browser approval ok");

const exchanged = await jsonFetch("/auth/device/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceCode: started.data.deviceCode }),
});
if (!exchanged.response.ok || !exchanged.data.userToken || !exchanged.data.agentToken) {
  throw new Error(`device exchange failed: ${JSON.stringify(exchanged.data)}`);
}
console.log("credential exchange ok");

const authHeader = { authorization: `Bearer ${exchanged.data.userToken}` };
const me = await jsonFetch("/auth/me", { headers: authHeader });
if (!me.response.ok || me.data.user?.login !== login) {
  throw new Error(`auth me failed: ${JSON.stringify(me.data)}`);
}
console.log("session auth ok");

const secondStarted = await jsonFetch("/auth/device/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId, agentName: "Collision Smoke" }),
});
if (!secondStarted.response.ok) throw new Error("second device start failed");

const secondApproved = await fetch(base + "/auth/device/approve", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    userCode: secondStarted.data.userCode,
    login: `${login}-other`,
    password: `${password}-other`,
    name: "Collision User",
  }),
});
if (!secondApproved.ok) throw new Error("second device approve failed");

const secondExchange = await jsonFetch("/auth/device/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceCode: secondStarted.data.deviceCode }),
});
if (!secondExchange.response.ok) throw new Error("second device exchange failed");
if (secondExchange.data.agent.id === exchanged.data.agent.id) {
  throw new Error("agent ownership collision was not isolated");
}
console.log("agent ownership isolation ok");

const secondRevoke = await jsonFetch("/auth/session/revoke", {
  method: "POST",
  headers: { authorization: `Bearer ${secondExchange.data.userToken}` },
});
if (!secondRevoke.response.ok) throw new Error("session revoke failed");
const secondAfterRevoke = await jsonFetch("/auth/me", {
  headers: { authorization: `Bearer ${secondExchange.data.userToken}` },
});
if (secondAfterRevoke.response.status !== 401) throw new Error("revoked session was accepted");
console.log("session-only revocation ok");

const agent = spawn(process.execPath, ["agent/local-agent.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_URL: base,
    AGENT_ID: exchanged.data.agent.id,
    AGENT_NAME: exchanged.data.agent.name,
    AGENT_TOKEN: exchanged.data.agentToken,
    TERMINAL_ENABLED: "1",
    ALLOWED_ROOTS: process.cwd(),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let agentOutput = "";
agent.stdout.on("data", (chunk) => { agentOutput += chunk.toString(); });
agent.stderr.on("data", (chunk) => { agentOutput += chunk.toString(); });

try {
  let online = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = await jsonFetch(`/status?agentId=${encodeURIComponent(exchanged.data.agent.id)}`, {
      headers: authHeader,
    });
    if (status.response.ok && status.data.online) {
      online = true;
      break;
    }
  }
  if (!online) throw new Error(`agent did not connect: ${agentOutput}`);
  console.log("provisioned agent connection ok");

  const loggedOut = await jsonFetch("/auth/logout", {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({ agentId: exchanged.data.agent.id }),
  });
  if (!loggedOut.response.ok) throw new Error(`logout failed: ${JSON.stringify(loggedOut.data)}`);

  const afterLogout = await jsonFetch("/auth/me", { headers: authHeader });
  if (afterLogout.response.status !== 401) {
    throw new Error(`revoked session still accepted: ${afterLogout.response.status}`);
  }
  console.log("logout revocation ok");
} finally {
  agent.kill();
}

console.log("device auth smoke test passed");
