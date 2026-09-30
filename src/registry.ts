import { DurableObject } from "cloudflare:workers";
import {
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  randomSalt,
  secureEqual,
} from "./auth-crypto";

export type Scope = "read" | "write" | "terminal" | "process" | "admin";
export type UserRecord = {
  id: string;
  name: string;
  tokenHash?: string;
  login?: string;
  passwordSalt?: string;
  passwordHash?: string;
  passwordIterations?: number;
  enabled: boolean;
  createdAt: string;
};
export type AgentRecord = {
  id: string;
  name: string;
  tokenHash: string;
  ownerUserId?: string;
  enabled: boolean;
  createdAt: string;
  lastSeenAt?: string;
};
export type GrantRecord = {
  userId: string;
  agentId: string;
  scopes: string[];
  createdAt: string;
};

type UserSessionRecord = {
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

type DeviceAuthRecord = {
  deviceCodeHash: string;
  userCode: string;
  agentId: string;
  agentName: string;
  status: "pending" | "approved" | "consumed";
  userId?: string;
  createdAt: string;
  expiresAt: string;
};

type LoginAttemptRecord = {
  count: number;
  windowStartedAt: string;
  blockedUntil?: string;
};

type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  createdAt: string;
};

type OAuthCodeRecord = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  resource: string;
  expiresAt: string;
};

