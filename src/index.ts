import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleDeviceAuth } from "./device-auth";
import { handleOAuth, oauthChallenge, oauthResource } from "./oauth";
import { Registry, hashToken, newToken, normalizeAgentId, type Scope } from "./registry";

export { Registry };

interface Env {
  RELAY: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
}

type Pending = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type AuthUser = { id: string; name: string };

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;
const error = (status: number, code: string, details?: unknown) =>
  Response.json({ error: code, ...(details === undefined ? {} : { details }) }, { status });

const authorized = (request: Request, token: string) =>
  request.headers.get("authorization") === `Bearer ${token}`;

function hasPayload(value: unknown): value is { payload: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.hasOwn(value, "payload");
}

async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

export class Relay extends DurableObject {
  private agent: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.agent = ctx.getWebSockets().at(-1) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/agent": return this.connectAgent(request);
      case "/status": return Response.json({ online: this.agent !== null });
      case "/relay": return this.relay(request);
      default: return error(404, "not_found");
    }
  }

  private connectAgent(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return error(426, "websocket_required");
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (this.agent) {
      this.agent.close(1000, "replaced");
      this.failPending(503, "agent_disconnected");
    }

    this.ctx.acceptWebSocket(server);
    this.agent = server;
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.handleMessage(socket, message);
  }

  webSocketClose(socket: WebSocket): void {
    this.disconnect(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
  }

  private handleMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (socket !== this.agent || typeof data !== "string" ||
      new TextEncoder().encode(data).byteLength > MAX_BYTES) return;

    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!hasPayload(message) || typeof (message as { requestId?: unknown }).requestId !== "string") return;

    const requestId = (message as { requestId: string }).requestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(Response.json({ requestId, payload: message.payload }));
  }

  private disconnect(socket: WebSocket): void {
    if (socket !== this.agent) return;
    this.agent = null;
    this.failPending(503, "agent_disconnected");
  }

  private failPending(status: number, code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(error(status, code));
    }
    this.pending.clear();
  }

  private async relay(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!hasPayload(body)) return error(400, "payload_required");
    if (!this.agent) return error(503, "agent_offline");

    const requestId = crypto.randomUUID();
    const agent = this.agent;

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(error(504, "agent_timeout"));
      }, TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timeout });
      try {
        agent.send(JSON.stringify({ requestId, payload: body.payload }));
      } catch {
        this.disconnect(agent);
      }
    });
  }
}

function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global"));
}

