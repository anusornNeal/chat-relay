import { hashToken, newToken, normalizeAgentId } from "./registry";
import { DEFAULT_QUOTA_POLICY, normalizeQuotaPolicy, type QuotaPolicy } from "./usage";

type AdminEnv = {
  REGISTRY: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  AUDIT: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
  USER_RATE_LIMIT_PER_WINDOW?: string;
  USER_RATE_WINDOW_SECONDS?: string;
  USER_DAILY_CALL_QUOTA?: string;
  USAGE_RAW_RETENTION_DAYS?: string;
  AUDIT_RETENTION_DAYS?: string;
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
  return ADMIN_COOKIE + "=" + encodeURIComponent(token) + "; Path=/admin; Max-Age=" + maxAgeSeconds + "; HttpOnly; Secure; SameSite=Strict";
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
  return { ok: true as const, data, tokenHash };
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

type SafeAuditActor = {
  kind: "operator" | "admin-user" | "anonymous" | "system";
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

async function usageQuery(env: AdminEnv, source: URL) {
  const query = new URLSearchParams();
  for (const key of ["day", "from", "to", "userId", "tool", "agentId", "recentLimit"]) {
    const value = source.searchParams.get(key);
    if (value) query.set(key, value);
  }
  return usageStub(env).fetch("https://usage.internal/query" + (query.size ? "?" + query : ""));
}

async function usageSummary(env: AdminEnv, hours: number, userId?: string) {
  const query = new URLSearchParams({ hours: String(hours) });
  if (userId) query.set("userId", userId);
  const response = await usageStub(env).fetch("https://usage.internal/summary?" + query);
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
      reauthorizationRequired: Boolean(agent.retiredAt),
      owner: owner ? { id: owner.id, name: owner.name, login: owner.login ?? null } : null,
      grants: grantsByAgent.get(agent.id) ?? [],
    };
  }));
}
async function terminalActivity(env: AdminEnv, selfUserId?: string) {
  const state = await registryState(env);
  const allowed = new Set<string>();
  for (const agent of state.agents ?? []) {
    if (!agent.enabled || agent.retiredAt) continue;
    if (!selfUserId || (state.grants ?? []).some((grant: any) => grant.userId === selfUserId && grant.agentId === agent.id)) {
      allowed.add(agent.id);
    }
  }
  const snapshots = await Promise.all([...allowed].map(async (agentId) => {
    try {
      const response = await env.RELAY.get(env.RELAY.idFromName(agentId)).fetch(new Request("https://relay.internal/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { action: "terminal.observability" } }),
      }));
      const envelope = await response.json<any>().catch(() => null);
      const payload = envelope?.payload;
      if (!response.ok || !payload?.ok) return { agentId, sessions: [], batches: [] };
      const belongs = (item: any) => !selfUserId || item.userId === selfUserId;
      return {
        agentId,
        sessions: (payload.sessions ?? []).filter((item: any) => belongs(item) && item.status === "running"),
        batches: (payload.batches ?? []).filter((item: any) =>
          belongs(item) && (Number(item.counts?.running || 0) > 0 || Number(item.counts?.queued || 0) > 0)
        ),
      };
    } catch {
      return { agentId, sessions: [], batches: [] };
    }
  }));
  return snapshots;
}

