const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8801").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || "test-admin";

async function req(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data, text };
}
async function admin(path, method = "GET", body) {
  return req(path, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function browser(path, { method = "GET", body, cookie, csrf, origin } = {}) {
  return req(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const unauthorized = await browser("/admin/api/users");
if (unauthorized.response.status !== 401) throw new Error("browser admin read was not protected");

const googleUnconfigured = await req("/admin/google/start", { redirect: "manual" });
if (googleUnconfigured.response.status !== 503 || !googleUnconfigured.text.includes("Google login is not configured")) {
  throw new Error(`unconfigured Google login did not fail closed: ${googleUnconfigured.text}`);
}

const bootstrap = await admin("/admin/bootstrap", "POST", { userName: "Owner", agentId: "default", agentName: "Primary PC" });
if (!bootstrap.response.ok) throw new Error(`bootstrap failed: ${bootstrap.text}`);

const suffix = Date.now().toString(36);
const ownerLogin = `admin-owner-${suffix}`;
const ownerPassword = `Owner-${suffix}-Password!`;
const ownerCreds = await admin("/admin/users/login", "POST", { userId: "owner", login: ownerLogin, password: ownerPassword });
if (!ownerCreds.response.ok) throw new Error(`owner creds failed: ${ownerCreds.text}`);

const user = await admin("/admin/users", "POST", { name: "Browser Non Admin", id: `browser-user-${suffix}` });
if (!user.response.ok) throw new Error(`user create failed: ${user.text}`);
const userLogin = `browser-user-${suffix}`;
const userPassword = `Browser-${suffix}-Password!`;
const userCreds = await admin("/admin/users/login", "POST", { userId: user.data.user.id, login: userLogin, password: userPassword });
if (!userCreds.response.ok) throw new Error(`user creds failed: ${userCreds.text}`);

const nonAdminLogin = await browser("/admin/session/login", { method: "POST", body: { login: userLogin, password: userPassword } });
if (!nonAdminLogin.response.ok || !nonAdminLogin.data.csrfToken || nonAdminLogin.data.user?.admin !== false) {
  throw new Error(`non-admin dashboard login failed: ${nonAdminLogin.text}`);
}
const nonAdminCookie = (nonAdminLogin.response.headers.get("set-cookie") || "").split(";")[0];
const nonAdminOverview = await browser("/admin/api/overview", { cookie: nonAdminCookie });
if (!nonAdminOverview.response.ok || nonAdminOverview.data.role !== "user") throw new Error(`self overview failed: ${nonAdminOverview.text}`);
const nonAdminUsers = await browser("/admin/api/users", { cookie: nonAdminCookie });
if (nonAdminUsers.response.status !== 403 || nonAdminUsers.data.error !== "admin_required") throw new Error("non-admin accessed Users API");
const nonAdminErrors = await browser("/admin/api/errors", { cookie: nonAdminCookie });
if (nonAdminErrors.response.status !== 403 || nonAdminErrors.data.error !== "admin_required") throw new Error("non-admin accessed Errors API");

const bruteUser = await admin("/admin/users", "POST", { name: "Brute User", id: `brute-${suffix}` });
const bruteLogin = `brute-${suffix}`;
const brutePassword = `Brute-${suffix}-Password!`;
await admin("/admin/users/login", "POST", { userId: bruteUser.data.user.id, login: bruteLogin, password: brutePassword });
let rateLimited = false;
for (let i = 0; i < 7; i++) {
  const attempt = await browser("/admin/session/login", { method: "POST", body: { login: bruteLogin, password: "wrong-password" } });
  if (attempt.response.status === 429 && attempt.data.error === "too_many_attempts") {
    rateLimited = true;
    break;
  }
}
if (!rateLimited) throw new Error("admin login did not inherit password rate limiting");

const login = await browser("/admin/session/login", { method: "POST", body: { login: ownerLogin, password: ownerPassword } });
if (!login.response.ok || !login.data.csrfToken || !login.data.expiresAt) throw new Error(`admin login failed: ${login.text}`);
const setCookie = login.response.headers.get("set-cookie") || "";
for (const required of ["chat_relay_admin=", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
  if (!setCookie.includes(required)) throw new Error(`missing cookie attribute: ${required}`);
}
if (login.text.includes("adm_")) throw new Error("raw admin session token leaked in response body");
const cookie = setCookie.split(";")[0];
const csrf = login.data.csrfToken;
const expiresAt = Date.parse(login.data.expiresAt);
if (!(expiresAt > Date.now() && expiresAt <= Date.now() + 8 * 60 * 60 * 1000 + 5000)) {
  throw new Error("admin session expiry is outside expected window");
}

const session = await browser("/admin/session", { cookie });
if (!session.response.ok || session.data.user?.id !== "owner" || session.data.user?.admin !== true) {
  throw new Error(`admin session read failed: ${session.text}`);
}
const browserUsers = await browser("/admin/api/users", { cookie });
if (!browserUsers.response.ok) throw new Error(`browser admin API read failed: ${browserUsers.text}`);

const managedLogin = `managed-${suffix}`;
const managedPassword = `Managed-${suffix}-Password!`;
const managedCreate = await browser("/admin/api/users", {
  method: "POST", cookie, csrf, origin: base,
  body: { name: "Managed User", login: managedLogin, password: managedPassword, admin: false },
});
if (!managedCreate.response.ok || managedCreate.data.user?.admin !== false) throw new Error(`dashboard user create failed: ${managedCreate.text}`);
const managedId = managedCreate.data.user.id;
const managedAuth = await browser("/admin/session/login", { method: "POST", body: { login: managedLogin, password: managedPassword } });
if (!managedAuth.response.ok) throw new Error("new user could not login");
const managedCookie = (managedAuth.response.headers.get("set-cookie") || "").split(";")[0];
const softDeleted = await browser("/admin/api/users/soft-delete", {
  method: "POST", cookie, csrf, origin: base, body: { userId: managedId },
});
if (!softDeleted.response.ok || softDeleted.data.user?.enabled !== false || !softDeleted.data.user?.deletedAt) throw new Error(`soft delete failed: ${softDeleted.text}`);
const revokedManagedSession = await browser("/admin/session", { cookie: managedCookie });
if (revokedManagedSession.response.status !== 401) throw new Error("soft-deleted user session remained valid");
const blockedManagedLogin = await browser("/admin/session/login", { method: "POST", body: { login: managedLogin, password: managedPassword } });
if (blockedManagedLogin.response.ok) throw new Error("soft-deleted user could still login");
const restored = await browser("/admin/api/users/restore", {
  method: "POST", cookie, csrf, origin: base, body: { userId: managedId },
});
if (!restored.response.ok || restored.data.user?.enabled !== true || restored.data.user?.deletedAt) throw new Error(`restore failed: ${restored.text}`);
const restoredLogin = await browser("/admin/session/login", { method: "POST", body: { login: managedLogin, password: managedPassword } });
if (!restoredLogin.response.ok || restoredLogin.data.user?.id !== managedId) throw new Error("restored user could not login");

const noCsrf = await browser("/admin/api/sessions/revoke", { method: "POST", cookie, body: { userId: user.data.user.id } });
if (noCsrf.response.status !== 403 || noCsrf.data.error !== "csrf_required") throw new Error("missing CSRF was not rejected");
const badOrigin = await browser("/admin/api/sessions/revoke", {
  method: "POST", cookie, csrf, origin: "https://evil.example", body: { userId: user.data.user.id },
});
if (badOrigin.response.status !== 403 || badOrigin.data.error !== "csrf_invalid") throw new Error("cross-origin admin mutation was not rejected");
const goodMutation = await browser("/admin/api/sessions/revoke", {
  method: "POST", cookie, csrf, origin: base, body: { userId: user.data.user.id },
});
if (!goodMutation.response.ok) throw new Error(`valid browser mutation failed: ${goodMutation.text}`);

const logout = await browser("/admin/session/logout", { method: "POST", cookie, csrf, origin: base, body: {} });
if (!logout.response.ok || !(logout.response.headers.get("set-cookie") || "").includes("Max-Age=0")) {
  throw new Error("admin logout did not clear session cookie");
}
const afterLogout = await browser("/admin/session", { cookie });
if (afterLogout.response.status !== 401) throw new Error("revoked browser session remained active");

const login2 = await browser("/admin/session/login", { method: "POST", body: { login: ownerLogin, password: ownerPassword } });
const cookie2 = (login2.response.headers.get("set-cookie") || "").split(";")[0];
const csrf2 = login2.data.csrfToken;
await admin("/admin/users/enabled", "POST", { userId: "owner", enabled: false });
const disabledSession = await browser("/admin/session", { cookie: cookie2 });
if (disabledSession.response.status !== 401) throw new Error("disabled admin kept browser session access");
await admin("/admin/users/enabled", "POST", { userId: "owner", enabled: true });

const login3 = await browser("/admin/session/login", { method: "POST", body: { login: ownerLogin, password: ownerPassword } });
const cookie3 = (login3.response.headers.get("set-cookie") || "").split(";")[0];
await admin("/admin/api/users/admin", "POST", { userId: "owner", admin: false });
const deadminSession = await browser("/admin/session", { cookie: cookie3 });
if (deadminSession.response.status !== 401) throw new Error("role downgrade did not revoke the privileged browser session");
const userRelogin = await browser("/admin/session/login", { method: "POST", body: { login: ownerLogin, password: ownerPassword } });
if (!userRelogin.response.ok || userRelogin.data.user?.admin !== false) throw new Error("de-admined user could not re-login for self-service");
const userReloginCookie = (userRelogin.response.headers.get("set-cookie") || "").split(";")[0];
const deadminOverview = await browser("/admin/api/overview", { cookie: userReloginCookie });
if (!deadminOverview.response.ok || deadminOverview.data.role !== "user") throw new Error("de-admined user lost self overview");
const deadminUsers = await browser("/admin/api/users", { cookie: userReloginCookie });
if (deadminUsers.response.status !== 403 || deadminUsers.data.error !== "admin_required") throw new Error("de-admined user retained admin API access");
await admin("/admin/api/users/admin", "POST", { userId: "owner", admin: true });

const operatorState = await admin("/admin/state");
if (!operatorState.response.ok) throw new Error("ADMIN_TOKEN operator recovery route broke");
const operatorUsers = await admin("/admin/api/users");
if (!operatorUsers.response.ok) throw new Error("ADMIN_TOKEN stable API access broke");

if (JSON.stringify({ session: session.data, users: browserUsers.data }).includes(adminToken)) {
  throw new Error("ADMIN_TOKEN leaked to browser admin responses");
}
void csrf2;
console.log("admin browser auth smoke test passed");
