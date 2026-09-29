import { DurableObject } from "cloudflare:workers";

export type Scope = "read" | "write" | "terminal" | "process" | "admin";
export type UserRecord = {
  id: string;
  name: string;
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
};
export type AgentRecord = {
  id: string;
  name: string;
  tokenHash: string;
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

const json = (value: unknown, status = 200) => Response.json(value, { status });
const key = {
  user: (id: string) => `user:${id}`,
  userToken: (hash: string) => `ut:${hash}`,
  agent: (id: string) => `agent:${id}`,
  agentToken: (hash: string) => `at:${hash}`,
  grant: (userId: string, agentId: string) => `grant:${userId}:${agentId}`,
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
      case "/agents/set-enabled": return this.setAgentEnabled(body);
      case "/users/rotate": return this.rotateUser(body);
      case "/agents/rotate": return this.rotateAgent(body);
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
    if (existing) return json({ ok: true, alreadyBootstrapped: true });

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

  private async authUser(body: any): Promise<Response> {
    const tokenHash = String(body?.tokenHash ?? "");
    const userId = await this.ctx.storage.get<string>(key.userToken(tokenHash));
    if (!userId) return json({ error: "unauthorized" }, 401);
    const user = await this.ctx.storage.get<UserRecord>(key.user(userId));
    if (!user?.enabled) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, user: { id: user.id, name: user.name } });
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
      users: [...users.values()].map(({ tokenHash: _tokenHash, ...user }) => user),
      agents: [...agents.values()].map(({ tokenHash: _tokenHash, ...agent }) => agent),
      grants: [...grants.values()],
    });
  }
}
