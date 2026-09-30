import { hashToken, newToken, normalizeAgentId } from "./registry";

type AdminEnv = {
  REGISTRY: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
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

async function onlineAgents(env: AdminEnv, agents: any[]) {
  return Promise.all(agents.map(async (agent) => {
    const status = await env.RELAY.get(env.RELAY.idFromName(agent.id))
      .fetch("https://relay.internal/status")
      .then((response) => response.json<any>())
      .catch(() => ({ online: false }));
    return { ...agent, online: Boolean(status.online) };
  }));
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

  if (path === "/admin/session" && request.method === "GET") {
    return Response.json({ ok: true, user: browserAuth?.ok ? browserAuth.data.user : { operator: true }, expiresAt: browserAuth?.ok ? browserAuth.data.expiresAt : null });
  }

  if (path === "/admin/session/logout" && request.method === "POST") {
    if (browserAuth?.ok) await registryCall(env, "/admin-session/revoke", { tokenHash: browserAuth.tokenHash });
    return Response.json({ ok: true }, { headers: { "set-cookie": adminCookie("", 0), "cache-control": "no-store" } });
  }

  if (path === "/admin/api/overview" && request.method === "GET") {
    const state = await registryState(env);
    const agents = await onlineAgents(env, state.agents ?? []);
    const usageResponse = await usageQuery(env, url);
    const usage = await usageResponse.json<any>();
    return Response.json({
      users: { total: (state.users ?? []).length, enabled: (state.users ?? []).filter((u: any) => u.enabled).length },
      agents: { total: agents.length, online: agents.filter((a: any) => a.online).length },
      grants: { total: (state.grants ?? []).length },
      usage: usage.metric ?? null,
      day: usage.day,
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
    const [agent] = await onlineAgents(env, [baseAgent]);
    return Response.json({ agent, grants: (state.grants ?? []).filter((grant: any) => grant.agentId === id) });
  }

  if (path === "/admin/api/agents" && request.method === "GET") {
    const state = await registryState(env);
    let items = await onlineAgents(env, state.agents ?? []);
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
    const response = await usageQuery(env, url);
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/api/users/admin" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return registryCall(env, "/users/set-admin", { userId, admin: body?.admin === true });
  }

  if (path === "/admin/api/admin-sessions/revoke" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return registryCall(env, "/admin-session/revoke-user", { userId });
  }

  if (path === "/admin/api/sessions/revoke" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    return registryCall(env, "/sessions/revoke-user", { userId });
  }

  if (path === "/admin/bootstrap" && request.method === "POST") {
    if (!env.CALLER_TOKEN || !env.AGENT_TOKEN) return error(503, "legacy_tokens_missing");
    return registryCall(env, "/bootstrap", {
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
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/agents" && request.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (!name) return error(400, "name_required");
    let id: string;
    try { id = body?.id ? normalizeAgentId(String(body.id)) : generatedId(name, "agent"); }
    catch { return error(400, "invalid_agent_id"); }
    const token = newToken("agt");
    const response = await registryCall(env, "/agents/create", { id, name, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/grants" && request.method === "POST") {
    return registryCall(env, "/grants/upsert", {
      userId: String(body?.userId ?? ""),
      agentId: String(body?.agentId ?? ""),
      scopes: Array.isArray(body?.scopes) ? body.scopes : [],
    });
  }
  if (path === "/admin/grants/delete" && request.method === "POST") {
    return registryCall(env, "/grants/delete", { userId: String(body?.userId ?? ""), agentId: String(body?.agentId ?? "") });
  }
  if (path === "/admin/users/login" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const login = String(body?.login ?? "");
    const password = String(body?.password ?? "");
    if (!userId || !login || !password) return error(400, "credentials_required");
    return registryCall(env, "/users/set-login", { userId, login, password });
  }
  if (path === "/admin/users/enabled" && request.method === "POST") {
    return registryCall(env, "/users/set-enabled", { userId: String(body?.userId ?? ""), enabled: Boolean(body?.enabled) });
  }
  if (path === "/admin/agents/enabled" && request.method === "POST") {
    return registryCall(env, "/agents/set-enabled", { agentId: String(body?.agentId ?? ""), enabled: Boolean(body?.enabled) });
  }
  if (path === "/admin/users/rotate" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    const token = newToken("usr");
    const response = await registryCall(env, "/users/rotate", { userId, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }
  if (path === "/admin/agents/rotate" && request.method === "POST") {
    const agentId = String(body?.agentId ?? "");
    if (!agentId) return error(400, "agent_id_required");
    const token = newToken("agt");
    const response = await registryCall(env, "/agents/rotate", { agentId, tokenHash: await hashToken(token) });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }
  if (path === "/admin/usage" && request.method === "GET") return usageQuery(env, url);
  if (path === "/admin/state" && request.method === "GET") return registryCall(env, "/state");
  return error(404, "not_found");
}