async function registryCall(env: Env, path: string, body?: unknown): Promise<Response> {
  return registryStub(env).fetch(new Request(`https://registry.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function registryJson<T = any>(env: Env, path: string, body?: unknown): Promise<{ response: Response; data: T }> {
  const response = await registryCall(env, path, body);
  const data = await response.json() as T;
  return { response, data };
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

async function authenticateUser(request: Request, env: Env): Promise<AuthUser | null> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("key");
  const headerToken = bearerToken(request);
  const token = queryToken || headerToken;
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const resource = !queryToken && headerToken && url.pathname === "/mcp"
    ? oauthResource(request)
    : undefined;
  const { response, data } = await registryJson<{ user?: AuthUser }>(env, "/auth/user", {
    tokenHash,
    ...(resource ? { resource } : {}),
  });
  return response.ok && data.user ? data.user : null;
}

async function authenticateAgent(request: Request, env: Env, agentId: string): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const tokenHash = await hashToken(token);
  const { response } = await registryJson(env, "/auth/agent", { tokenHash, agentId });
  return response.ok;
}

async function resolveAgent(
  env: Env,
  userId: string,
  scope: Scope,
  requestedAgentId?: string,
): Promise<{ ok: true; agentId: string } | { ok: false; response: Response }> {
  const { response, data } = await registryJson<any>(env, "/resolve", {
    userId,
    scope,
    agentId: requestedAgentId,
  });
  if (!response.ok) {
    return { ok: false, response: Response.json(data, { status: response.status }) };
  }
  return { ok: true, agentId: data.agent.id };
}

function scopeForAction(action: string): Scope {
  if (action.startsWith("fs.write") || action.startsWith("fs.edit") ||
      action.startsWith("fs.mkdir") || action.startsWith("fs.move") ||
      action.startsWith("fs.delete")) return "write";
  if (action.startsWith("terminal.")) return "terminal";
  if (action === "process.kill" || action === "process.list") return "process";
  return "read";
}

async function callAgent(
  env: Env,
  user: AuthUser,
  scope: Scope,
  requestedAgentId: string | undefined,
  payload: unknown,
) {
  const resolved = await resolveAgent(env, user.id, scope, requestedAgentId);
  if (!resolved.ok) {
    return { ok: false, body: await resolved.response.text() };
  }

  const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
  const response = await stub.fetch(new Request("https://relay.internal/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload }),
  }));
  const body = await response.text();

  let ok = response.ok;
  try {
    const parsed = JSON.parse(body) as { payload?: { ok?: boolean } };
    if (parsed.payload?.ok === false) ok = false;
  } catch {}

  return { ok, body };
}

function toolResult(result: { ok: boolean; body: string }) {
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text" as const, text: result.body }],
  };
}

async function listUserAgents(env: Env, user: AuthUser) {
  const { response, data } = await registryJson<any>(env, "/list-agents", { userId: user.id });
  if (!response.ok) return { ok: false, body: JSON.stringify(data) };

  const agents = await Promise.all((data.agents ?? []).map(async (agent: any) => {
    const stub = env.RELAY.get(env.RELAY.idFromName(agent.id));
    const status = await stub.fetch("https://relay.internal/status").then((r) => r.json<any>()).catch(() => ({ online: false }));
    return { ...agent, online: Boolean(status.online) };
  }));

  return { ok: true, body: JSON.stringify({ user, agents }) };
}

const agentIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/).optional();

function createMcpServer(env: Env, user: AuthUser) {
  const server = new McpServer({ name: "chat-relay", version: "0.4.0" });

  server.registerTool(
    "whoami",
    { description: "Show the authenticated relay user.", inputSchema: {} },
    async () => toolResult({ ok: true, body: JSON.stringify({ user }) }),
  );

  server.registerTool(
    "list_agents",
    { description: "List agents this user can access, including scopes and online status.", inputSchema: {} },
    async () => toolResult(await listUserAgents(env, user)),
  );

  server.registerTool(
    "ping_agent",
    {
      description: "Check whether a permitted local agent is reachable.",
      inputSchema: { agentId: agentIdSchema },
    },
    async ({ agentId }) => toolResult(await callAgent(env, user, "read", agentId, { action: "ping" })),
  );

  const register = (
    name: string,
    description: string,
    scope: Scope,
    inputSchema: Record<string, any>,
    payload: (args: any) => unknown,
    annotations?: Record<string, boolean>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: { agentId: agentIdSchema, ...inputSchema },
        ...(annotations ? { annotations } : {}),
      } as any,
      async (args: any) => toolResult(await callAgent(
        env,
        user,
        scope,
        args.agentId,
        payload(args),
      )),
    );
  };

  register("get_config", "Get local agent and machine configuration.", "read", {}, () => ({
    action: "agent.config",
  }));

  register(
    "get_recent_tool_calls",
    "Get recent calls handled by the local agent.",
    "read",
    { limit: z.number().int().min(1).max(100).optional() },
    ({ limit }) => ({ action: "agent.recentCalls", limit }),
  );

  register(
    "stat_path",
    "Get metadata for a file or directory.",
    "read",
    { path: z.string().min(1).max(2048) },
    ({ path }) => ({ action: "fs.stat", path }),
  );

  register(
    "list_directory",
    "List a directory. Depth is limited to 0-3.",
    "read",
    {
      path: z.string().min(1).max(2048),
      depth: z.number().int().min(0).max(3).optional(),
    },
    ({ path, depth }) => ({ action: "fs.list", path, depth }),
  );

  register(
    "read_file",
    "Read a UTF-8 text file by line offset and line count.",
    "read",
    {
      path: z.string().min(1).max(2048),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(1000).optional(),
    },
    ({ path, offset, length }) => ({ action: "fs.read", path, offset, length }),
  );

  register(
    "read_multiple_files",
    "Read up to 20 UTF-8 text files.",
    "read",
    { paths: z.array(z.string().min(1).max(2048)).min(1).max(20) },
    ({ paths }) => ({ action: "fs.readMany", paths }),
  );

  register(
    "start_search",
    "Search file names or text content under an allowed path. Returns a search session ID.",
    "read",
    {
      path: z.string().min(1).max(2048),
      pattern: z.string().min(1).max(300),
      searchType: z.enum(["files", "content"]).optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
    },
    ({ path, pattern, searchType, maxResults }) => ({
      action: "fs.search.start", path, pattern, searchType, maxResults,
    }),
  );

  register(
    "get_more_search_results",
    "Read a page of results from a search session.",
    "read",
    {
      sessionId: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(100).optional(),
    },
    ({ sessionId, offset, length }) => ({
      action: "fs.search.results", sessionId, offset, length,
    }),
  );

  register(
    "write_file",
    "Write or append UTF-8 text to a file.",
    "write",
    {
      path: z.string().min(1).max(2048),
      content: z.string().max(262144),
      mode: z.enum(["rewrite", "append"]).optional(),
    },
    ({ path, content, mode }) => ({ action: "fs.write", path, content, mode }),
    { destructiveHint: true },
  );

  register(
    "edit_block",
    "Replace an exact text block in a UTF-8 file.",
    "write",
    {
      path: z.string().min(1).max(2048),
      oldText: z.string().min(1).max(131072),
      newText: z.string().max(131072),
      expectedReplacements: z.number().int().min(1).max(100).optional(),
    },
    ({ path, oldText, newText, expectedReplacements }) => ({
      action: "fs.edit", path, oldText, newText, expectedReplacements,
    }),
    { destructiveHint: true },
  );

  register(
    "create_directory",
    "Create a directory recursively.",
    "write",
    { path: z.string().min(1).max(2048) },
    ({ path }) => ({ action: "fs.mkdir", path }),
  );

  register(
    "move_path",
    "Move or rename a file or directory.",
    "write",
    {
      source: z.string().min(1).max(2048),
      destination: z.string().min(1).max(2048),
    },
    ({ source, destination }) => ({ action: "fs.move", source, destination }),
    { destructiveHint: true },
  );

  register(
    "delete_path",
    "Delete a file or directory. Set recursive=true for non-empty directories.",
    "write",
    {
      path: z.string().min(1).max(2048),
      recursive: z.boolean().optional(),
    },
    ({ path, recursive }) => ({ action: "fs.delete", path, recursive }),
    { destructiveHint: true },
  );

  register(
    "list_processes",
    "List Windows processes with PID, name, command line, and executable path.",
    "process",
    { filter: z.string().max(200).optional() },
    ({ filter }) => ({ action: "process.list", filter }),
  );

  register(
    "kill_process",
    "Forcefully terminate a process tree by PID.",
    "process",
    { pid: z.number().int().min(101) },
    ({ pid }) => ({ action: "process.kill", pid }),
    { destructiveHint: true },
  );

  register(
    "terminal_exec",
    "Run one PowerShell command and wait for completion. Use for commands that finish within 20 seconds.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
      timeoutMs: z.number().int().min(1000).max(20000).optional(),
    },
    ({ command, cwd, timeoutMs }) => ({ action: "terminal.exec", command, cwd, timeoutMs }),
    { destructiveHint: true },
  );

  register(
    "terminal_start",
    "Start a long-running PowerShell command and return a terminal session ID immediately.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
    },
    ({ command, cwd }) => ({ action: "terminal.start", command, cwd }),
    { destructiveHint: true },
  );

  register(
    "terminal_start_shell",
    "Start a persistent interactive PowerShell session.",
    "terminal",
    { cwd: z.string().min(1).max(2048).optional() },
    ({ cwd }) => ({ action: "terminal.shell.start", cwd }),
    { destructiveHint: true },
  );

  register(
    "terminal_read",
    "Read buffered stdout/stderr from a terminal session. Use afterSeq for incremental reads.",
    "terminal",
    {
      sessionId: z.string().uuid(),
      afterSeq: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1024).max(24576).optional(),
    },
    ({ sessionId, afterSeq, maxChars }) => ({
      action: "terminal.read", sessionId, afterSeq, maxChars,
    }),
  );

  register(
    "terminal_write",
    "Send input to a running command or interactive shell.",
    "terminal",
    {
      sessionId: z.string().uuid(),
      input: z.string().min(1).max(8192),
      appendNewline: z.boolean().optional(),
    },
    ({ sessionId, input, appendNewline }) => ({
      action: "terminal.write", sessionId, input, appendNewline,
    }),
    { destructiveHint: true },
  );

  register(
    "terminal_list",
    "List running and recently completed terminal sessions.",
    "terminal",
    {},
    () => ({ action: "terminal.list" }),
  );

  register(
    "terminal_kill",
    "Terminate a terminal session and its child process tree.",
    "terminal",
    { sessionId: z.string().uuid() },
    ({ sessionId }) => ({ action: "terminal.kill", sessionId }),
    { destructiveHint: true },
  );

  register(
    "start_process",
    "Desktop-Commander-compatible alias for starting a long-running command.",
    "terminal",
    {
      command: z.string().min(1).max(4000),
      cwd: z.string().min(1).max(2048).optional(),
    },
    ({ command, cwd }) => ({ action: "terminal.start", command, cwd }),
    { destructiveHint: true },
  );

  register(
    "read_process_output",
    "Desktop-Commander-compatible alias for reading session output.",
    "terminal",
    {
      sessionId: z.string().uuid(),
      afterSeq: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1024).max(24576).optional(),
    },
    ({ sessionId, afterSeq, maxChars }) => ({
      action: "terminal.read", sessionId, afterSeq, maxChars,
    }),
  );

  register(
    "interact_with_process",
    "Desktop-Commander-compatible alias for sending input to a terminal session.",
    "terminal",
    {
      sessionId: z.string().uuid(),
      input: z.string().min(1).max(8192),
      appendNewline: z.boolean().optional(),
    },
    ({ sessionId, input, appendNewline }) => ({
      action: "terminal.write", sessionId, input, appendNewline,
    }),
    { destructiveHint: true },
  );

  register(
    "list_sessions",
    "Desktop-Commander-compatible alias for listing terminal sessions.",
    "terminal",
    {},
    () => ({ action: "terminal.list" }),
  );

  register(
    "force_terminate",
    "Desktop-Commander-compatible alias for terminating a terminal session.",
    "terminal",
    { sessionId: z.string().uuid() },
    ({ sessionId }) => ({ action: "terminal.kill", sessionId }),
    { destructiveHint: true },
  );

  return server;
}

function generatedId(name: string, fallback: string) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
  return `${slug.slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function adminHandler(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || !authorized(request, env.ADMIN_TOKEN)) {
    return error(401, "unauthorized");
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const body = request.method === "GET" ? null : await request.json<any>().catch(() => null);

  if (path === "/admin/bootstrap" && request.method === "POST") {
    if (!env.CALLER_TOKEN || !env.AGENT_TOKEN) return error(503, "legacy_tokens_missing");
    const response = await registryCall(env, "/bootstrap", {
      userTokenHash: await hashToken(env.CALLER_TOKEN),
      agentTokenHash: await hashToken(env.AGENT_TOKEN),
      userName: body?.userName || "Owner",
      agentId: body?.agentId || "default",
      agentName: body?.agentName || "Primary PC",
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/users" && request.method === "POST") {
    const name = String(body?.name ?? "").trim();
    if (!name) return error(400, "name_required");
    const id = String(body?.id || generatedId(name, "user"));
    const token = newToken("usr");
    const response = await registryCall(env, "/users/create", {
      id,
      name,
      tokenHash: await hashToken(token),
    });
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
    const response = await registryCall(env, "/agents/create", {
      id,
      name,
      tokenHash: await hashToken(token),
    });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/grants" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const agentId = String(body?.agentId ?? "");
    const scopes = Array.isArray(body?.scopes) ? body.scopes : [];
    const response = await registryCall(env, "/grants/upsert", { userId, agentId, scopes });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/grants/delete" && request.method === "POST") {
    const response = await registryCall(env, "/grants/delete", {
      userId: String(body?.userId ?? ""),
      agentId: String(body?.agentId ?? ""),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/users/login" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    const login = String(body?.login ?? "");
    const password = String(body?.password ?? "");
    if (!userId || !login || !password) return error(400, "credentials_required");
    const response = await registryCall(env, "/users/set-login", { userId, login, password });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  if (path === "/admin/users/enabled" && request.method === "POST") {
    const response = await registryCall(env, "/users/set-enabled", {
      userId: String(body?.userId ?? ""),
      enabled: Boolean(body?.enabled),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/agents/enabled" && request.method === "POST") {
    const response = await registryCall(env, "/agents/set-enabled", {
      agentId: String(body?.agentId ?? ""),
      enabled: Boolean(body?.enabled),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  if (path === "/admin/users/rotate" && request.method === "POST") {
    const userId = String(body?.userId ?? "");
    if (!userId) return error(400, "user_id_required");
    const token = newToken("usr");
    const response = await registryCall(env, "/users/rotate", {
      userId,
      tokenHash: await hashToken(token),
    });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/agents/rotate" && request.method === "POST") {
    const agentId = String(body?.agentId ?? "");
    if (!agentId) return error(400, "agent_id_required");
    const token = newToken("agt");
    const response = await registryCall(env, "/agents/rotate", {
      agentId,
      tokenHash: await hashToken(token),
    });
    const data = await response.json<any>();
    return Response.json(response.ok ? { ...data, token } : data, { status: response.status });
  }

  if (path === "/admin/state" && request.method === "GET") {
    const response = await registryCall(env, "/state");
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  return error(404, "not_found");
}

async function handleDirectRelay(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId") || undefined;
  let body: unknown;
  try { body = await readJson(request); }
  catch (cause) {
    const code = cause instanceof Error && cause.message === "payload_too_large"
      ? "payload_too_large" : "invalid_json";
    return error(code === "payload_too_large" ? 413 : 400, code);
  }
  if (!hasPayload(body)) return error(400, "payload_required");

  const action = typeof body.payload === "object" && body.payload !== null
    ? String((body.payload as any).action ?? "")
    : "";
  const scope = scopeForAction(action);
  const resolved = await resolveAgent(env, user.id, scope, agentId);
  if (!resolved.ok) return resolved.response;

  const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
  return stub.fetch(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return request.method === "GET"
        ? Response.json({ status: "ok", service: "chat-relay", version: "0.6.0" })
        : error(405, "method_not_allowed");
    }

    const oauthResponse = await handleOAuth(
      request,
      (registryPath, body) => registryCall(env, registryPath, body),
    );
    if (oauthResponse) return oauthResponse;

    const authResponse = await handleDeviceAuth(
      request,
      (registryPath, body) => registryCall(env, registryPath, body),
      (authRequest) => authenticateUser(authRequest, env),
    );
    if (authResponse) return authResponse;

    if (path.startsWith("/admin/")) {
      return adminHandler(request, env);
    }

    if (path === "/agent") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const agentId = url.searchParams.get("agentId");
      if (!agentId) return error(400, "agent_id_required");
      if (!(await authenticateAgent(request, env, agentId))) return error(401, "unauthorized");

      const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
      return stub.fetch(request);
    }

    if (path === "/mcp") {
      const user = await authenticateUser(request, env);
      if (!user) {
        return Response.json(
          { error: "unauthorized" },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": oauthChallenge(url.origin),
              "cache-control": "no-store",
            },
          },
        );
      }

      return createMcpHandler(() => createMcpServer(env, user), {
        route: "/mcp",
        responseMode: "json",
      })(request, env, ctx);
    }

    if (path === "/status") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const user = await authenticateUser(request, env);
      if (!user) return error(401, "unauthorized");

      const requestedAgentId = url.searchParams.get("agentId") || undefined;
      const resolved = await resolveAgent(env, user.id, "read", requestedAgentId);
      if (!resolved.ok) return resolved.response;

      const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
      const status = await stub.fetch("https://relay.internal/status");
      const data = await status.json<any>();
      return Response.json({ agentId: resolved.agentId, ...data });
    }

    if (path === "/relay") {
      if (request.method !== "POST") return error(405, "method_not_allowed");
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        return error(415, "json_required");
      }
      const user = await authenticateUser(request, env);
      if (!user) return error(401, "unauthorized");
      return handleDirectRelay(request, env, user);
    }

    return error(404, "not_found");
  },
};
