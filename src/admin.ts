import { hashToken, newToken, normalizeAgentId } from "./registry";
import { DEFAULT_QUOTA_POLICY, normalizeQuotaPolicy, type QuotaPolicy } from "./usage";
import { clearGoogleStateCookie, finishGoogleLogin, googleLoginSuccessPage, startGoogleLogin } from "./google-auth";
import { completeGoogleConnectorAuthorization } from "./oauth";
import { completeGoogleDeviceAuthorization } from "./device-auth";

type AdminEnv = {
  REGISTRY: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  AUDIT: DurableObjectNamespace;
  DASHBOARD: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
  USER_RATE_LIMIT_PER_WINDOW?: string;
  USER_RATE_WINDOW_SECONDS?: string;
  USER_DAILY_CALL_QUOTA?: string;
  AUDIT_RETENTION_DAYS?: string;
  PUBLIC_BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};

const error = (status: number, code: string, details?: unknown) =>
  Response.json({ error: code, ...(details === undefined ? {} : { details }) }, { status });

const authorized = (request: Request, token: string) =>
  request.headers.get("authorization") === `Bearer ${token}`;

const ADMIN_COOKIE = "chat_relay_admin";

function readCookie(request: Request, name: string) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function adminCookie(token: string, maxAgeSeconds: number) {
  return ADMIN_COOKIE + "=" + encodeURIComponent(token) + "; Path=/; Max-Age=" + maxAgeSeconds + "; HttpOnly; Secure; SameSite=Lax";
}

function clearLegacyAdminCookie() {
  return ADMIN_COOKIE + "=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

async function browserSession(request: Request, env: AdminEnv, requireCsrf: boolean) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return { ok: false as const, response: error(401, "unauthorized") };
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (requireCsrf && origin && origin !== url.origin) {
    return { ok: false as const, response: error(403, "csrf_invalid") };
  }
  const csrfToken = requireCsrf ? request.headers.get("x-csrf-token") || "" : "";
  if (requireCsrf && !csrfToken) return { ok: false as const, response: error(403, "csrf_required") };
  const tokenHash = await hashToken(token);
  const response = await registryCall(env, "/admin-session/auth", {
    tokenHash,
    ...(requireCsrf ? { csrfHash: await hashToken(csrfToken) } : {}),
  });
  const data = await response.json<any>();
  if (!response.ok) return { ok: false as const, response: Response.json(data, { status: response.status }) };
  return { ok: true as const, data, tokenHash, token };
}

export async function browserSessionUser(request: Request, env: AdminEnv) {
  const auth = await browserSession(request, env, false);
  if (!auth.ok || !auth.data?.user?.id) return null;
  return auth.data.user as { id: string; authProvider?: string; enabled?: boolean; admin?: boolean };
}

function registryStub(env: AdminEnv) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global"));
}