export async function handleAdmin(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const body = request.method === "GET" ? null : await request.json<any>().catch(() => null);
  const operatorAuthorized = Boolean(env.ADMIN_TOKEN && authorized(request, env.ADMIN_TOKEN));

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
    return Response.json(
      { ok: true, user: data.user, csrfToken: data.csrfToken, expiresAt: data.expiresAt },
      { headers: { "set-cookie": adminCookie(data.token, maxAge), "cache-control": "no-store" } },
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
  const selfService = request.method === "GET" && [
    "/admin/api/overview",
    "/admin/api/usage",
    "/admin/api/tool-calls",
  ].includes(path);
  if (!adminAuthorized && path.startsWith("/admin/api/") && !selfService) {
    return error(403, "admin_required");
  }

  if (path === "/admin/session" && request.method === "GET") {
    return Response.json({ ok: true, user: browserAuth?.ok ? browserAuth.data.user : { operator: true }, expiresAt: browserAuth?.ok ? browserAuth.data.expiresAt : null });
  }

  if (path === "/admin/session/logout" && request.method === "POST") {
    if (browserAuth?.ok) await registryCall(env, "/admin-session/revoke", { tokenHash: browserAuth.tokenHash });
    await recordAudit(env, actor, "admin.session.logout", { type: "admin_session", id: actor.userId }, "success");
    return Response.json({ ok: true }, { headers: { "set-cookie": adminCookie("", 0), "cache-control": "no-store" } });
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
    const [registry, usage, audit] = await Promise.all([
      internalJson(registryStub(env).fetch("https://registry.internal/ops/status")),
      internalJson(usageStub(env).fetch("https://usage.internal/ops/status")),
      internalJson(auditStub(env).fetch("https://audit.internal/ops/status")),
    ]);
    return Response.json({
      ok: registry.ok && usage.ok && audit.ok,
      components: { registry, usage, audit },
      retention: {
        rawUsageDays: boundedRetention(env.USAGE_RAW_RETENTION_DAYS, 30),
        auditDays: boundedRetention(env.AUDIT_RETENTION_DAYS, 180),
      },
    });
  }

  if (path === "/admin/api/operations/cleanup" && request.method === "POST") {
    const rawUsageDays = boundedRetention(body?.usageRawRetentionDays, boundedRetention(env.USAGE_RAW_RETENTION_DAYS, 30));
    const auditDays = boundedRetention(body?.auditRetentionDays, boundedRetention(env.AUDIT_RETENTION_DAYS, 180));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(body?.limit) || 250)));
    const [registry, usage, audit] = await Promise.all([
      internalJson(registryStub(env).fetch(new Request("https://registry.internal/ops/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit }),
      }))),
      internalJson(usageStub(env).fetch(new Request("https://usage.internal/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionDays: rawUsageDays, limit }),
      }))),
      internalJson(auditStub(env).fetch(new Request("https://audit.internal/cleanup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionDays: auditDays, limit }),
      }))),
    ]);
    const ok = registry.ok && usage.ok && audit.ok;
    await recordAudit(env, actor, "operations.cleanup", { type: "operations", id: "retention" }, ok ? "success" : "failure", {
      registryDeleted: Number(registry.data?.deletedRecords || 0),
      usageDeleted: Number(usage.data?.deleted || 0),
      auditDeleted: Number(audit.data?.deleted || 0),
      status: ok ? 200 : 502,
    });
    return Response.json({ ok, registry, usage, audit }, { status: ok ? 200 : 502 });
  }

  if (path === "/admin/api/limits" && request.method === "GET") {
    const current = await quotaPolicy(env);
    const recentResponse = await usageStub(env).fetch("https://usage.internal/query?recentLimit=100");
    const recentData = await recentResponse.json<any>();
    const recentRejections = (Array.isArray(recentData.recent) ? recentData.recent : [])
      .filter((event: any) => event?.errorClass === "rate_limited" || event?.errorClass === "quota_exceeded")
      .slice(0, 20);
    return Response.json({ ...current, recentRejections });
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

  if (path === "/admin/api/overview" && request.method === "GET") {
    const hours = 24;
    if (!adminAuthorized) {
      const [usage, terminals] = await Promise.all([
        usageSummary(env, hours, selfUserId),
        terminalActivity(env, selfUserId),
      ]);
      const activeTerminals = terminals.reduce((count, agent) => count +
        agent.sessions.filter((session: any) => session.status === "running").length +
        agent.batches.reduce((sum: number, batch: any) => sum + Number(batch.counts?.running || 0), 0), 0);
      return Response.json({ role: "user", user: sessionUser, hours, usage: usage.metric ?? null, activeTerminals });
    }
    const state = await registryState(env);
    const [agents, usage, terminals] = await Promise.all([
      onlineAgents(env, state.agents ?? [], state.users ?? [], state.grants ?? []),
      usageSummary(env, hours),
      terminalActivity(env),
    ]);
    const activeTerminals = terminals.reduce((count, agent) => count +
      agent.sessions.filter((session: any) => session.status === "running").length +
      agent.batches.reduce((sum: number, batch: any) => sum + Number(batch.counts?.running || 0), 0), 0);
    const activeUsers = new Set((state.users ?? []).filter((u: any) => u.enabled && !u.deletedAt).map((u: any) => u.id));
    return Response.json({
      role: "admin",
      hours,
      users: { total: (state.users ?? []).length, enabled: activeUsers.size },
      agents: { total: agents.length, online: agents.filter((a: any) => a.online).length },
      grants: { total: (state.grants ?? []).length },
      usage: usage.metric ?? null,
      activeTerminals,
      activeUsers: activeUsers.size,
    });
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
    const items = (state.users ?? []).filter((user: any) =>
      (!q || String(user.id + " " + user.name + " " + (user.login ?? "")).toLowerCase().includes(q)) &&
      (enabled === null || String(user.enabled) === enabled)
    );
    return Response.json(page(items, url));
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
    let items = await onlineAgents(env, state.agents ?? [], state.users ?? [], state.grants ?? []);
    const q = String(url.searchParams.get("q") || "").toLowerCase();
    const online = url.searchParams.get("online");
    items = items.filter((agent: any) =>
      (!q || String(agent.id + " " + agent.name).toLowerCase().includes(q)) &&
      (online === null || String(agent.online) === online)
    );
    return Response.json(page(items, url));
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

  if (path === "/admin/api/usage" && request.method === "GET") {
    const scoped = new URL(url.toString());
    if (!adminAuthorized) scoped.searchParams.set("userId", selfUserId);
    const response = await usageQuery(env, scoped);
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/api/tool-calls" && request.method === "GET") {
    const query = new URLSearchParams();
    for (const key of ["state", "limit", "tool", "agentId", "from", "to", "activityId"]) {
      const value = url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    if (adminAuthorized) {
      const userId = url.searchParams.get("userId");
      if (userId) query.set("userId", userId);
    } else {
      query.set("userId", selfUserId);
    }
    const response = await usageStub(env).fetch("https://usage.internal/activity/query?" + query);
    const data = await response.json<any>().catch(() => ({}));
    if (!response.ok) return Response.json(data, { status: response.status });
    if (query.get("state") !== "active") return Response.json(data);
    const terminals = await terminalActivity(env, adminAuthorized ? undefined : selfUserId);
    return Response.json({ ...data, terminals });
  }

  if (path === "/admin/api/errors" && request.method === "GET") {
    const query = new URLSearchParams();
    for (const key of ["limit", "tool", "agentId", "userId", "errorClass", "from", "to"]) {
      const value = url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    const response = await usageStub(env).fetch("https://usage.internal/errors/query?" + query);
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/api/users" && request.method === "POST") {
    const name = String(body?.name ?? "").trim();
    const login = String(body?.login ?? "").trim();
    const password = String(body?.password ?? "");
    const makeAdmin = body?.admin === true;
    if (!name || !login || password.length < 8 || password.length > 128) return error(400, "invalid_user");
    const id = String(body?.id || generatedId(name, "user"));
    const token = newToken("usr");
    const created = await registryCall(env, "/users/create", { id, name, tokenHash: await hashToken(token) });
    const createdData = await created.json<any>();
    if (!created.ok) {
      await recordAudit(env, actor, "user.create", { type: "user", id }, "failure", { status: created.status });
      return Response.json(createdData, { status: created.status });
    }
    const credentials = await registryCall(env, "/users/set-login", { userId: id, login, password });
    if (!credentials.ok) {
      await registryCall(env, "/users/soft-delete", { userId: id });
      const data = await credentials.json<any>();
      await recordAudit(env, actor, "user.create", { type: "user", id }, "failure", { status: credentials.status });
      return Response.json(data, { status: credentials.status });
    }
    let user = (await credentials.json<any>()).user;
    if (makeAdmin) {
      const role = await registryCall(env, "/users/set-admin", { userId: id, admin: true });
      if (!role.ok) return error(502, "user_role_update_failed");
      user = (await role.json<any>()).user;
    }
    await recordAudit(env, actor, "user.create", { type: "user", id }, "success", { admin: makeAdmin });
    return Response.json({ ok: true, user }, { status: 201 });
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
  if (path === "/admin/usage" && request.method === "GET") return usageQuery(env, url);
  if (path === "/admin/state" && request.method === "GET") return registryCall(env, "/state");
  return error(404, "not_found");
}
