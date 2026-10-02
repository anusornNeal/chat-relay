import { createHash } from "node:crypto";
import fs from "node:fs";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8796").replace(/\/$/, "");
const resource = `${base}/mcp`;
const redirectUri = "https://client.example/callback";
const suffix = Date.now().toString(36);
const login = `oauth-${suffix}`;
const password = `OAuth-${suffix}-Password!`;

function localVars() {
  if (!fs.existsSync(".dev.vars")) return {};
  return Object.fromEntries(
    fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
      .filter((line) => line && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

const vars = localVars();
const adminToken = process.env.TEST_ADMIN_TOKEN || vars.ADMIN_TOKEN || "test-admin";
const callerToken = process.env.TEST_CALLER_TOKEN || vars.CALLER_TOKEN || "test-caller";

async function jsonFetch(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, data, text };
}

function challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function formBody(values) {
  return new URLSearchParams(values);
}

async function mcpRpc(token, id, method, params = {}, queryKey = false) {
  const response = await fetch(
    queryKey ? `${base}/mcp?key=${encodeURIComponent(token)}` : `${base}/mcp`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(queryKey ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${response.status}: ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
}

const protectedMeta = await jsonFetch("/.well-known/oauth-protected-resource");
if (!protectedMeta.response.ok ||
    protectedMeta.data.resource !== resource ||
    !protectedMeta.data.authorization_servers?.includes(base) ||
    !protectedMeta.data.scopes_supported?.includes("mcp") ||
    !protectedMeta.data.scopes_supported?.includes("offline_access")) {
  throw new Error("protected resource metadata invalid");
}
console.log("protected resource metadata ok");

const authMeta = await jsonFetch("/.well-known/oauth-authorization-server");
if (!authMeta.response.ok ||
    authMeta.data.authorization_endpoint !== `${base}/authorize` ||
    !authMeta.data.code_challenge_methods_supported?.includes("S256")) {
  throw new Error("authorization server metadata invalid");
}
console.log("authorization server metadata ok");

const badRegistration = await jsonFetch("/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Bad Client",
    redirect_uris: ["http://evil.example/callback"],
  }),
});
if (badRegistration.response.status !== 400 ||
    badRegistration.data.error !== "invalid_redirect_uri") {
  throw new Error("invalid redirect URI was accepted");
}

const registration = await jsonFetch("/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "OAuth Smoke",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
if (!registration.response.ok || !registration.data.client_id) {
  throw new Error(`registration failed: ${registration.text}`);
}
const clientId = registration.data.client_id;
console.log("dynamic client registration ok");

const deviceStart = await jsonFetch("/auth/device/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agentId: `oauth-agent-${suffix}`,
    agentName: "OAuth Smoke Agent",
  }),
});
if (!deviceStart.response.ok) {
  throw new Error(`device start failed: ${deviceStart.text}`);
}

const approved = await fetch(`${base}/auth/device/approve`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    userCode: deviceStart.data.userCode,
    login,
    password,
    name: "OAuth Smoke User",
  }),
});
if (!approved.ok) throw new Error(`device approval failed: ${approved.status}`);

const deviceExchange = await jsonFetch("/auth/device/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceCode: deviceStart.data.deviceCode }),
});
if (!deviceExchange.response.ok) throw new Error("device exchange failed");
console.log("OAuth account fixture ok");

const verifier = "v".repeat(64);
const authorizeParams = {
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  code_challenge: challenge(verifier),
  code_challenge_method: "S256",
  scope: "mcp offline_access",
  resource,
  state: `state-${suffix}`,
};

const authorizePage = await fetch(
  `${base}/authorize?${new URLSearchParams(authorizeParams)}`,
  { redirect: "manual" },
);
if (!authorizePage.ok || !(await authorizePage.text()).includes("Authorize OAuth Smoke")) {
  throw new Error("authorization page invalid");
}

const authorizePost = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ ...authorizeParams, login, password }),
  redirect: "manual",
});
if (authorizePost.status !== 302) {
  throw new Error(`authorize failed: ${authorizePost.status}`);
}

const callback = new URL(authorizePost.headers.get("location"));
const code = callback.searchParams.get("code");
if (!code || callback.searchParams.get("state") !== authorizeParams.state) {
  throw new Error("authorization code/state missing");
}
console.log("authorization code flow ok");

