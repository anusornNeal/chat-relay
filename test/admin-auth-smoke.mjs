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
// Non-admin group owners can choose from existing active accounts without
// receiving admin-only user details or enumerating another group's members.
const groupCreation = await browser("/admin/api/learn/groups", {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken,
  origin: base, body: { name: "Picker " + suffix, projectKey: "picker-" + suffix },
});
if (groupCreation.response.status !== 201) throw new Error("non-admin could not create Learn group: " + groupCreation.text);
const directLearnPath = "/admin/api/learn/groups/" + groupCreation.data.group.id + "/learn";
const missingLearnCsrf = await browser(directLearnPath, {
  method: "POST", cookie: nonAdminCookie,
  body: { key: "direct-rule", kind: "workflow", content: "## Working rule" },
});
if (missingLearnCsrf.response.status !== 403) throw new Error("Add Learn accepted missing CSRF");
const directLearn = await browser(directLearnPath, {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken, origin: base,
  body: { key: "direct-rule", kind: "workflow", content: "## Working rule" },
});
if (directLearn.response.status !== 201 || directLearn.data.status !== "pending") {
  throw new Error("Direct Add Learn failed: " + directLearn.text);
}
const directPending = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id, { cookie: nonAdminCookie });
if (!directPending.response.ok || directPending.data.memories.length ||
    !directPending.data.proposals.some((item) => item.id === directLearn.data.proposalId && item.status === "pending")) {
  throw new Error("Direct Learn was not held for approval: " + directPending.text);
}
const directApproval = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id + "/review", {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken, origin: base,
  body: { proposalId: directLearn.data.proposalId, decision: "approve" },
});
if (!directApproval.response.ok) throw new Error("Direct Learn approval failed: " + directApproval.text);
const directApproved = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id, { cookie: nonAdminCookie });
if (!directApproved.response.ok || !directApproved.data.memories.some((item) => item.key === "direct-rule")) {
  throw new Error("Approved direct Learn missing from group memory: " + directApproved.text);
}
const ownPrivate = await browser("/admin/api/learn/put", {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken, origin: base,
  body: { key: "own-private-share", kind: "workflow", scope: "project",
    scopeKey: "picker-" + suffix, content: "Private project convention" },
});
if (!ownPrivate.response.ok || !ownPrivate.data.item?.id) {
  throw new Error("unable to create personal project Learn for Shared import test");
}
const privateProposal = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id + "/proposals", {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken, origin: base,
  body: { memoryId: ownPrivate.data.item.id },
});
if (privateProposal.response.status !== 201 || privateProposal.data.status !== "pending") {
  throw new Error("private Learn copy into group failed: " + privateProposal.text);
}
const afterPrivate = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id, {
  cookie: nonAdminCookie,
});
if (afterPrivate.data.memories.some((item) => item.key === "own-private-share") ||
    !afterPrivate.data.proposals.some((item) => item.id === privateProposal.data.proposalId)) {
  throw new Error("private Learn was exposed without approval");
}
const pickerPath = "/admin/api/learn/groups/" + groupCreation.data.group.id + "/candidates";
const invitees = await browser(pickerPath, { cookie: nonAdminCookie });
if (!invitees.response.ok || !invitees.data.items.some((item) => item.id === "owner" && item.name) ||
    invitees.data.items.some((item) => item.id === user.data.user.id) ||
    !invitees.data.members?.some((item) => item.userId === user.data.user.id && item.name) ||
    invitees.data.items.some((item) =>
      !("email" in item) || (item.email !== null && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(item.email)) ||
      "login" in item || "tokenHash" in item)) {
  throw new Error("group user dropdown candidates are missing or expose private user data: " + invitees.text);
}
const anonymousInvitees = await browser(pickerPath);
if (anonymousInvitees.response.status !== 401) throw new Error("anonymous access to group candidates was allowed");
const invitation = await browser("/admin/api/learn/groups/" + groupCreation.data.group.id + "/members", {
  method: "POST", cookie: nonAdminCookie, csrf: nonAdminLogin.data.csrfToken,
  origin: base, body: { userId: "owner", role: "member" },
});
if (invitation.response.status !== 201) throw new Error("group invitation failed: " + invitation.text);
const afterInvitation = await browser(pickerPath, { cookie: nonAdminCookie });
if (!afterInvitation.response.ok || afterInvitation.data.items.some((item) => item.id === "owner")) {
  throw new Error("existing member still appeared in group user dropdown");
}
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
const outsiderPicker = await browser(pickerPath, { cookie });
if (outsiderPicker.response.status !== 403) {
  throw new Error("another account could browse a foreign group's candidate users: " + outsiderPicker.text);
}
const browserUsers = await browser("/admin/api/users", { cookie });
if (!browserUsers.response.ok) throw new Error(`browser admin API read failed: ${browserUsers.text}`);

const managedLogin = `managed-${suffix}`;
const managedPassword = `Managed-${suffix}-Password!`;
const managedCreate = await admin("/admin/users", "POST", {
  name: "Managed User",
  id: `managed-${suffix}`,
});
if (!managedCreate.response.ok || !managedCreate.data.user?.id) throw new Error(`managed user create failed: ${managedCreate.text}`);
const managedId = managedCreate.data.user.id;
const managedCreds = await admin("/admin/users/login", "POST", {
  userId: managedId,
  login: managedLogin,
  password: managedPassword,
});
if (!managedCreds.response.ok) throw new Error(`managed user credentials failed: ${managedCreds.text}`);
const managedAuth = await browser("/admin/session/login", { method: "POST", body: { login: managedLogin, password: managedPassword } });
if (!managedAuth.response.ok) throw new Error("new user could not login");
const managedCookie = (managedAuth.response.headers.get("set-cookie") || "").split(";")[0];
const softDeleted = await browser("/admin/api/users/soft-delete", {
  method: "POST", cookie, csrf, origin: base, body: { userId: managedId },
});
if (!softDeleted.response.ok || softDeleted.data.user?.enabled !== false || !softDeleted.data.user?.deletedAt) throw new Error(`soft delete failed: ${softDeleted.text}`);
const pickerAfterDelete = await browser(pickerPath, { cookie: nonAdminCookie });
if (!pickerAfterDelete.response.ok || pickerAfterDelete.data.items.some((item) => item.id === managedId)) {
  throw new Error("deleted account appeared in Shared Learn user dropdown");
}
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
