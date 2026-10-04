import fs from "node:fs";

const googleSource = fs.readFileSync(new URL("../src/google-auth.ts", import.meta.url), "utf8");
const registrySource = fs.readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const oauthSource = fs.readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");

for (const required of ["code_challenge_method","S256","state","nonce","email_verified","accounts.google.com","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","HMAC"]) {
  if (!googleSource.includes(required)) throw new Error(`google auth contract missing: ${required}`);
}
if (!googleSource.includes("sessionStorage.setItem('chat_relay_csrf'")) throw new Error("Google callback did not persist CSRF");
for (const required of ['case "/google/upsert"','key.userGoogleSub(googleSub)','existing.id === "owner"','existing.admin === true','delete existing.passwordHash','case "/admin-session/create-for-user"','REMEMBERED_ADMIN_SESSION_TTL_MS']) {
  if (!registrySource.includes(required)) throw new Error(`registry Google identity contract missing: ${required}`);
}
if (!adminSource.includes('path === "/admin/google/start"') || !adminSource.includes('path === "/admin/google/callback"')) throw new Error("admin Google routes are missing");
if (!oauthSource.includes('path === "/authorize/google/start"') || !oauthSource.includes("completeGoogleConnectorAuthorization")) throw new Error("connector Google authorization flow is missing");
if (!oauthSource.includes("sessionUser?.id") || !oauthSource.includes('"/oauth/client/authorized"') || !oauthSource.includes("showRecovery")) throw new Error("connector reconnect auto-authorization is missing");
for (const required of ["OAuthConsentRecord", "oauthClientFingerprint", "oauthConsentKey", "OAUTH_CONSENT_TTL_MS", 'prefix: "oauth-consent:"']) {
  if (!registrySource.includes(required)) throw new Error(`remembered connector consent contract missing: ${required}`);
}
if (!oauthSource.includes("scope: validated.params.scope")) throw new Error("remembered connector consent must remain scope-bound");
if (!adminSource.includes("SameSite=Lax") || !adminSource.includes("Path=/; Max-Age=")) throw new Error("persistent browser session cookie is not connector-compatible");
if (!adminSource.includes('"oauth.google.login"')) throw new Error("connector Google callback audit is missing");
if (!dashboard.includes('href="/admin/google/start"')) throw new Error("dashboard Google sign-in entrypoint is missing");
if (!app.includes('sessionStorage.getItem("chat_relay_csrf")') || !app.includes('sessionStorage.removeItem("chat_relay_csrf")')) throw new Error("dashboard CSRF persistence contract is incomplete");
if (!app.includes('/admin/session?refreshCsrf=1') || !app.includes('csrf_required') || !app.includes('csrf_invalid')) throw new Error("dashboard CSRF recovery contract is incomplete");
if (!registrySource.includes('case "/admin-session/refresh-csrf"') || !registrySource.includes('refreshAdminSessionCsrf')) throw new Error("registry CSRF refresh contract is missing");
if (!adminSource.includes('url.searchParams.get("refreshCsrf") === "1"')) throw new Error("admin CSRF refresh route is missing");

const base = process.env.TEST_RELAY_URL?.replace(/\/$/, "");
if (base) {
  const response = await fetch(base + "/admin/google/start", { redirect: "manual" });
  if (response.status !== 503) throw new Error(`unconfigured Google login should fail closed with 503, got ${response.status}`);
  const body = await response.text();
  if (!body.includes("Google login is not configured")) throw new Error("unconfigured Google login did not return a safe error");
}
console.log("google auth smoke test passed");