const wrongVerifier = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: "x".repeat(64),
    resource,
  }),
});
if (wrongVerifier.response.status !== 400 ||
    wrongVerifier.data.error !== "invalid_grant") {
  throw new Error("wrong PKCE verifier was accepted");
}

const token = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
});
if (!token.response.ok ||
    !token.data.access_token ||
    !token.data.refresh_token ||
    token.data.token_type !== "Bearer") {
  throw new Error(`token exchange failed: ${token.text}`);
}
console.log("PKCE token exchange ok");

const reusedCode = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
});
if (reusedCode.data.error !== "invalid_grant") {
  throw new Error("authorization code was reusable");
}

const unauthenticated = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }),
});
const challengeHeader = unauthenticated.headers.get("www-authenticate") || "";
if (unauthenticated.status !== 401 ||
    !challengeHeader.includes("resource_metadata=") ||
    !challengeHeader.includes('scope="mcp offline_access"')) {
  throw new Error("MCP OAuth challenge missing");
}
console.log("MCP challenge ok");

const oauthTools = await mcpRpc(token.data.access_token, 2, "tools/list");
if (!oauthTools.result?.tools?.some((item) => item.name === "whoami")) {
  throw new Error("OAuth bearer could not access MCP");
}
console.log("OAuth bearer MCP access ok");

const audienceCheck = await fetch(`${base}/status`, {
  headers: { authorization: `Bearer ${token.data.access_token}` },
});
if (audienceCheck.status !== 401) {
  throw new Error("OAuth access token was accepted outside the MCP resource");
}
console.log("resource audience binding ok");

const refreshed = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: token.data.refresh_token,
    resource,
  }),
});
if (!refreshed.response.ok ||
    !refreshed.data.access_token ||
    !refreshed.data.refresh_token ||
    refreshed.data.refresh_token === token.data.refresh_token) {
  throw new Error(`refresh failed: ${refreshed.text}`);
}

const retriedRefresh = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: token.data.refresh_token,
    resource,
  }),
});
if (!retriedRefresh.response.ok ||
    retriedRefresh.data.access_token !== refreshed.data.access_token ||
    retriedRefresh.data.refresh_token !== refreshed.data.refresh_token) {
  throw new Error(`refresh retry was not idempotent: ${retriedRefresh.text}`);
}
console.log("refresh retry replay ok");

const rotatedAgain = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshed.data.refresh_token,
    resource,
  }),
});
if (!rotatedAgain.response.ok ||
    !rotatedAgain.data.refresh_token ||
    rotatedAgain.data.refresh_token === refreshed.data.refresh_token) {
  throw new Error(`refresh rotation failed: ${rotatedAgain.text}`);
}
console.log("refresh rotation ok");

const wrongResource = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: rotatedAgain.data.refresh_token,
    resource: `${base}/other`,
  }),
});
if (wrongResource.data.error !== "invalid_target") {
  throw new Error("unexpected resource validation result");
}

const missingClient = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "refresh_token",
    client_id: "client_missing",
    refresh_token: rotatedAgain.data.refresh_token,
    resource,
  }),
});
if (missingClient.data.error !== "invalid_client") {
  throw new Error("unexpected client validation result");
}
console.log("OAuth negative cases ok");

const bootstrap = await jsonFetch("/admin/bootstrap", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    userName: "Owner",
    agentId: "default",
    agentName: "Primary PC",
  }),
});
if (!bootstrap.response.ok) {
  throw new Error(`legacy bootstrap failed: ${bootstrap.text}`);
}

const ownerLogin = `owner-${suffix}`;
const ownerPassword = `Owner-${suffix}-Password!`;
const duplicateLogin = await jsonFetch("/admin/users/login", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ userId: "owner", login, password: ownerPassword }),
});
if (duplicateLogin.response.status !== 409 || duplicateLogin.data.error !== "login_exists") {
  throw new Error(`duplicate login was accepted: ${duplicateLogin.text}`);
}

const migrated = await jsonFetch("/admin/users/login", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ userId: "owner", login: ownerLogin, password: ownerPassword }),
});
if (!migrated.response.ok || migrated.data.user?.id !== "owner" || migrated.data.user?.login !== ownerLogin) {
  throw new Error(`owner login migration failed: ${migrated.text}`);
}
console.log("legacy owner login migration ok");