type OAuthTokenRecord = {
  tokenHash: string;
  userId: string;
  clientId: string;
  scope: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
};

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const DEVICE_START_WINDOW_MS = 10 * 60 * 1000;
const DEVICE_START_MAX = 30;
const DEVICE_APPROVE_WINDOW_MS = 15 * 60 * 1000;
const DEVICE_APPROVE_MAX = 60;
const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
const OAUTH_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const OAUTH_REGISTER_WINDOW_MS = 15 * 60 * 1000;
const OAUTH_REGISTER_MAX = 60;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const key = {
  user: (id: string) => `user:${id}`,
  userLogin: (login: string) => `ul:${login}`,
  userToken: (hash: string) => `ut:${hash}`,
  userSession: (hash: string) => `us:${hash}`,
  agent: (id: string) => `agent:${id}`,
  agentToken: (hash: string) => `at:${hash}`,
  grant: (userId: string, agentId: string) => `grant:${userId}:${agentId}`,
  device: (hash: string) => `device:${hash}`,
  deviceUserCode: (userCode: string) => `device-code:${userCode}`,
  loginAttempt: (login: string) => `login-attempt:${login}`,
  deviceStartRate: (sourceHash: string) => `device-start-rate:${sourceHash}`,
  deviceApproveRate: (sourceHash: string) => `device-approve-rate:${sourceHash}`,
  oauthClient: (clientId: string) => `oauth-client:${clientId}`,
  oauthCode: (hash: string) => `oauth-code:${hash}`,
  oauthAccess: (hash: string) => `oauth-access:${hash}`,
  oauthRefresh: (hash: string) => `oauth-refresh:${hash}`,
  oauthRegisterRate: (sourceHash: string) => `oauth-register-rate:${sourceHash}`,
};

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return `${prefix}_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export function normalizeAgentId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 64) throw new Error("invalid_agent_id");
  return normalized;
}

function hasScope(grant: GrantRecord, scope: string): boolean {
  return grant.scopes.includes("*") || grant.scopes.includes(scope);
}

function normalizeLogin(value: string): string {
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)) {
    throw new Error("invalid_login");
  }
  return login;
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    name: user.name,
    login: user.login ?? null,
    enabled: user.enabled,
    createdAt: user.createdAt,
  };
}

function isExpired(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

export class Registry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === "GET" ? null : await request.json().catch(() => null);

    switch (path) {
      case "/bootstrap": return this.bootstrap(body);
      case "/users/create": return this.createUser(body);
      case "/agents/create": return this.createAgent(body);
      case "/grants/upsert": return this.upsertGrant(body);
      case "/grants/delete": return this.deleteGrant(body);
      case "/users/set-enabled": return this.setUserEnabled(body);
      case "/users/set-login": return this.setUserLogin(body);
      case "/agents/set-enabled": return this.setAgentEnabled(body);
      case "/users/rotate": return this.rotateUser(body);
      case "/agents/rotate": return this.rotateAgent(body);
      case "/device/start": return this.startDevice(body);
      case "/device/approve": return this.approveDevice(body);
      case "/device/exchange": return this.exchangeDevice(body);
      case "/oauth/client/register": return this.registerOAuthClient(body);
      case "/oauth/client/get": return this.getOAuthClient(body);
      case "/oauth/password": return this.oauthPassword(body);
      case "/oauth/code/create": return this.createOAuthCode(body);
      case "/oauth/code/exchange": return this.exchangeOAuthCode(body);
      case "/oauth/refresh/exchange": return this.exchangeOAuthRefresh(body);
      case "/session/revoke": return this.revokeSession(body);
      case "/sessions/list": return this.listSessions(body);
      case "/sessions/revoke-user": return this.revokeUserSessions(body);
      case "/session/logout-agent": return this.logoutAgent(body);
      case "/auth/user": return this.authUser(body);
      case "/auth/agent": return this.authAgent(body);
      case "/resolve": return this.resolveAgent(body);
      case "/list-agents": return this.listAgents(body);
      case "/state": return this.state();
      default: return json({ error: "not_found" }, 404);
    }
  }

  private async bootstrap(body: any): Promise<Response> {
    const existing = await this.ctx.storage.get<UserRecord>(key.user("owner"));
    if (existing) {
      let migratedOwner = false;
      const requestedAgentId = normalizeAgentId(String(body?.agentId || "default"));
      const existingAgent = await this.ctx.storage.get<AgentRecord>(key.agent(requestedAgentId));
      if (existingAgent && !existingAgent.ownerUserId) {
        existingAgent.ownerUserId = existing.id;
        await this.ctx.storage.put(key.agent(existingAgent.id), existingAgent);
        migratedOwner = true;
      }
      return json({ ok: true, alreadyBootstrapped: true, migratedOwner });
    }

    if (!body?.userTokenHash || !body?.agentTokenHash) {
      return json({ error: "bootstrap_tokens_required" }, 400);
    }

    const now = new Date().toISOString();
    const user: UserRecord = {
      id: "owner",
      name: body.userName || "Owner",
      tokenHash: body.userTokenHash,
      enabled: true,
      createdAt: now,
    };
    const agent: AgentRecord = {
      id: normalizeAgentId(body.agentId || "default"),
      name: body.agentName || "Default PC",
      tokenHash: body.agentTokenHash,
      ownerUserId: user.id,
      enabled: true,
      createdAt: now,
    };
    const grant: GrantRecord = {
      userId: user.id,
      agentId: agent.id,
      scopes: ["*"],
      createdAt: now,
    };

    await this.ctx.storage.put({
      [key.user(user.id)]: user,
      [key.userToken(user.tokenHash)]: user.id,
      [key.agent(agent.id)]: agent,
      [key.agentToken(agent.tokenHash)]: agent.id,
      [key.grant(user.id, agent.id)]: grant,
    });
    return json({ ok: true, user: { id: user.id, name: user.name }, agent: { id: agent.id, name: agent.name } });
  }

  private async createUser(body: any): Promise<Response> {
    if (!body?.id || !body?.name || !body?.tokenHash) return json({ error: "invalid_user" }, 400);
    const id = String(body.id);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return json({ error: "invalid_user_id" }, 400);
    if (await this.ctx.storage.get(key.user(id))) return json({ error: "user_exists" }, 409);

    const user: UserRecord = {
      id,
      name: String(body.name).slice(0, 120),
      tokenHash: String(body.tokenHash),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put({
      [key.user(id)]: user,
      [key.userToken(user.tokenHash)]: id,
    });
    return json({ ok: true, user: { id: user.id, name: user.name, enabled: user.enabled } }, 201);
  }

  private async createAgent(body: any): Promise<Response> {
    if (!body?.id || !body?.name || !body?.tokenHash) return json({ error: "invalid_agent" }, 400);
    let id: string;
    try { id = normalizeAgentId(String(body.id)); }
    catch { return json({ error: "invalid_agent_id" }, 400); }
    if (await this.ctx.storage.get(key.agent(id))) return json({ error: "agent_exists" }, 409);

    const agent: AgentRecord = {
      id,
      name: String(body.name).slice(0, 120),
      tokenHash: String(body.tokenHash),
      ownerUserId: body?.ownerUserId ? String(body.ownerUserId) : undefined,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put({
      [key.agent(id)]: agent,
      [key.agentToken(agent.tokenHash)]: id,
    });
    return json({ ok: true, agent: { id: agent.id, name: agent.name, enabled: agent.enabled } }, 201);
  }

  private async upsertGrant(body: any): Promise<Response> {
    if (!body?.userId || !body?.agentId || !Array.isArray(body?.scopes)) {
      return json({ error: "invalid_grant" }, 400);
    }
    const user = await this.ctx.storage.get<UserRecord>(key.user(String(body.userId)));
    const agent = await this.ctx.storage.get<AgentRecord>(key.agent(String(body.agentId)));
    if (!user || !agent) return json({ error: "principal_not_found" }, 404);

    const allowed = new Set(["*", "read", "write", "terminal", "process", "admin"]);
    const scopes = [...new Set(body.scopes.map(String))].filter((scope) => allowed.has(scope));
    if (scopes.length === 0) return json({ error: "scopes_required" }, 400);

    const grant: GrantRecord = {
      userId: user.id,
      agentId: agent.id,
      scopes,
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(key.grant(user.id, agent.id), grant);
    return json({ ok: true, grant });
  }

  private async deleteGrant(body: any): Promise<Response> {
    if (!body?.userId || !body?.agentId) return json({ error: "invalid_grant" }, 400);
    await this.ctx.storage.delete(key.grant(String(body.userId), String(body.agentId)));
    return json({ ok: true });
  }

  private async setUserEnabled(body: any): Promise<Response> {
    const id = String(body?.userId ?? "");
    const user = await this.ctx.storage.get<UserRecord>(key.user(id));
    if (!user) return json({ error: "user_not_found" }, 404);
    user.enabled = Boolean(body.enabled);
    await this.ctx.storage.put(key.user(id), user);
    return json({ ok: true, user: { id: user.id, name: user.name, enabled: user.enabled } });
  }

  private async setUserLogin(body: any): Promise<Response> {
    const id = String(body?.userId ?? "");
    const password = String(body?.password ?? "");
    if (!id || password.length < 8 || password.length > 128) {
      return json({ error: "invalid_credentials" }, 400);
    }

    let login: string;
    try { login = normalizeLogin(String(body?.login ?? "")); }
    catch { return json({ error: "invalid_login" }, 400); }

    const user = await this.ctx.storage.get<UserRecord>(key.user(id));
    if (!user) return json({ error: "user_not_found" }, 404);

    const existingUserId = await this.ctx.storage.get<string>(key.userLogin(login));
    if (existingUserId && existingUserId !== user.id) {
      return json({ error: "login_exists" }, 409);
    }

    const previousLogin = user.login;
    const salt = randomSalt();
    user.login = login;
    user.passwordSalt = salt;
    user.passwordHash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
    user.passwordIterations = PASSWORD_ITERATIONS;

    if (previousLogin && previousLogin !== login) {
      const previousOwner = await this.ctx.storage.get<string>(key.userLogin(previousLogin));
      if (previousOwner === user.id) await this.ctx.storage.delete(key.userLogin(previousLogin));
    }

    await this.ctx.storage.put({
      [key.user(user.id)]: user,
      [key.userLogin(login)]: user.id,
    });
    await this.ctx.storage.delete(key.loginAttempt(login));
    return json({ ok: true, user: publicUser(user) });
  }
  private async setAgentEnabled(body: any): Promise<Response> {
    const id = String(body?.agentId ?? "");
    const agent = await this.ctx.storage.get<AgentRecord>(key.agent(id));
    if (!agent) return json({ error: "agent_not_found" }, 404);
    agent.enabled = Boolean(body.enabled);
    await this.ctx.storage.put(key.agent(id), agent);
    return json({ ok: true, agent: { id: agent.id, name: agent.name, enabled: agent.enabled } });
  }

  private async rotateUser(body: any): Promise<Response> {
    const id = String(body?.userId ?? "");
    const tokenHash = String(body?.tokenHash ?? "");
    if (!id || !tokenHash) return json({ error: "invalid_rotation" }, 400);
    const user = await this.ctx.storage.get<UserRecord>(key.user(id));
    if (!user) return json({ error: "user_not_found" }, 404);
    await this.ctx.storage.delete(key.userToken(user.tokenHash));
    user.tokenHash = tokenHash;
    await this.ctx.storage.put({
      [key.user(id)]: user,
      [key.userToken(tokenHash)]: id,
    });
    return json({ ok: true, user: { id: user.id, name: user.name, enabled: user.enabled } });
  }

  private async rotateAgent(body: any): Promise<Response> {
    const id = String(body?.agentId ?? "");
    const tokenHash = String(body?.tokenHash ?? "");
    if (!id || !tokenHash) return json({ error: "invalid_rotation" }, 400);
    const agent = await this.ctx.storage.get<AgentRecord>(key.agent(id));
    if (!agent) return json({ error: "agent_not_found" }, 404);
    await this.ctx.storage.delete(key.agentToken(agent.tokenHash));
    agent.tokenHash = tokenHash;
    await this.ctx.storage.put({
      [key.agent(id)]: agent,
      [key.agentToken(tokenHash)]: id,
    });
    return json({ ok: true, agent: { id: agent.id, name: agent.name, enabled: agent.enabled } });
  }

  private async consumeRateLimit(
    storageKey: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const current = await this.ctx.storage.get<LoginAttemptRecord>(storageKey);
    const record: LoginAttemptRecord = !current ||
      now - Date.parse(current.windowStartedAt) > windowMs
      ? { count: 1, windowStartedAt: new Date(now).toISOString() }
      : { ...current, count: current.count + 1 };

    if (record.count > limit) return false;
    await this.ctx.storage.put(storageKey, record);
    return true;
  }

  private async cleanupExpiredAuthArtifacts(): Promise<void> {
    const now = Date.now();
    const [devices, sessions, codes, accessTokens, refreshTokens] = await Promise.all([
      this.ctx.storage.list<DeviceAuthRecord>({ prefix: "device:" }),
      this.ctx.storage.list<UserSessionRecord>({ prefix: "us:" }),
      this.ctx.storage.list<OAuthCodeRecord>({ prefix: "oauth-code:" }),
      this.ctx.storage.list<OAuthTokenRecord>({ prefix: "oauth-access:" }),
      this.ctx.storage.list<OAuthTokenRecord>({ prefix: "oauth-refresh:" }),
    ]);

    const keys: string[] = [];
    for (const [storageKey, device] of devices) {
      if (Date.parse(device.expiresAt) <= now) {
        keys.push(storageKey, key.deviceUserCode(device.userCode));
      }
    }
    for (const [storageKey, session] of sessions) {
      if (Date.parse(session.expiresAt) <= now) keys.push(storageKey);
    }
    for (const records of [codes, accessTokens, refreshTokens]) {
      for (const [storageKey, record] of records) {
        if (Date.parse(record.expiresAt) <= now) keys.push(storageKey);
      }
    }

    for (let index = 0; index < keys.length; index += 128) {
      await this.ctx.storage.delete(keys.slice(index, index + 128));
    }
  }

  private async startDevice(body: any): Promise<Response> {
    const deviceCodeHash = String(body?.deviceCodeHash ?? "");
    const userCode = String(body?.userCode ?? "").trim().toUpperCase();
    const agentName = String(body?.agentName ?? "").trim().slice(0, 120);
    const expiresAt = String(body?.expiresAt ?? "");
    const sourceHash = String(body?.sourceHash ?? "unknown").slice(0, 128);
    if (!deviceCodeHash || !userCode || !agentName || !expiresAt || isExpired(expiresAt)) {
      return json({ error: "invalid_device_request" }, 400);
    }

    let agentId: string;
    try { agentId = normalizeAgentId(String(body?.agentId ?? "")); }
    catch { return json({ error: "invalid_agent_id" }, 400); }

    await this.cleanupExpiredAuthArtifacts();

    if (!(await this.consumeRateLimit(
      key.deviceStartRate(sourceHash),
      DEVICE_START_MAX,
      DEVICE_START_WINDOW_MS,
    ))) {
      return json({ error: "rate_limited" }, 429);
    }

    if (await this.ctx.storage.get(key.deviceUserCode(userCode))) {
      return json({ error: "user_code_collision" }, 409);
    }

    const record: DeviceAuthRecord = {
      deviceCodeHash,
      userCode,
      agentId,
      agentName,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt,
    };

    await this.ctx.storage.put({
      [key.device(deviceCodeHash)]: record,
      [key.deviceUserCode(userCode)]: deviceCodeHash,
    });
    return json({ ok: true });
  }

  private async loginBlocked(login: string): Promise<boolean> {
    const attempt = await this.ctx.storage.get<LoginAttemptRecord>(key.loginAttempt(login));
    if (!attempt) return false;
    if (attempt.blockedUntil && Date.parse(attempt.blockedUntil) > Date.now()) return true;
    if (Date.now() - Date.parse(attempt.windowStartedAt) > LOGIN_WINDOW_MS) {
      await this.ctx.storage.delete(key.loginAttempt(login));
      return false;
    }
    return false;
  }

  private async recordLoginFailure(login: string): Promise<void> {
    const current = await this.ctx.storage.get<LoginAttemptRecord>(key.loginAttempt(login));
    const now = Date.now();
    const record: LoginAttemptRecord = !current || now - Date.parse(current.windowStartedAt) > LOGIN_WINDOW_MS
      ? { count: 1, windowStartedAt: new Date(now).toISOString() }
      : { ...current, count: current.count + 1 };
    if (record.count >= LOGIN_MAX_FAILURES) {
      record.blockedUntil = new Date(now + LOGIN_WINDOW_MS).toISOString();
    }
    await this.ctx.storage.put(key.loginAttempt(login), record);
  }

  private async approveDevice(body: any): Promise<Response> {
    const userCode = String(body?.userCode ?? "").trim().toUpperCase();
    const loginRaw = String(body?.login ?? "");
    const password = String(body?.password ?? "");
    const name = String(body?.name ?? "").trim();
    const sourceHash = String(body?.sourceHash ?? "unknown").slice(0, 128);

    if (!(await this.consumeRateLimit(
      key.deviceApproveRate(sourceHash),
      DEVICE_APPROVE_MAX,
      DEVICE_APPROVE_WINDOW_MS,
    ))) {
      return json({ error: "rate_limited" }, 429);
    }

    if (!userCode || password.length < 8 || password.length > 128) {
      return json({ error: "invalid_credentials" }, 400);
    }

    let login: string;
    try { login = normalizeLogin(loginRaw); }
    catch { return json({ error: "invalid_login" }, 400); }

    const deviceCodeHash = await this.ctx.storage.get<string>(key.deviceUserCode(userCode));
    if (!deviceCodeHash) return json({ error: "device_code_not_found" }, 404);

    const device = await this.ctx.storage.get<DeviceAuthRecord>(key.device(deviceCodeHash));
    if (!device || isExpired(device.expiresAt)) {
      await this.ctx.storage.delete([key.device(deviceCodeHash), key.deviceUserCode(userCode)]);
      return json({ error: "device_code_expired" }, 410);
    }
    if (device.status !== "pending") return json({ error: "device_code_already_used" }, 409);

    let userId = await this.ctx.storage.get<string>(key.userLogin(login));
    let user: UserRecord | undefined;

    if (userId) {
      if (await this.loginBlocked(login)) return json({ error: "too_many_attempts" }, 429);
      user = await this.ctx.storage.get<UserRecord>(key.user(userId));
      if (!user?.enabled || !user.passwordSalt || !user.passwordHash) {
        return json({ error: "account_unavailable" }, 403);
      }
      const derived = await derivePasswordHash(
        password,
        user.passwordSalt,
        user.passwordIterations ?? PASSWORD_ITERATIONS,
      );
      if (!secureEqual(derived, user.passwordHash)) {
        await this.recordLoginFailure(login);
        return json({ error: "invalid_credentials" }, 401);
      }
      await this.ctx.storage.delete(key.loginAttempt(login));
    } else {
      const userName = (name || login).slice(0, 120);
      const salt = randomSalt();
      userId = `user-${crypto.randomUUID().slice(0, 12)}`;
      user = {
        id: userId,
        name: userName,
        login,
        passwordSalt: salt,
        passwordHash: await derivePasswordHash(password, salt, PASSWORD_ITERATIONS),
        passwordIterations: PASSWORD_ITERATIONS,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      await this.ctx.storage.put({
        [key.user(user.id)]: user,
        [key.userLogin(login)]: user.id,
      });
    }

    if (!user) return json({ error: "account_unavailable" }, 403);

    device.status = "approved";
    device.userId = user.id;
    await this.ctx.storage.put(key.device(device.deviceCodeHash), device);
    return json({ ok: true, user: publicUser(user), agent: { id: device.agentId, name: device.agentName } });
  }

  private async exchangeDevice(body: any): Promise<Response> {
    const deviceCodeHash = String(body?.deviceCodeHash ?? "");
    if (!deviceCodeHash) return json({ error: "device_code_required" }, 400);

    const device = await this.ctx.storage.get<DeviceAuthRecord>(key.device(deviceCodeHash));
    if (!device) return json({ error: "invalid_device_code" }, 400);
    if (isExpired(device.expiresAt)) {
      await this.ctx.storage.delete([key.device(deviceCodeHash), key.deviceUserCode(device.userCode)]);
      return json({ error: "expired_token" }, 400);
    }
    if (device.status === "pending") return json({ error: "authorization_pending" }, 428);
    if (device.status === "consumed" || !device.userId) return json({ error: "invalid_grant" }, 400);

    const user = await this.ctx.storage.get<UserRecord>(key.user(device.userId));
    if (!user?.enabled) return json({ error: "account_unavailable" }, 403);

    let agentId = device.agentId;
    let agent = await this.ctx.storage.get<AgentRecord>(key.agent(agentId));
    let grant = await this.ctx.storage.get<GrantRecord>(key.grant(user.id, agentId));

    if (agent && agent.ownerUserId !== user.id) {
      agentId = `${agentId.slice(0, 54)}-${crypto.randomUUID().slice(0, 8)}`;
      agent = undefined;
      grant = undefined;
    }

    const agentToken = newToken("agt");
    const agentTokenHash = await hashToken(agentToken);
    const now = new Date().toISOString();

    if (agent) {
      await this.ctx.storage.delete(key.agentToken(agent.tokenHash));
      agent.name = device.agentName;
      agent.tokenHash = agentTokenHash;
      agent.enabled = true;
      await this.ctx.storage.put({
        [key.agent(agent.id)]: agent,
        [key.agentToken(agent.tokenHash)]: agent.id,
      });
    } else {
      agent = {
        id: agentId,
        name: device.agentName,
        tokenHash: agentTokenHash,
        ownerUserId: user.id,
        enabled: true,
        createdAt: now,
      };
      await this.ctx.storage.put({
        [key.agent(agent.id)]: agent,
        [key.agentToken(agent.tokenHash)]: agent.id,
      });
    }

    if (!grant || grant.agentId !== agent.id) {
      grant = { userId: user.id, agentId: agent.id, scopes: ["*"], createdAt: now };
      await this.ctx.storage.put(key.grant(user.id, agent.id), grant);
    }

    const userToken = newToken("usr");
    const userTokenHash = await hashToken(userToken);
    const session: UserSessionRecord = {
      userId: user.id,
      tokenHash: userTokenHash,
      createdAt: now,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    await this.ctx.storage.put(key.userSession(userTokenHash), session);

    await this.ctx.storage.delete([
      key.device(device.deviceCodeHash),
      key.deviceUserCode(device.userCode),
    ]);

    return json({
      ok: true,
      user: publicUser(user),
      userToken,
      userTokenExpiresAt: session.expiresAt,
      agent: { id: agent.id, name: agent.name },
      agentToken,
    });
  }

  private async registerOAuthClient(body: any): Promise<Response> {
    const clientId = String(body?.clientId ?? "");
    const clientName = String(body?.clientName ?? "ChatGPT MCP").slice(0, 120);
    const redirectUris = Array.isArray(body?.redirectUris)
      ? body.redirectUris.map(String)
      : [];
    const sourceHash = String(body?.sourceHash ?? "unknown").slice(0, 128);

    if (!clientId || redirectUris.length === 0 || redirectUris.length > 20) {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    if (!(await this.consumeRateLimit(
      key.oauthRegisterRate(sourceHash),
      OAUTH_REGISTER_MAX,
      OAUTH_REGISTER_WINDOW_MS,
    ))) {
      return json({ error: "rate_limited" }, 429);
    }
    if (await this.ctx.storage.get(key.oauthClient(clientId))) {
      return json({ error: "client_exists" }, 409);
    }

    const client: OAuthClientRecord = {
      clientId,
      clientName,
      redirectUris,
      tokenEndpointAuthMethod: "none",
      createdAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(key.oauthClient(clientId), client);
    return json({ ok: true, client }, 201);
  }

  private async getOAuthClient(body: any): Promise<Response> {
    const clientId = String(body?.clientId ?? "");
    if (!clientId) return json({ error: "invalid_client" }, 400);

    const client = await this.ctx.storage.get<OAuthClientRecord>(
      key.oauthClient(clientId),
    );
    if (!client) return json({ error: "invalid_client" }, 404);
    return json({ ok: true, client });
  }

  private async oauthPassword(body: any): Promise<Response> {
    let login: string;
    try { login = normalizeLogin(String(body?.login ?? "")); }
    catch { return json({ error: "invalid_credentials" }, 401); }

    const password = String(body?.password ?? "");
    if (password.length < 8 || password.length > 128) {
      return json({ error: "invalid_credentials" }, 401);
    }
    if (await this.loginBlocked(login)) {
      return json({ error: "too_many_attempts" }, 429);
    }

    const userId = await this.ctx.storage.get<string>(key.userLogin(login));
    const user = userId
      ? await this.ctx.storage.get<UserRecord>(key.user(userId))
      : undefined;
    if (!user?.enabled || !user.passwordSalt || !user.passwordHash) {
      await this.recordLoginFailure(login);
      return json({ error: "invalid_credentials" }, 401);
    }

    const derived = await derivePasswordHash(
      password,
      user.passwordSalt,
      user.passwordIterations ?? PASSWORD_ITERATIONS,
    );
    if (!secureEqual(derived, user.passwordHash)) {
      await this.recordLoginFailure(login);
      return json({ error: "invalid_credentials" }, 401);
    }

    await this.ctx.storage.delete(key.loginAttempt(login));
    return json({ ok: true, user: publicUser(user) });
  }

  private async createOAuthCode(body: any): Promise<Response> {
    const codeHash = String(body?.codeHash ?? "");
    const clientId = String(body?.clientId ?? "");
    const userId = String(body?.userId ?? "");
    const redirectUri = String(body?.redirectUri ?? "");
    const codeChallenge = String(body?.codeChallenge ?? "");
    const resource = String(body?.resource ?? "");
    const scope = Array.isArray(body?.scope) ? body.scope.map(String) : [];
    const expiresAt = String(body?.expiresAt ?? "");

    if (!codeHash || !clientId || !userId || !redirectUri ||
        !codeChallenge || !resource || scope.length === 0 ||
        !expiresAt || isExpired(expiresAt)) {
      return json({ error: "invalid_request" }, 400);
    }

    const [client, user] = await Promise.all([
      this.ctx.storage.get<OAuthClientRecord>(key.oauthClient(clientId)),
      this.ctx.storage.get<UserRecord>(key.user(userId)),
    ]);
    if (!client || !client.redirectUris.includes(redirectUri)) {
      return json({ error: "invalid_client" }, 400);
    }
    if (!user?.enabled) return json({ error: "access_denied" }, 403);

    const record: OAuthCodeRecord = {
      codeHash,
      clientId,
      userId,
      redirectUri,
      codeChallenge,
      scope,
      resource,
      expiresAt,
    };
    await this.ctx.storage.put(key.oauthCode(codeHash), record);
    return json({ ok: true });
  }

  private async issueOAuthTokens(
    userId: string,
    clientId: string,
    scope: string[],
    resource: string,
  ) {
    const now = new Date().toISOString();
    const accessToken = newToken("access");
    const access: OAuthTokenRecord = {
      tokenHash: await hashToken(accessToken),
      userId,
      clientId,
      scope,
      resource,
      createdAt: now,
      expiresAt: new Date(Date.now() + OAUTH_ACCESS_TTL_MS).toISOString(),
    };

    const records: Record<string, OAuthTokenRecord> = {
      [key.oauthAccess(access.tokenHash)]: access,
    };
    const result: Record<string, string | number> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
      scope: scope.join(" "),
    };

    if (scope.includes("offline_access")) {
      const refreshToken = newToken("refresh");
      const refresh: OAuthTokenRecord = {
        tokenHash: await hashToken(refreshToken),
        userId,
        clientId,
        scope,
        resource,
        createdAt: now,
        expiresAt: new Date(Date.now() + OAUTH_REFRESH_TTL_MS).toISOString(),
      };
      records[key.oauthRefresh(refresh.tokenHash)] = refresh;
      result.refresh_token = refreshToken;
    }

    await this.ctx.storage.put(records);
    return result;
  }

  private async exchangeOAuthCode(body: any): Promise<Response> {
    const codeHash = String(body?.codeHash ?? "");
    const clientId = String(body?.clientId ?? "");
    const redirectUri = String(body?.redirectUri ?? "");
    const codeChallenge = String(body?.codeChallenge ?? "");
    const resource = String(body?.resource ?? "");

    const record = codeHash
      ? await this.ctx.storage.get<OAuthCodeRecord>(key.oauthCode(codeHash))
      : undefined;
    if (!record || isExpired(record.expiresAt)) {
      if (record) await this.ctx.storage.delete(key.oauthCode(codeHash));
      return json({ error: "invalid_grant" }, 400);
    }

    if (record.clientId !== clientId ||
        record.redirectUri !== redirectUri ||
        record.codeChallenge !== codeChallenge ||
        record.resource !== resource) {
      return json({ error: "invalid_grant" }, 400);
    }

    const user = await this.ctx.storage.get<UserRecord>(key.user(record.userId));
    if (!user?.enabled) return json({ error: "invalid_grant" }, 400);

    await this.ctx.storage.delete(key.oauthCode(codeHash));
    const tokens = await this.issueOAuthTokens(
      record.userId,
      record.clientId,
      record.scope,
      record.resource,
    );
    return json(tokens);
  }

  private async exchangeOAuthRefresh(body: any): Promise<Response> {
    const refreshTokenHash = String(body?.refreshTokenHash ?? "");
    const clientId = String(body?.clientId ?? "");
    const resource = String(body?.resource ?? "");

    const record = refreshTokenHash
      ? await this.ctx.storage.get<OAuthTokenRecord>(
        key.oauthRefresh(refreshTokenHash),
      )
      : undefined;
    if (!record || isExpired(record.expiresAt) ||
        record.clientId !== clientId ||
        record.resource !== resource) {
      if (record && isExpired(record.expiresAt)) {
        await this.ctx.storage.delete(key.oauthRefresh(refreshTokenHash));
      }
      return json({ error: "invalid_grant" }, 400);
    }

    const user = await this.ctx.storage.get<UserRecord>(key.user(record.userId));
    if (!user?.enabled) return json({ error: "invalid_grant" }, 400);

    await this.ctx.storage.delete(key.oauthRefresh(refreshTokenHash));
    const tokens = await this.issueOAuthTokens(
      record.userId,
      record.clientId,
      record.scope,
      record.resource,
    );
    return json(tokens);
  }

  private async listSessions(body: any): Promise<Response> {
    const userId = body?.userId ? String(body.userId) : "";
    const sessions = await this.ctx.storage.list<UserSessionRecord>({ prefix: "us:" });
    const result = [...sessions.values()]
      .filter((session) => !userId || session.userId === userId)
      .map((session) => ({
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        expired: isExpired(session.expiresAt),
      }));
    return json({ ok: true, sessions: result });
  }

  private async revokeUserSessions(body: any): Promise<Response> {
    const userId = String(body?.userId ?? "");
    if (!userId) return json({ error: "user_id_required" }, 400);
    const sessions = await this.ctx.storage.list<UserSessionRecord>({ prefix: "us:" });
    const keys = [...sessions.entries()]
      .filter(([, session]) => session.userId === userId)
      .map(([sessionKey]) => sessionKey);
    if (keys.length > 0) await this.ctx.storage.delete(keys);
    return json({ ok: true, revoked: keys.length });
  }

  private async revokeSession(body: any): Promise<Response> {
    const tokenHash = String(body?.tokenHash ?? "");
    if (!tokenHash) return json({ error: "token_required" }, 400);
    await this.ctx.storage.delete(key.userSession(tokenHash));
    return json({ ok: true });
  }

  private async logoutAgent(body: any): Promise<Response> {
    const userId = String(body?.userId ?? "");
    const agentId = String(body?.agentId ?? "");
    const tokenHash = String(body?.tokenHash ?? "");
    if (!userId || !agentId || !tokenHash) return json({ error: "invalid_logout" }, 400);

    const grant = await this.ctx.storage.get<GrantRecord>(key.grant(userId, agentId));
    const agent = await this.ctx.storage.get<AgentRecord>(key.agent(agentId));
    if (!grant || !agent || agent.ownerUserId !== userId) {
      return json({ error: "permission_denied" }, 403);
    }

    await this.ctx.storage.delete(key.userSession(tokenHash));
    await this.ctx.storage.delete(key.agentToken(agent.tokenHash));
    agent.tokenHash = await hashToken(newToken("revoked"));
    agent.enabled = false;
    await this.ctx.storage.put(key.agent(agent.id), agent);
    return json({ ok: true });
  }

  private async authUser(body: any): Promise<Response> {
    const tokenHash = String(body?.tokenHash ?? "");
    if (!tokenHash) return json({ error: "unauthorized" }, 401);

    let userId = await this.ctx.storage.get<string>(key.userToken(tokenHash));
    if (!userId) {
      const session = await this.ctx.storage.get<UserSessionRecord>(
        key.userSession(tokenHash),
      );
      if (session && !isExpired(session.expiresAt)) {
        userId = session.userId;
      } else if (session) {
        await this.ctx.storage.delete(key.userSession(tokenHash));
      }
    }

    if (!userId) {
      const resource = String(body?.resource ?? "");
      const access = await this.ctx.storage.get<OAuthTokenRecord>(
        key.oauthAccess(tokenHash),
      );
      if (!access || isExpired(access.expiresAt) ||
          !resource || access.resource !== resource ||
          !access.scope.includes("mcp")) {
        if (access && isExpired(access.expiresAt)) {
          await this.ctx.storage.delete(key.oauthAccess(tokenHash));
        }
        return json({ error: "unauthorized" }, 401);
      }
      userId = access.userId;
    }

    const user = await this.ctx.storage.get<UserRecord>(key.user(userId));
    if (!user?.enabled) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, user: publicUser(user) });
  }

  private async authAgent(body: any): Promise<Response> {
    const tokenHash = String(body?.tokenHash ?? "");
    const requestedId = String(body?.agentId ?? "");
    const agentId = await this.ctx.storage.get<string>(key.agentToken(tokenHash));
    if (!agentId || agentId !== requestedId) return json({ error: "unauthorized" }, 401);
    const agent = await this.ctx.storage.get<AgentRecord>(key.agent(agentId));
    if (!agent?.enabled) return json({ error: "unauthorized" }, 401);
    agent.lastSeenAt = new Date().toISOString();
    await this.ctx.storage.put(key.agent(agent.id), agent);
    return json({ ok: true, agent: { id: agent.id, name: agent.name } });
  }

  private async listAgents(body: any): Promise<Response> {
    const userId = String(body?.userId ?? "");
    const grants = await this.ctx.storage.list<GrantRecord>({ prefix: `grant:${userId}:` });
    const result = [];
    for (const grant of grants.values()) {
      const agent = await this.ctx.storage.get<AgentRecord>(key.agent(grant.agentId));
      if (!agent?.enabled) continue;
      result.push({
        id: agent.id,
        name: agent.name,
        scopes: grant.scopes,
        lastSeenAt: agent.lastSeenAt ?? null,
      });
    }
    return json({ ok: true, agents: result });
  }

  private async resolveAgent(body: any): Promise<Response> {
    const userId = String(body?.userId ?? "");
    const requestedId = body?.agentId ? String(body.agentId) : null;
    const scope = String(body?.scope ?? "read");
    const grants = await this.ctx.storage.list<GrantRecord>({ prefix: `grant:${userId}:` });

    const candidates: Array<{ agent: AgentRecord; grant: GrantRecord }> = [];
    for (const grant of grants.values()) {
      if (!hasScope(grant, scope)) continue;
      const agent = await this.ctx.storage.get<AgentRecord>(key.agent(grant.agentId));
      if (!agent?.enabled) continue;
      if (requestedId && agent.id !== requestedId) continue;
      candidates.push({ agent, grant });
    }

    if (requestedId && candidates.length === 0) return json({ error: "permission_denied" }, 403);
    if (!requestedId && candidates.length === 0) return json({ error: "no_agent" }, 404);
    if (!requestedId && candidates.length > 1) {
      return json({
        error: "agent_required",
        agents: candidates.map(({ agent }) => ({ id: agent.id, name: agent.name })),
      }, 409);
    }

    const { agent, grant } = candidates[0];
    return json({
      ok: true,
      agent: { id: agent.id, name: agent.name, lastSeenAt: agent.lastSeenAt ?? null },
      scopes: grant.scopes,
    });
  }

  private async state(): Promise<Response> {
    const [users, agents, grants] = await Promise.all([
      this.ctx.storage.list<UserRecord>({ prefix: "user:" }),
      this.ctx.storage.list<AgentRecord>({ prefix: "agent:" }),
      this.ctx.storage.list<GrantRecord>({ prefix: "grant:" }),
    ]);
    return json({
      ok: true,
      users: [...users.values()].map((user) => publicUser(user)),
      agents: [...agents.values()].map(({ tokenHash: _tokenHash, ...agent }) => agent),
      grants: [...grants.values()],
    });
  }
}
