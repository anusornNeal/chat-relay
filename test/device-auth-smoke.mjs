import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { build } from "esbuild";

// Bundle the production handlers, replacing only Cloudflare's host base class.
// Storage copies values like Durable Object storage; Google is the only mocked provider.
const bundled = await build({
  stdin: { contents: 'export { Registry, hashToken } from "./src/registry"; export { handleDeviceAuth } from "./src/device-auth"; export { handleAdmin } from "./src/admin"; export { handleOAuth } from "./src/oauth";', resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{ name: "durable-object-host", setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "test-host" }));
    builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
  } }],
});
const { Registry, hashToken, handleDeviceAuth, handleAdmin, handleOAuth } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const records = new Map();
const storage = {
  async transaction(callback) { return callback(storage); },
  async get(key) { return structuredClone(records.get(key)); },
  async put(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) records.set(k, structuredClone(v));
    else records.set(key, structuredClone(value));
  },
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
  async list({ prefix = "", limit = Infinity, startAfter = "" } = {}) {
    return new Map([...records].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a],[b]) => a.localeCompare(b)).slice(0,limit).map(([k,v]) => [k,structuredClone(v)]));
  },
};
const registry = new Registry({ storage }, {});
const registryCall = (path, body) => registry.fetch(new Request("https://registry.internal" + path, {
  method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
}));
const namespace = stub => ({ idFromName: name => name, get: () => stub });
const idle = namespace({ fetch: async () => Response.json({ ok: true }) });
const env = {
  GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-only-secret",
  REGISTRY: namespace(registry), AUDIT: idle, DASHBOARD: idle, RELAY: idle, USAGE: idle,
};
const base = "https://relay.example";
const providers = new Map();
let providerRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  providerRequests++;
  const target = String(url);
  if (target === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(options.body);
    const identity = providers.get(form.get("code"));
    if (!identity) return Response.json({ error: "invalid_grant" }, { status: 400 });
    assert.equal(form.get("client_id"), env.GOOGLE_CLIENT_ID);
    assert.ok(form.get("code_verifier"));
    return Response.json({ id_token: "e30." + Buffer.from(JSON.stringify(identity)).toString("base64url") + ".mock" });
  }
  if (target.startsWith("https://oauth2.googleapis.com/tokeninfo?")) {
    const token = new URL(target).searchParams.get("id_token");
    return Response.json(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()));
  }
  throw new Error("Unexpected network request: " + target);
};
const request = (path, options) => new Request(base + path, options);
const device = (req, configuration = env) => handleDeviceAuth(req, registryCall, async () => null, configuration);
const post = (path, body, origin = base) => request(path, {
  method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body),
});
const jsonPost = (path, body) => request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const start = async (agentId = "laptop") => {
  const response = await device(jsonPost("/auth/device/start", { agentId, agentName: "My computer" }));
  assert.equal(response.status, 200); return response.json();
};
const exchange = code => device(jsonPost("/auth/device/token", { deviceCode: code }));
const securityRevision = async () => (await (await registryCall("/security/revision")).json()).revision;
function callbackFrom(response, account = "alice", overrides = {}, expectedPrompt = "select_account", includeCookie = true) {
  assert.equal(response.status, 302);
  const google = new URL(response.headers.get("location"));
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(google.searchParams.get("prompt"), expectedPrompt);
  const code = "mock-" + providers.size;
  providers.set(code, { iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID,
    sub: account, email: account + "@example.com", name: account, email_verified: true,
    exp: Math.floor(Date.now()/1000)+600, nonce: google.searchParams.get("nonce"), ...overrides });
  return request("/admin/google/callback?" + new URLSearchParams({ state: google.searchParams.get("state"), code }), {
    headers: includeCookie ? { cookie: response.headers.get("set-cookie").split(";")[0] } : {},
  });
}
const approvalStart = code => device(post("/auth/device/approve", { userCode: code }));
async function authorize(code, account = "alice") {
  const callback = callbackFrom(await approvalStart(code), account);
  const response = await handleAdmin(callback, env);
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.match(await response.text(), /Computer authorized/);
  return callback;
}
try {
  const first = await start();
  const page = await device(request("/device?user_code=" + first.userCode));
  const html = await page.text();
  assert.match(html, /Continue with Google and authorize computer/);
  assert.doesNotMatch(html, /name="(?:login|password|name)"/);
  const pendingRevision = await securityRevision();
  assert.equal((await exchange(first.deviceCode)).status, 428); // GET never approves.
  assert.equal(await securityRevision(), pendingRevision); // Polling must not invalidate security caches.
  for (const field of ["login", "password", "userId", "name"]) {
    const forged = await device(post("/auth/device/approve", { userCode: first.userCode, [field]: "owner" }));
    assert.equal(forged.status, 400);
  }
  assert.equal((await device(post("/auth/device/approve", { userCode: first.userCode }, "https://evil.example"))).status, 403);
  assert.equal((await device(post("/auth/device/approve", { userCode: first.userCode }, ""))).status, 403);
  assert.equal((await approvalStart("ZZZZ-ZZZZ")).status, 404);
  assert.equal((await device(request("/device"), {})).status, 503);
  assert.equal((await device(post("/auth/device/approve", { userCode: first.userCode }), {})).status, 503);
  assert.equal((await exchange(first.deviceCode)).status, 428);

  const begin = await approvalStart(first.userCode.toLowerCase());
  const callback = callbackFrom(begin);
  const wrongState = new URL(callback.url); wrongState.searchParams.set("state", "forged");
  const before = providerRequests;
  assert.equal((await handleAdmin(new Request(wrongState, { headers: callback.headers }), env)).status, 400);
  // The callback no longer depends on a browser cookie; the one-time server state is authoritative.
  assert.equal(providerRequests, before);
  const approved = await handleAdmin(callback, env);
  assert.equal(approved.status, 200); assert.match(approved.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await handleAdmin(callback, env)).status, 409); // Signed callback cannot approve twice.
  const exchangeRevision = await securityRevision();
  const granted = await exchange(first.deviceCode); assert.equal(granted.status, 200);
  assert.equal(await securityRevision(), exchangeRevision + 1); // Successful exchange changes agent/session access.
  const credentials = await granted.json(); assert.equal(credentials.user.authProvider, "google");
  assert.equal(credentials.user.email, "alice@example.com");
  assert.ok(credentials.userToken && credentials.agentToken);
  assert.equal((await exchange(first.deviceCode)).status, 400);
  const user = await storage.get("user:" + credentials.user.id);
  assert.ok(user.googleSub); assert.equal(user.passwordHash, undefined);
  assert.equal((await registryCall("/auth/agent", { agentId: credentials.agent.id, tokenHash: await hashToken(credentials.agentToken) })).status, 200);

  // Connector and local agent must resolve the exact same verified Google subject.
  const clientId = "test-connector";
  await registryCall("/oauth/client/register", { clientId, redirectUris: ["https://client.example/callback"] });
  const verifier = "v".repeat(64);
  const params = { client_id: clientId, redirect_uri: "https://client.example/callback", response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    resource: base + "/mcp", scope: "mcp offline_access", state: "client-state" };
  const connectorStart = await handleOAuth(request("/authorize/google/start?" + new URLSearchParams(params)), registryCall, env);
  const connector = await handleAdmin(callbackFrom(connectorStart, "alice", {}, null, false), env);
  assert.equal(connector.status, 302);
  const authCode = new URL(connector.headers.get("location")).searchParams.get("code");
  const codeRecord = await storage.get("oauth-code:" + await hashToken(authCode));
  assert.equal(codeRecord.userId, credentials.user.id);
  assert.equal((await registryCall("/agent-access", { userId: codeRecord.userId, agentId: credentials.agent.id })).status, 200);

  // Same owner's reauthorization rotates only its agent; a different account is isolated.
  const second = await start(); await authorize(second.userCode);
  const reauthorized = await (await exchange(second.deviceCode)).json();
  assert.equal(reauthorized.user.id, credentials.user.id); assert.equal(reauthorized.agent.id, credentials.agent.id);
  assert.notEqual(reauthorized.agentToken, credentials.agentToken);
  assert.equal((await registryCall("/auth/agent", { agentId: credentials.agent.id, tokenHash: await hashToken(credentials.agentToken) })).status, 401);
  const collision = await start(); await authorize(collision.userCode, "bob");
  const bob = await (await exchange(collision.deviceCode)).json();
  assert.notEqual(bob.agent.id, credentials.agent.id); assert.notEqual(bob.user.id, credentials.user.id);
  assert.equal((await registryCall("/agent-access", { userId: bob.user.id, agentId: credentials.agent.id })).status, 403);
  await registryCall("/agents/rename", { agentId: credentials.agent.id, name: "Renamed computer" });
  await registryCall("/agents/retire", { agentId: credentials.agent.id });
  const retired = await start(); await authorize(retired.userCode);
  const restored = await (await exchange(retired.deviceCode)).json();
  assert.equal(restored.agent.id, credentials.agent.id); assert.equal(restored.agent.name, "Renamed computer");
  assert.equal((await storage.get("agent:" + restored.agent.id)).retiredAt, undefined);
  await registryCall("/session/revoke", { tokenHash: await hashToken(bob.userToken) });
  assert.equal((await registryCall("/auth/user", { tokenHash: await hashToken(bob.userToken) })).status, 401);
  assert.equal((await registryCall("/auth/agent", { agentId: bob.agent.id, tokenHash: await hashToken(bob.agentToken) })).status, 200);
  await registryCall("/session/logout-agent", { userId: restored.user.id, agentId: restored.agent.id, tokenHash: await hashToken(restored.userToken) });
  assert.equal((await registryCall("/auth/user", { tokenHash: await hashToken(restored.userToken) })).status, 401);
  assert.equal((await registryCall("/auth/agent", { agentId: restored.agent.id, tokenHash: await hashToken(restored.agentToken) })).status, 401);

  // Expiration while Google is open must leave the computer unauthorized.
  const expiring = await start("expiring");
  const expiringCallback = callbackFrom(await approvalStart(expiring.userCode));
  const expiringKey = "device:" + await hashToken(expiring.deviceCode);
  const expired = await storage.get(expiringKey); expired.expiresAt = new Date(Date.now()-1).toISOString();
  await storage.put(expiringKey, expired);
  assert.equal((await handleAdmin(expiringCallback, env)).status, 410);
  assert.equal((await exchange(expiring.deviceCode)).status, 400);

  const disabled = await start("disabled"); const disabledCallback = callbackFrom(await approvalStart(disabled.userCode));
  await registryCall("/users/set-enabled", { userId: credentials.user.id, enabled: false });
  const disabledResponse = await handleAdmin(disabledCallback, env);
  assert.equal(disabledResponse.status, 403); assert.match(disabledResponse.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await exchange(disabled.deviceCode)).status, 428);
  await registryCall("/users/set-enabled", { userId: credentials.user.id, enabled: true });
  const deletedUser = await storage.get("user:" + credentials.user.id); deletedUser.deletedAt = new Date().toISOString();
  await storage.put("user:" + credentials.user.id, deletedUser);
  assert.equal((await handleAdmin(disabledCallback, env)).status, 403);
  assert.equal((await registryCall("/device/approve", { userCode: disabled.userCode, userId: credentials.user.id })).status, 403);
  delete deletedUser.deletedAt; await storage.put("user:" + credentials.user.id, deletedUser);
  await registryCall("/users/create", { id: "legacy", name: "Legacy", tokenHash: "legacy-token" });
  assert.equal((await registryCall("/device/approve", { userCode: disabled.userCode, userId: "legacy", login: "legacy", password: "password" })).status, 403);
  const invalidIdentity = await handleAdmin(callbackFrom(await approvalStart(disabled.userCode), "alice", { email_verified: false }), env);
  assert.equal(invalidIdentity.status, 401);
  assert.equal((await exchange(disabled.deviceCode)).status, 428);
  const approvedThenDisabled = await start("disabled-during-poll"); await authorize(approvedThenDisabled.userCode);
  await registryCall("/users/set-enabled", { userId: credentials.user.id, enabled: false });
  assert.equal((await exchange(approvedThenDisabled.deviceCode)).status, 403);
  const rateHash = await hashToken("rate-test");
  for (let i=0; i<60; i++) assert.equal((await registryCall("/device/lookup", { userCode: "ZZZZ-ZZZZ", sourceHash: rateHash })).status, 404);
  assert.equal((await registryCall("/device/lookup", { userCode: "ZZZZ-ZZZZ", sourceHash: rateHash })).status, 429);
  console.log("Google-only device auth: production approval/callback, shared connector identity, expiry/replay, collisions, rotation, revocation, disabled/deleted accounts, CSRF, and rate limits passed");
} finally { globalThis.fetch = originalFetch; }