const ownerBrowserLogin = await jsonFetch("/admin/session/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login: ownerLogin, password: ownerPassword }),
});
if (!ownerBrowserLogin.response.ok) throw new Error(`owner browser session failed: ${ownerBrowserLogin.text}`);
const ownerBrowserCookie = (ownerBrowserLogin.response.headers.get("set-cookie") || "").split(";")[0];
const ownerVerifier = "o".repeat(64);
const ownerAuthorizeParams = {
  ...authorizeParams,
  code_challenge: challenge(ownerVerifier),
  state: `owner-state-${suffix}`,
};
const badOwnerLogin = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ ...ownerAuthorizeParams, login: ownerLogin, password: "wrong-password" }),
  redirect: "manual",
});
if (!badOwnerLogin.ok || !(await badOwnerLogin.text()).includes("Invalid login or password")) {
  throw new Error("wrong migrated-owner password was not rejected");
}

const disabledOwner = await jsonFetch("/admin/users/enabled", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ userId: "owner", enabled: false }),
});
if (!disabledOwner.response.ok) throw new Error("failed to disable migrated owner fixture");
const disabledAuthorize = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ ...ownerAuthorizeParams, login: ownerLogin, password: ownerPassword }),
  redirect: "manual",
});
if (!disabledAuthorize.ok || !(await disabledAuthorize.text()).includes("Invalid login or password")) {
  throw new Error("disabled migrated owner was able to authorize");
}
const reenabledOwner = await jsonFetch("/admin/users/enabled", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ userId: "owner", enabled: true }),
});
if (!reenabledOwner.response.ok) throw new Error("failed to re-enable migrated owner fixture");

const ownerAuthorize = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({ ...ownerAuthorizeParams, login: ownerLogin, password: ownerPassword }),
  redirect: "manual",
});
if (ownerAuthorize.status !== 302) throw new Error(`owner authorize failed: ${ownerAuthorize.status}`);
const ownerCallback = new URL(ownerAuthorize.headers.get("location"));
const ownerCode = ownerCallback.searchParams.get("code");
if (!ownerCode) throw new Error("migrated owner authorization code missing");
const ownerToken = await jsonFetch("/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: formBody({
    grant_type: "authorization_code",
    client_id: clientId,
    code: ownerCode,
    redirect_uri: redirectUri,
    code_verifier: ownerVerifier,
    resource,
  }),
});
if (!ownerToken.response.ok || !ownerToken.data.access_token) {
  throw new Error(`migrated owner token exchange failed: ${ownerToken.text}`);
}
const reconnectVerifier = "r".repeat(64);
const reconnectAuthorizeParams = {
  ...authorizeParams,
  code_challenge: challenge(reconnectVerifier),
  state: `reconnect-state-${suffix}`,
};
const reconnectAuthorize = await fetch(`${base}/authorize?${new URLSearchParams(reconnectAuthorizeParams)}`, {
  headers: { cookie: ownerBrowserCookie },
  redirect: "manual",
});
if (reconnectAuthorize.status !== 302) throw new Error(`persisted browser session did not auto-authorize: ${reconnectAuthorize.status}`);
const reconnectCallback = new URL(reconnectAuthorize.headers.get("location"));
if (!reconnectCallback.searchParams.get("code") || reconnectCallback.searchParams.get("state") !== reconnectAuthorizeParams.state) {
  throw new Error("persisted browser session authorization code/state missing");
}
console.log("persisted browser session auto-authorization ok");
const ownerWho = await mcpRpc(ownerToken.data.access_token, 3, "tools/call", {
  name: "whoami",
  arguments: {},
});
const ownerWhoText = ownerWho.result?.content?.[0]?.text;
const ownerWhoData = ownerWhoText ? JSON.parse(ownerWhoText) : null;
if (ownerWhoData?.user?.id !== "owner") throw new Error("migrated OAuth owner identity changed");
const ownerAgents = await mcpRpc(ownerToken.data.access_token, 4, "tools/call", {
  name: "list_agents",
  arguments: {},
});
const ownerAgentsText = ownerAgents.result?.content?.[0]?.text;
const ownerAgentsData = ownerAgentsText ? JSON.parse(ownerAgentsText) : null;
if (!ownerAgentsData?.agents?.some((agent) => agent.id === "default")) {
  throw new Error("migrated owner lost default agent grant");
}
console.log("migrated owner OAuth identity and grant ok");

const legacyTools = await mcpRpc(callerToken, 5, "tools/list", {}, true);
if (!legacyTools.result?.tools?.some((item) => item.name === "whoami")) {
  throw new Error("legacy MCP authentication failed");
}
console.log("legacy MCP compatibility ok");

console.log("OAuth smoke test passed");