async function registryCall(env: AdminEnv, path: string, body?: unknown) {
  return registryStub(env).fetch(new Request(`https://registry.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function usageStub(env: AdminEnv) {
  return env.USAGE.get(env.USAGE.idFromName("global"));
}

function auditStub(env: AdminEnv) {
  return env.AUDIT.get(env.AUDIT.idFromName("global"));
}

function dashboardStub(env: AdminEnv) {
  return env.DASHBOARD.get(env.DASHBOARD.idFromName("global"));
}

async function publishDashboard(env: AdminEnv, topics: string[], userId?: string) {
  try {
    await dashboardStub(env).fetch(new Request("https://dashboard.internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topics, ...(userId ? { userId } : {}) }),
    }));
  } catch {}
}

type SafeAuditActor = {
  kind: "operator" | "admin-user" | "user" | "anonymous" | "system";
  userId?: string;
};

async function recordAudit(
  env: AdminEnv,
  actor: SafeAuditActor,
  action: string,
  target: { type: string; id?: string },
  result: "success" | "failure",
  metadata?: Record<string, unknown>,
) {
  try {
    const response = await auditStub(env).fetch(new Request("https://audit.internal/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, action, target, result, metadata }),
    }));
    return response.ok;
  } catch {
    return false;
  }
}

function adminActor(operatorAuthorized: boolean, browserAuth: any): SafeAuditActor {
  if (browserAuth?.ok && browserAuth.data?.user?.id) {
    return { kind: "admin-user", userId: String(browserAuth.data.user.id) };
  }
  if (operatorAuthorized) return { kind: "operator" };
  return { kind: "anonymous" };
}

async function auditedRegistryMutation(
  env: AdminEnv,
  actor: SafeAuditActor,
  action: string,
  target: { type: string; id?: string },
  registryPath: string,
  body: unknown,
  metadata?: Record<string, unknown>,
) {
  const response = await registryCall(env, registryPath, body);
  await recordAudit(env, actor, action, target, response.ok ? "success" : "failure", {
    status: response.status,
    ...metadata,
  });
  if (response.ok) await publishDashboard(env, ["overview", "users", "agents"]);
  return response;
}

async function internalJson(responsePromise: Promise<Response>) {
  try {
    const response = await responsePromise;
    const data = await response.json<any>().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (cause) {
    return { ok: false, status: 503, data: { error: cause instanceof Error ? cause.message : "internal_unavailable" } };
  }
}

function boundedRetention(value: unknown, fallback: number, max = 3650) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(numeric)));
}

function quotaDefaults(env: AdminEnv): QuotaPolicy {
  return normalizeQuotaPolicy({
    rateLimit: Number(env.USER_RATE_LIMIT_PER_WINDOW),
    rateWindowSeconds: Number(env.USER_RATE_WINDOW_SECONDS),
    dailyCallQuota: Number(env.USER_DAILY_CALL_QUOTA),
  }, DEFAULT_QUOTA_POLICY);
}

async function quotaPolicy(env: AdminEnv) {
  const response = await usageStub(env).fetch("https://usage.internal/quota/policy");
  const data = await response.json<any>();
  const override = data.policy ? normalizeQuotaPolicy(data.policy, quotaDefaults(env)) : null;
  return {
    policy: override ?? quotaDefaults(env),
    source: override ? "admin" : "environment",
  };
}

function generatedId(name: string, fallback: string) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
  return `${slug.slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`;
}

function page<T>(items: T[], url: URL) {
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));
  return { items: items.slice(offset, offset + limit), offset, limit, total: items.length, hasMore: offset + limit < items.length };
}

async function registryState(env: AdminEnv) {
  const response = await registryCall(env, "/state");
  const data = await response.json<any>();
  if (!response.ok) throw new Error("registry_state_failed");
  return data;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
type DashboardRange = "today" | "7d" | "30d";
function dashboardPeriod(range: DashboardRange = "today", nowMs = Date.now()) {
  const local = new Date(nowMs + BANGKOK_OFFSET_MS);
  const todayStartMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BANGKOK_OFFSET_MS;
  const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
  const startMs = todayStartMs - (days - 1) * 24 * 60 * 60 * 1000;
  return {
    range,
    label: range === "30d" ? "30 days" : range === "7d" ? "7 days" : "Today",
    timezone: "Asia/Bangkok",
    timezoneLabel: "BKK · UTC+7",
    day: new Date(todayStartMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10),
    from: new Date(startMs).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
}

async function usageWindow(
  env: AdminEnv,
  period: ReturnType<typeof dashboardPeriod>,
  userId?: string,
  includeDetails = false,
) {
  const query = new URLSearchParams({ from: period.from, to: period.to });
  if (userId) query.set("userId", userId);
  if (includeDetails) query.set("details", "1");
  const response = await usageStub(env).fetch("https://usage.internal/window?" + query);
  if (!response.ok) throw new Error("usage_window_failed");
  return response.json<any>();
}

async function onlineAgents(env: AdminEnv, agents: any[], users: any[] = [], grants: any[] = []) {
  const userById = new Map(users.map((user) => [user.id, user]));
  const grantsByAgent = new Map<string, any[]>();  for (const grant of grants) {
    const current = grantsByAgent.get(grant.agentId) ?? [];
    current.push({ userId: grant.userId, scopes: grant.scopes });
    grantsByAgent.set(grant.agentId, current);
  }

  return Promise.all(agents.map(async (agent) => {
    const status = agent.enabled && !agent.retiredAt
      ? await env.RELAY.get(env.RELAY.idFromName(agent.id))
        .fetch("https://relay.internal/status")
        .then((response) => response.json<any>())
        .catch(() => ({ online: false }))
      : { online: false };
    const owner = agent.ownerUserId ? userById.get(agent.ownerUserId) : null;
    return {
      ...agent,
      retiredAt: agent.retiredAt ?? null,
      online: Boolean(status.online),
      lifecycle: agent.retiredAt ? "retired" : agent.enabled ? "active" : "disabled",
      runtime: {
        protocolVersion: status.protocolVersion ?? null,
        connectionGeneration: status.connectionGeneration ?? null,
        agentVersion: status.agentVersion ?? null,
        platform: status.platform ?? null,
        arch: status.arch ?? null,
        capabilities: Array.isArray(status.capabilities) ? status.capabilities : [],
        health: status.health ?? null,
        diagnostics: status.diagnostics ?? null,
        lifecycle: status.lifecycle ?? null,
      },
      reauthorizationRequired: Boolean(agent.retiredAt),
      owner: owner ? { id: owner.id, name: owner.name, login: owner.login ?? null } : null,
      grants: grantsByAgent.get(agent.id) ?? [],
    };
  }));
}
export async function handleAdmin(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const body = request.method === "GET" ? null : await request.json<any>().catch(() => null);
  const operatorAuthorized = Boolean(env.ADMIN_TOKEN && authorized(request, env.ADMIN_TOKEN));

  if (path === "/admin/google/start" && request.method === "GET") {
    return startGoogleLogin(request, env);
  }

  if (path === "/admin/google/callback" && request.method === "GET") {
    const google = await finishGoogleLogin(request, env);
    if (!google.ok) {
      const providerErrorRaw = String(url.searchParams.get("error") || "").trim().toLowerCase();
      const providerError = /^[a-z][a-z0-9_.:-]{0,79}$/.test(providerErrorRaw)
        ? providerErrorRaw
        : "none";
      await recordAudit(
        env,
        { kind: "anonymous" },
        "oauth.google.callback.failure",
        { type: "connector_auth" },
        "failure",
        {
          status: google.response.status,
          providerError,
          hasReturnedState: Boolean(url.searchParams.get("state")),
        },
      );
      return google.response;
    }
    const identityResponse = await registryCall(env, "/google/upsert", {
      googleSub: google.identity.sub,
      email: google.identity.email,
      name: google.identity.name,
    });
    const identityData = await identityResponse.json<any>().catch(() => ({}));
    if (!identityResponse.ok || !identityData.user?.id) {
      await recordAudit(env, { kind: "anonymous" }, "admin.google.login", { type: "google_identity" }, "failure", { status: identityResponse.status });
      const response = error(identityResponse.status, identityData.error || "google_account_link_failed");
      response.headers.append("set-cookie", clearGoogleStateCookie());
      return response;
    }

    const deviceResponse = await completeGoogleDeviceAuthorization(
      google.continuation,
      String(identityData.user.id),
      (registryPath, registryBody) => registryCall(env, registryPath, registryBody),
    );
    if (deviceResponse) {
      await recordAudit(env, { kind: "user", userId: String(identityData.user.id) }, "device.google.authorize",
        { type: "user", id: String(identityData.user.id) }, deviceResponse.ok ? "success" : "failure",
        { status: deviceResponse.status });
      return deviceResponse;
    }

    const sessionResponse = await registryCall(env, "/admin-session/create-for-user", { userId: identityData.user.id });
    const sessionData = await sessionResponse.json<any>().catch(() => ({}));

    const connectorResponse = await completeGoogleConnectorAuthorization(
      google.continuation,
      String(identityData.user.id),
      (registryPath, registryBody) => registryCall(env, registryPath, registryBody),
    );
    if (connectorResponse) {
      await recordAudit(
        env,
        { kind: "user", userId: String(identityData.user.id) },
        "oauth.google.login",
        { type: "user", id: String(identityData.user.id) },
        connectorResponse.status === 302 ? "success" : "failure",
        { status: connectorResponse.status },
      );
      const headers = new Headers(connectorResponse.headers);
      headers.append("set-cookie", clearGoogleStateCookie());
      if (sessionResponse.ok && sessionData.token && sessionData.expiresAt) {
        const maxAge = Math.max(1, Math.floor((Date.parse(sessionData.expiresAt) - Date.now()) / 1000));
        headers.append("set-cookie", adminCookie(sessionData.token, maxAge));
      }
      headers.append("set-cookie", clearLegacyAdminCookie());
      return new Response(connectorResponse.body, {
        status: connectorResponse.status,
        statusText: connectorResponse.statusText,
        headers,
      });
    }

    await recordAudit(
      env,
      sessionResponse.ok ? { kind: "admin-user", userId: String(identityData.user.id) } : { kind: "anonymous" },
      "admin.google.login",
      { type: "admin_session", id: String(identityData.user.id) },
      sessionResponse.ok ? "success" : "failure",
      { status: sessionResponse.status },
    );
    if (!sessionResponse.ok) return error(sessionResponse.status, sessionData.error || "google_session_failed");
    const maxAge = Math.max(1, Math.floor((Date.parse(sessionData.expiresAt) - Date.now()) / 1000));
    const success = googleLoginSuccessPage(sessionData.csrfToken, adminCookie(sessionData.token, maxAge));
    const headers = new Headers(success.headers);
    headers.append("set-cookie", clearLegacyAdminCookie());
    return new Response(success.body, { status: success.status, statusText: success.statusText, headers });
  }

  if (path === "/admin/ws" && request.method === "GET") {
    const wsOrigin = request.headers.get("origin");
    if (wsOrigin && wsOrigin !== url.origin) return error(403, "origin_invalid");
    const auth = await browserSession(request, env, false);
    if (!auth.ok) return auth.response;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return error(426, "websocket_required");
    }
    const headers = new Headers(request.headers);
    headers.set("x-dashboard-user-id", String(auth.data.user?.id || ""));
    headers.set("x-dashboard-admin", auth.data.user?.admin === true ? "1" : "0");
    return dashboardStub(env).fetch(new Request("https://dashboard.internal/connect", { method: "GET", headers }));
  }

  if (path === "/admin/session/login" && request.method === "POST") {
    const response = await registryCall(env, "/admin-session/create", {
      login: String(body?.login ?? ""),
      password: String(body?.password ?? ""),
    });
    const data = await response.json<any>();
    await recordAudit(
      env,
      response.ok && data.user?.id ? { kind: "admin-user", userId: String(data.user.id) } : { kind: "anonymous" },
      "admin.session.login",
      { type: "admin_session", ...(data.user?.id ? { id: String(data.user.id) } : {}) },
      response.ok ? "success" : "failure",
      { status: response.status },
    );
    if (!response.ok) return Response.json(data, { status: response.status });
    const maxAge = Math.max(1, Math.floor((Date.parse(data.expiresAt) - Date.now()) / 1000));
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", adminCookie(data.token, maxAge));
    headers.append("set-cookie", clearLegacyAdminCookie());
    return Response.json(
      { ok: true, user: data.user, csrfToken: data.csrfToken, expiresAt: data.expiresAt },
      { headers },
    );
  }

  const browserProtected = path.startsWith("/admin/api/") || path === "/admin/session" || path === "/admin/session/logout";
  let browserAuth: Awaited<ReturnType<typeof browserSession>> | null = null;
  if (browserProtected && !operatorAuthorized) {
    browserAuth = await browserSession(request, env, request.method !== "GET");
    if (!browserAuth.ok) return browserAuth.response;
  } else if (!browserProtected && !operatorAuthorized) {
    return error(401, "unauthorized");
  }

  const actor = adminActor(operatorAuthorized, browserAuth);
  const sessionUser = browserAuth?.ok ? browserAuth.data.user : null;
  const adminAuthorized = operatorAuthorized || sessionUser?.admin === true;
  const selfUserId = sessionUser?.id ? String(sessionUser.id) : "";
  const selfService = request.method === "GET" && ["/admin/api/overview", "/admin/api/summary"].includes(path);
  if (!adminAuthorized && path.startsWith("/admin/api/") && !selfService) {
    return error(403, "admin_required");
  }

  if (path === "/admin/session" && request.method === "GET") {
    const headers = new Headers({ "cache-control": "no-store" });
    if (browserAuth?.ok && browserAuth.token && browserAuth.tokenHash && browserAuth.data.expiresAt && url.searchParams.get("refreshCsrf") === "1") {
      const refreshed = await registryCall(env, "/admin-session/refresh-csrf", { tokenHash: browserAuth.tokenHash });
      const refreshedData = await refreshed.json<any>();
      if (!refreshed.ok) return Response.json(refreshedData, { status: refreshed.status, headers });
      const expiresAt = refreshedData.expiresAt || browserAuth.data.expiresAt;
      const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
      headers.append("set-cookie", adminCookie(browserAuth.token, maxAge));
      headers.append("set-cookie", clearLegacyAdminCookie());
      return Response.json(
        { ok: true, user: refreshedData.user || browserAuth.data.user, csrfToken: refreshedData.csrfToken, expiresAt },
        { headers },
      );
    }
    return Response.json(
      { ok: true, user: browserAuth?.ok ? browserAuth.data.user : { operator: true }, expiresAt: browserAuth?.ok ? browserAuth.data.expiresAt : null },
      { headers },
    );
  }

  if (path === "/admin/session/logout" && request.method === "POST") {
    if (browserAuth?.ok) await registryCall(env, "/admin-session/revoke", { tokenHash: browserAuth.tokenHash });
    await recordAudit(env, actor, "admin.session.logout", { type: "admin_session", id: actor.userId }, "success");
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", adminCookie("", 0));
    headers.append("set-cookie", clearLegacyAdminCookie());
    return Response.json({ ok: true }, { headers });
  }

  if (path === "/admin/api/audit" && request.method === "GET") {
    const query = new URLSearchParams();
    for (const key of ["limit", "action", "actorUserId", "targetId"]) {
      const value = url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    const response = await auditStub(env).fetch("https://audit.internal/query" + (query.size ? "?" + query : ""));
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/api/operations" && request.method === "GET") {
    const [registry, audit] = await Promise.all([
      internalJson(registryStub(env).fetch("https://registry.internal/ops/status")),
      internalJson(auditStub(env).fetch("https://audit.internal/ops/status")),
    ]);
    return Response.json({
      ok: registry.ok && audit.ok,
      components: { registry, audit },
      retention: { auditDays: boundedRetention(env.AUDIT_RETENTION_DAYS, 180) },
    });
  }

  if (path === "/admin/api/operations/cleanup" && request.method === "POST") {
    const auditDays = boundedRetention(body?.auditRetentionDays, boundedRetention(env.AUDIT_RETENTION_DAYS, 180));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(body?.limit) || 250)));
    const [registry, audit] = await Promise.all([
      internalJson(registryStub(env).fetch(new Request("https://registry.internal/ops/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit }),
      }))),
      internalJson(auditStub(env).fetch(new Request("https://audit.internal/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionDays: auditDays, limit }),
      }))),
    ]);
    const ok = registry.ok && audit.ok;
    await recordAudit(env, actor, "operations.cleanup", { type: "operations", id: "retention" }, ok ? "success" : "failure", {
      registryDeleted: Number(registry.data?.deletedRecords || 0),
      auditDeleted: Number(audit.data?.deleted || 0),
      status: ok ? 200 : 502,
    });
    return Response.json({ ok, registry, audit }, { status: ok ? 200 : 502 });
  }

  if (path === "/admin/api/limits" && request.method === "GET") {
    return Response.json(await quotaPolicy(env));
  }

  if (path === "/admin/api/limits" && request.method === "POST") {
    if (body?.resetToDefaults === true) {
      const response = await usageStub(env).fetch(new Request("https://usage.internal/quota/policy", { method: "DELETE" }));
      if (!response.ok) return error(502, "quota_policy_update_failed");
      const current = await quotaPolicy(env);
      await recordAudit(env, actor, "policy.quota.reset", { type: "quota_policy", id: "global" }, "success");
      return Response.json({ ok: true, ...current });
    }
    const rateLimit = Number(body?.rateLimit);
    const rateWindowSeconds = Number(body?.rateWindowSeconds);
    const dailyCallQuota = Number(body?.dailyCallQuota);
    if (!Number.isFinite(rateLimit) || !Number.isFinite(rateWindowSeconds) || !Number.isFinite(dailyCallQuota)) {
      return error(400, "invalid_quota_policy");
    }
    const policy = normalizeQuotaPolicy({ rateLimit, rateWindowSeconds, dailyCallQuota }, quotaDefaults(env));
    const response = await usageStub(env).fetch(new Request("https://usage.internal/quota/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    }));
    const data = await response.json<any>();
    await recordAudit(env, actor, "policy.quota.set", { type: "quota_policy", id: "global" }, response.ok ? "success" : "failure", {      rateLimit: policy.rateLimit,
      rateWindowSeconds: policy.rateWindowSeconds,
      dailyCallQuota: policy.dailyCallQuota,
      status: response.status,
    });
    return Response.json(response.ok ? { ...data, source: "admin" } : data, { status: response.status });
  }

  if (path === "/admin/api/summary" && request.method === "GET") {
    const requestedRange = url.searchParams.get("range");
    const range: DashboardRange = requestedRange === "7d" || requestedRange === "30d" ? requestedRange : "today";
    const period = dashboardPeriod(range);
    const usage = await usageWindow(env, period, adminAuthorized ? undefined : selfUserId, true);

    if (!adminAuthorized) {
      const state = await registryState(env);
      const allowedIds = new Set(
        (state.grants ?? [])
          .filter((grant: any) => grant.userId === selfUserId)
          .map((grant: any) => grant.agentId),
      );
      for (const agent of state.agents ?? []) {
        if (agent.ownerUserId === selfUserId) allowedIds.add(agent.id);
      }
      const allowedAgents = (state.agents ?? []).filter((agent: any) => allowedIds.has(agent.id));
      const statuses = await onlineAgents(env, allowedAgents, state.users ?? [], state.grants ?? []);
      const work = statuses.reduce((sum: number, agent: any) => {
        const snapshot = agent.runtime?.lifecycle?.work || {};
        return sum + Number(snapshot.activeSessions || 0) + Number(snapshot.activeBatchJobs || 0) + Number(snapshot.activeTerminalExecs || 0);
      }, 0);
      return Response.json({
        role: "user",
        user: sessionUser,
        period,
        usage: usage.metric ?? null,
        buckets: usage.buckets ?? [],
        topTools: usage.topTools ?? [],
        accountUsage: usage.users ?? [],
        bounded: usage.bounded === true,
        coverage: usage.coverage,
        sampleSize: Number(usage.sampleSize || 0),
        detailSampleSize: Number(usage.detailSampleSize || 0),
        activeTerminals: work,
      });
    }

    const state = await registryState(env);
    const statuses = await onlineAgents(env, state.agents ?? [], state.users ?? [], state.grants ?? []);
    const activeUsers = new Set(
      (state.users ?? []).filter((user: any) => user.enabled && !user.deletedAt).map((user: any) => user.id),
    );
    const usageByUserId = new Map((usage.users ?? []).map((entry: any) => [entry.userId, entry]));
    const accountUsage = (state.users ?? [])
      .filter((user: any) => !user.deletedAt)
      .map((user: any) => {
        const summary: any = usageByUserId.get(user.id);
        return {
          userId: user.id,
          calls: Number(summary?.calls || 0),
          errors: 0,
          operationalErrors: 0,
          name: user.name || user.login || user.id,
          login: user.login || "",
          enabled: user.enabled === true,
        };
      })
      .sort((a: any, b: any) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)));

    const activeTerminals = statuses.reduce((sum: number, agent: any) => {
      const work = agent.runtime?.lifecycle?.work || {};
      return sum + Number(work.activeSessions || 0) + Number(work.activeBatchJobs || 0) + Number(work.activeTerminalExecs || 0);
    }, 0);
    return Response.json({
      role: "admin",
      period,
      users: { total: (state.users ?? []).length, enabled: activeUsers.size },
      agents: { total: statuses.length, online: statuses.filter((agent: any) => agent.online).length },
      grants: { total: (state.grants ?? []).length },
      usage: usage.metric ?? null,
      buckets: usage.buckets ?? [],
      topTools: usage.topTools ?? [],
      accountUsage,
      bounded: usage.bounded === true,
      coverage: usage.coverage,
      sampleSize: Number(usage.sampleSize || 0),
      detailSampleSize: Number(usage.detailSampleSize || 0),
      activeTerminals,
      activeUsers: activeUsers.size,
    });
  }

  if (path === "/admin/api/overview" && request.method === "GET") {
    const requestedRange = url.searchParams.get("range");
    const range: DashboardRange = requestedRange === "7d" || requestedRange === "30d" ? requestedRange : "today";
    const period = dashboardPeriod(range);
    const usage = await usageWindow(env, period, adminAuthorized ? undefined : selfUserId);

    if (!adminAuthorized) {
      const agentUsage = (usage.agents ?? [])
        .map((entry: any) => ({
          agentId: entry.agentId,
          name: entry.agentId,
          calls: Number(entry.calls || 0),
        }))
        .sort((a: any, b: any) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)));
      return Response.json({
        role: "user",
        user: sessionUser,
        period,
        accounts: [{
          userId: selfUserId,
          name: sessionUser?.name || sessionUser?.login || selfUserId,
          login: sessionUser?.login || "",
          calls: Number(usage.metric?.calls || 0),
          agents: agentUsage,
        }],
      });
    }

    const state = await registryState(env);
    const users = (state.users ?? []).filter((user: any) => !user.deletedAt);
    const agents = state.agents ?? [];
    const grants = state.grants ?? [];
    const agentById = new Map(agents.map((agent: any) => [agent.id, agent]));
    const activeAgentIds = new Set(
      (usage.agents ?? [])
        .filter((entry: any) => Number(entry.calls || 0) > 0 && entry.agentId && entry.agentId !== "__relay__")
        .map((entry: any) => String(entry.agentId)),
    );
    const statusRows = activeAgentIds.size
      ? await onlineAgents(env, agents.filter((agent: any) => activeAgentIds.has(agent.id)), users, grants)
      : [];
    const onlineByAgentId = new Map(statusRows.map((agent: any) => [agent.id, agent.online === true]));
    const usageByUserAgent = new Map(
      (usage.agents ?? []).map((entry: any) => [JSON.stringify([entry.userId, entry.agentId]), Number(entry.calls || 0)]),
    );
    const userTotals = new Map((usage.users ?? []).map((entry: any) => [entry.userId, Number(entry.calls || 0)]));
    const ownedAgentIdsByUser = new Map<string, Set<string>>();
    const grantedAgentIdsByUser = new Map<string, Set<string>>();
    const usageAgentIdsByUser = new Map<string, Set<string>>();
    const addAgentId = (map: Map<string, Set<string>>, userId: string, agentId: string) => {
      const ids = map.get(userId) || new Set<string>();
      ids.add(agentId);
      map.set(userId, ids);
    };
    for (const agent of agents) if (agent.ownerUserId && !agent.retiredAt) addAgentId(ownedAgentIdsByUser, agent.ownerUserId, agent.id);
    for (const grant of grants) addAgentId(grantedAgentIdsByUser, grant.userId, grant.agentId);
    for (const entry of usage.agents ?? []) addAgentId(usageAgentIdsByUser, entry.userId, entry.agentId);

    const accounts = users.map((user: any) => {
      const ids = new Set<string>([
        ...(ownedAgentIdsByUser.get(user.id) || []),
        ...(grantedAgentIdsByUser.get(user.id) || []),
        ...(usageAgentIdsByUser.get(user.id) || []),
      ]);

      const accountAgents = [...ids].map((agentId) => {
        const agent: any = agentById.get(agentId);
        return {
          agentId,
          name: agent?.name || agentId,
          calls: Number(usageByUserAgent.get(JSON.stringify([user.id, agentId])) || 0),
          online: onlineByAgentId.get(agentId) === true,
        };
      }).sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)));

      return {
        userId: user.id,
        name: user.name || user.login || user.id,
        login: user.login || "",
        calls: Number(userTotals.get(user.id) || 0),
        agents: accountAgents,
      };
    }).sort((a: any, b: any) => b.calls - a.calls || String(a.name).localeCompare(String(b.name)));

    return Response.json({ role: "admin", period, accounts });
  }

  if (path.startsWith("/admin/api/users/") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/admin/api/users/".length));
    const state = await registryState(env);
    const user = (state.users ?? []).find((item: any) => item.id === id);
    if (!user) return error(404, "user_not_found");
    return Response.json({ user, grants: (state.grants ?? []).filter((grant: any) => grant.userId === id) });
  }

  if (path === "/admin/api/users" && request.method === "GET") {
    const state = await registryState(env);
    const q = String(url.searchParams.get("q") || "").toLowerCase();
    const enabled = url.searchParams.get("enabled");
    const deleted = url.searchParams.get("deleted");
    const filteredUsers = (state.users ?? []).filter((user: any) =>
      (!q || String(user.id + " " + user.name + " " + (user.login ?? "")).toLowerCase().includes(q)) &&
      (enabled === null || String(user.enabled) === enabled) &&
      (deleted === null || String(Boolean(user.deletedAt)) === deleted)
    );
    const userPage = page(filteredUsers, url);
    const pageUserIds = new Set(userPage.items.map((user: any) => user.id));
    const relevantAgentIds = new Set<string>();
    for (const grant of state.grants ?? []) if (pageUserIds.has(grant.userId)) relevantAgentIds.add(grant.agentId);
    for (const agent of state.agents ?? []) if (agent.ownerUserId && pageUserIds.has(agent.ownerUserId)) relevantAgentIds.add(agent.id);

    const relevantAgents = (state.agents ?? []).filter((agent: any) => relevantAgentIds.has(agent.id));
    const agents = await onlineAgents(env, relevantAgents, state.users ?? [], state.grants ?? []);
    const agentById = new Map(agents.map((agent: any) => [agent.id, agent]));

    const items = userPage.items.map((user: any) => {
      const ids = new Set<string>();
      for (const grant of state.grants ?? []) if (grant.userId === user.id) ids.add(grant.agentId);
      for (const agent of state.agents ?? []) if (agent.ownerUserId === user.id) ids.add(agent.id);
      const assignedAgents = [...ids]
        .map((id) => agentById.get(id))
        .filter((agent: any) => agent && agent.enabled && !agent.retiredAt)
        .map((agent: any) => ({
          id: agent.id,
          name: agent.name || agent.id,
          online: agent.online === true,
        }))
        .sort((a: any, b: any) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      return {
        ...user,
        agentCount: assignedAgents.length,
        onlineAgentCount: assignedAgents.filter((agent: any) => agent.online).length,
        assignedAgents,
      };
    });
    return Response.json({ ...userPage, items });
  }

  if (path.startsWith("/admin/api/agents/") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/admin/api/agents/".length));
    const state = await registryState(env);
    const baseAgent = (state.agents ?? []).find((item: any) => item.id === id);
    if (!baseAgent) return error(404, "agent_not_found");
    const [agent] = await onlineAgents(env, [baseAgent], state.users ?? [], state.grants ?? []);
    return Response.json({ agent, grants: (state.grants ?? []).filter((grant: any) => grant.agentId === id) });
  }

  if (path === "/admin/api/agents" && request.method === "GET") {
    const state = await registryState(env);
    const q = String(url.searchParams.get("q") || "").toLowerCase();
    const online = url.searchParams.get("online");
    const candidates = (state.agents ?? []).filter((agent: any) =>
      !q || String(agent.id + " " + agent.name).toLowerCase().includes(q)
    );

    if (online === null) {
      const basePage = page(candidates, url);
      const items = await onlineAgents(env, basePage.items, state.users ?? [], state.grants ?? []);
      return Response.json({ ...basePage, items });
    }

    const enriched = await onlineAgents(env, candidates, state.users ?? [], state.grants ?? []);
    return Response.json(page(enriched.filter((agent: any) => String(agent.online) === online), url));
  }

  if (path === "/admin/api/grants" && request.method === "GET") {
    const state = await registryState(env);
    const userId = url.searchParams.get("userId");
    const agentId = url.searchParams.get("agentId");
    const items = (state.grants ?? []).filter((grant: any) =>
      (!userId || grant.userId === userId) && (!agentId || grant.agentId === agentId)
    );
    return Response.json(page(items, url));
  }

  if (path === "/admin/api/sessions" && request.method === "GET") {
    const response = await registryCall(env, "/sessions/list", { userId: url.searchParams.get("userId") || undefined });
    const data = await response.json<any>();
    return Response.json(page(data.sessions ?? [], url), { status: response.status });
  }

  if (path === "/admin/api/users/soft-delete" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    if (selfUserId && userId === selfUserId) return error(409, "cannot_delete_current_user");
    return auditedRegistryMutation(env, actor, "user.soft-delete", { type: "user", id: userId }, "/users/soft-delete", { userId });
  }

  if (path === "/admin/api/users/restore" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return auditedRegistryMutation(env, actor, "user.restore", { type: "user", id: userId }, "/users/restore", { userId });
  }

  if (path === "/admin/api/agents/rename" && request.method === "POST") {
    const agentId = String(body?.agentId ?? "");
    const name = String(body?.name ?? "").trim();
    if (!agentId) return error(400, "agent_id_required");
    if (!name || name.length > 120) return error(400, "invalid_agent_name");
    return auditedRegistryMutation(
      env,
      actor,
      "agent.rename",
      { type: "agent", id: agentId },
      "/agents/rename",
      {
        agentId,
        name,
        ...(body?.expectedOwnerUserId ? { expectedOwnerUserId: String(body.expectedOwnerUserId) } : {}),
      },
      { nameLength: name.length },
    );
  }

  if (path === "/admin/api/agents/retire" && request.method === "POST") {    const agentId = String(body?.agentId ?? "");
    if (!agentId) return error(400, "agent_id_required");
    const response = await registryCall(env, "/agents/retire", {
      agentId,
      ...(body?.expectedOwnerUserId ? { expectedOwnerUserId: String(body.expectedOwnerUserId) } : {}),
    });
    const data = await response.json<any>().catch(() => ({}));
    await recordAudit(
      env,
      actor,
      "agent.retire",
      { type: "agent", id: agentId },
      response.ok ? "success" : "failure",
      { status: response.status },
    );
    if (response.ok) {
      await publishDashboard(env, ["overview", "users", "agents", "calls"]);
      const disconnectResponse = await env.RELAY.get(env.RELAY.idFromName(agentId))
        .fetch("https://relay.internal/disconnect")
        .catch(() => null);
      if (disconnectResponse) {
        const disconnect = await disconnectResponse.json<any>().catch(() => null);
        if (disconnect) data.disconnect = disconnect;
      }
    }
    return Response.json(data, { status: response.status });
  }
  if (path === "/admin/api/users/admin" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return auditedRegistryMutation(env, actor, "user.admin.set", { type: "user", id: userId }, "/users/set-admin", {
      userId, admin: body?.admin === true,
    }, { admin: body?.admin === true });
  }

  if (path === "/admin/api/admin-sessions/revoke" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return auditedRegistryMutation(env, actor, "admin.sessions.revoke", { type: "user", id: userId }, "/admin-session/revoke-user", { userId });
  }

  if (path === "/admin/api/sessions/revoke" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return auditedRegistryMutation(env, actor, "user.sessions.revoke", { type: "user", id: userId }, "/sessions/revoke-user", { userId });
  }

  if (path === "/admin/bootstrap" && request.method === "POST") {
    if (!env.CALLER_TOKEN || !env.AGENT_TOKEN) return error(503, "legacy_tokens_missing");
    return auditedRegistryMutation(env, actor, "registry.bootstrap", { type: "registry", id: "global" }, "/bootstrap", {
      userTokenHash: await hashToken(env.CALLER_TOKEN),
      agentTokenHash: await hashToken(env.AGENT_TOKEN),
      userName: body?.userName || "Owner",
      agentId: body?.agentId || "default",
      agentName: body?.agentName || "Primary PC",
    });
  }

  if (path === "/admin/users" && request.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (!name) return error(400, "name_required");
    const id = String(body?.id || generatedId(name, "user"));
    const token = newToken("usr");
    const response = await registryCall(env, "/users/create", { id, name, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    await recordAudit(env, actor, "user.create", { type: "user", id }, response.ok ? "success" : "failure", { status: response.status });
    if (response.ok) await publishDashboard(env, ["overview", "users"]);
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/agents" && request.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (!name) return error(400, "name_required");
    let id: string;
    try { id = body?.id ? normalizeAgentId(String(body.id)) : generatedId(name, "agent"); }
    catch { return error(400, "invalid_agent_id"); }
    const token = newToken("agt");
    const response = await registryCall(env, "/agents/create", {
      id,
      name,
      tokenHash: await hashToken(token),
      ...(body?.ownerUserId ? { ownerUserId: String(body.ownerUserId) } : {}),
    });
    const data = await response.json<any>();
    await recordAudit(env, actor, "agent.create", { type: "agent", id }, response.ok ? "success" : "failure", { status: response.status });
    if (response.ok) await publishDashboard(env, ["overview", "users", "agents"]);
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/grants" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const agentId = String(body?.agentId ?? "");
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    return auditedRegistryMutation(env, actor, "grant.upsert", { type: "grant", id: userId + ":" + agentId }, "/grants/upsert", {
      userId, agentId, scopes,
    }, { scopeCount: scopes.length });
  }
  if (path === "/admin/grants/delete" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const agentId = String(body?.agentId ?? "");
    return auditedRegistryMutation(env, actor, "grant.delete", { type: "grant", id: userId + ":" + agentId }, "/grants/delete", { userId, agentId });
  }
  if (path === "/admin/users/login" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const login = String(body?.login ?? "");
    const password = String(body?.password ?? "");
    if (!userId || !login || !password) return error(400, "credentials_required");
    return auditedRegistryMutation(env, actor, "user.credentials.set", { type: "user", id: userId }, "/users/set-login", { userId, login, password });
  }
  if (path === "/admin/users/enabled" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const enabled = Boolean(body?.enabled);
    return auditedRegistryMutation(env, actor, enabled ? "user.enable" : "user.disable", { type: "user", id: userId }, "/users/set-enabled", { userId, enabled }, { enabled });
  }
  if (path === "/admin/agents/enabled" && request.method === "POST") {
    const agentId = String(body?.agentId ?? "");
    const enabled = Boolean(body?.enabled);
    return auditedRegistryMutation(env, actor, enabled ? "agent.enable" : "agent.disable", { type: "agent", id: agentId }, "/agents/set-enabled", { agentId, enabled }, { enabled });
  }
  if (path === "/admin/users/rotate" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    const token = newToken("usr");
    const response = await registryCall(env, "/users/rotate", { userId, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    await recordAudit(env, actor, "user.token.rotate", { type: "user", id: userId }, response.ok ? "success" : "failure", { status: response.status });
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }
  if (path === "/admin/agents/rotate" && request.method === "POST") {
    const agentId = String(body?.agentId ?? "");
    if (!agentId) return error(400, "agent_id_required");
    const token = newToken("agt");
    const response = await registryCall(env, "/agents/rotate", { agentId, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    await recordAudit(env, actor, "agent.token.rotate", { type: "agent", id: agentId }, response.ok ? "success" : "failure", { status: response.status });
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }
  if (path === "/admin/state" && request.method === "GET") return registryCall(env, "/state");
  return error(404, "not_found");
}
