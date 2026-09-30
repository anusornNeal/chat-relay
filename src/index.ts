import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { handleDeviceAuth } from "./device-auth";
import { handleOAuth, oauthChallenge, oauthResource } from "./oauth";
import { handleAdmin } from "./admin";
import { Audit } from "./audit";
import { Registry, hashToken, newToken, normalizeAgentId, type Scope } from "./registry";
import { DEFAULT_QUOTA_POLICY, Usage, normalizeQuotaPolicy, type QuotaPolicy, type UsageEvent } from "./usage";

export { Audit, Registry, Usage };

interface Env {
  RELAY: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  AUDIT: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ADMIN_TOKEN?: string;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
  USER_RATE_LIMIT_PER_WINDOW?: string;
  USER_RATE_WINDOW_SECONDS?: string;
  USER_DAILY_CALL_QUOTA?: string;
  USAGE_RAW_RETENTION_DAYS?: string;
  AUDIT_RETENTION_DAYS?: string;
  OPENAI_APPS_CHALLENGE?: string;
  PUBLIC_BASE_URL?: string;
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
    const path = new URL(request.url).pathname;
    if (path.startsWith("/temp-shot/")) {
      return this.getTempShot(path.slice("/temp-shot/".length));
    }
    switch (path) {
      case "/agent": return this.connectAgent(request);
      case "/status": return Response.json({ online: this.agent !== null });
      case "/disconnect": return this.disconnectAgent();
      case "/relay": return this.relay(request);
      case "/temp-shot": return this.storeTempShot(request);
      default: return error(404, "not_found");
    }
  }

  async alarm(): Promise<void> {
    await this.cleanupTempShots();
  }

  private async storeTempShot(request: Request): Promise<Response> {
    if (request.method !== "POST") return error(405, "method_not_allowed");

    let body: any;
    try { body = await request.json(); }
    catch { return error(400, "invalid_json"); }

    if (body?.mimeType !== "image/jpeg" || typeof body.data !== "string") {
      return error(400, "invalid_screenshot");
    }

    let byteLength = 0;
    try { byteLength = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0)).byteLength; }
    catch { return error(400, "invalid_screenshot"); }
    if (byteLength <= 0 || byteLength > MAX_BYTES) {
      return error(413, "screenshot_too_large", { maxBytes: MAX_BYTES });
    }

    const token = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + 5 * 60 * 1000;
    await this.ctx.storage.put("temp-shot:" + token, {
      mimeType: body.mimeType,
      data: body.data,
      expiresAt,
    });

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
    }

    return Response.json({ ok: true, token, expiresAt });
  }

  private async getTempShot(token: string): Promise<Response> {
    if (!/^[a-f0-9]{32}$/.test(token)) return error(404, "not_found");

    const key = "temp-shot:" + token;
    const shot = await this.ctx.storage.get<any>(key);
    if (!shot) return error(404, "not_found");

    if (typeof shot.expiresAt !== "number" || Date.now() >= shot.expiresAt) {
      await this.ctx.storage.delete(key);
      return error(410, "expired");
    }

    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)); }
    catch {
      await this.ctx.storage.delete(key);
      return error(500, "invalid_screenshot");
    }

    return new Response(bytes, {
      headers: {
        "content-type": shot.mimeType || "image/jpeg",
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private async cleanupTempShots(): Promise<void> {
    const entries = await this.ctx.storage.list<any>({ prefix: "temp-shot:" });
    const now = Date.now();
    let nextExpiry: number | null = null;

    for (const [key, shot] of entries) {
      const expiresAt = typeof shot?.expiresAt === "number" ? shot.expiresAt : 0;
      if (expiresAt <= now) {
        await this.ctx.storage.delete(key);
      } else if (nextExpiry === null || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }

    if (nextExpiry === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(nextExpiry);
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

  private disconnectAgent(): Response {
    const sockets = [...new Set([
      ...(this.agent ? [this.agent] : []),
      ...this.ctx.getWebSockets(),
    ])];
    this.agent = null;
    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify({ control: "credential_revoked" }));
        setTimeout(() => {
          try { socket.close(4001, "credential_revoked"); } catch {}
        }, 250);
      } catch {
        try { socket.close(4001, "credential_revoked"); } catch {}
      }
    }
    this.failPending(503, "agent_disconnected");
    return Response.json({ ok: true, disconnected: sockets.length });
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
    if (socket !== this.agent || typeof data !== "string") return;

    if (new TextEncoder().encode(data).byteLength > MAX_BYTES) {
      const requestId = data.slice(0, 256).match(/"requestId"\s*:\s*"([^"]+)"/)?.[1];
      if (!requestId) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.resolve(error(502, "agent_response_too_large", { maxBytes: MAX_BYTES }));
      return;
    }

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


function usageStub(env: Env) {
  return env.USAGE.get(env.USAGE.idFromName("global"));
}

function byteSize(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return 0; }
}

type ToolActivityContext = {
  toolCallId: string;
  activityId?: string;
  startedAt: string;
};

const toolActivityContexts = new WeakMap<object, ToolActivityContext>();

async function activityContextForRequest(request: Request): Promise<ToolActivityContext> {
  const source = [
    "mcp-session-id",
    "x-openai-conversation-id",
    "x-openai-chat-id",
    "x-chatgpt-conversation-id",
  ].map((name) => request.headers.get(name)?.trim()).find(Boolean);
  const activityId = source
    ? "act_" + (await hashToken("chat-relay-activity:" + source)).slice(0, 20)
    : undefined;
  return {
    toolCallId: "tc_" + crypto.randomUUID().replace(/-/g, ""),
    ...(activityId ? { activityId } : {}),
    startedAt: new Date().toISOString(),
  };
}

async function beginUsage(env: Env, event: {
  userId: string;
  tool: string;
  agentId?: string;
  toolCallId: string;
  activityId?: string;
  startedAt: string;
}): Promise<void> {
  try {
    await usageStub(env).fetch(new Request("https://usage.internal/activity/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
  } catch {}
}

async function recordUsage(env: Env, event: UsageEvent): Promise<void> {
  try {
    await usageStub(env).fetch(new Request("https://usage.internal/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
  } catch {}
}

type QuotaDecision = {
  allowed: boolean;
  code?: string;
  retryAt?: string;
  resetAt?: string;
  remaining?: number;
  policy?: QuotaPolicy;
};

function quotaDefaults(env: Env): QuotaPolicy {
  return normalizeQuotaPolicy({
    rateLimit: Number(env.USER_RATE_LIMIT_PER_WINDOW),
    rateWindowSeconds: Number(env.USER_RATE_WINDOW_SECONDS),
    dailyCallQuota: Number(env.USER_DAILY_CALL_QUOTA),
  }, DEFAULT_QUOTA_POLICY);
}

async function inspectMcpToolCall(request: Request) {
  if (request.method !== "POST") return null;
  const body = await request.clone().json<any>().catch(() => null);
  if (!body || Array.isArray(body) || body.method !== "tools/call") return null;
  const tool = typeof body.params?.name === "string" ? body.params.name : "";
  if (!tool) return null;
  const args = body.params?.arguments ?? {};
  return {
    tool: tool.slice(0, 160),
    args,
    ...(typeof args?.agentId === "string" ? { agentId: args.agentId.slice(0, 128) } : {}),
  };
}

async function enforceMcpQuota(request: Request, env: Env, user: AuthUser): Promise<Response | null> {
  const call = await inspectMcpToolCall(request);
  if (!call) return null;
  let response: Response;
  try {
    response = await usageStub(env).fetch(new Request("https://usage.internal/quota/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: user.id, defaultPolicy: quotaDefaults(env) }),
    }));
  } catch {
    return error(503, "quota_unavailable");
  }
  if (!response.ok) return error(503, "quota_unavailable");
  const decision = await response.json<QuotaDecision>();
  if (decision.allowed) return null;

  const code = decision.code === "quota_exceeded" ? "quota_exceeded" : "rate_limited";
  const activity = toolActivityContexts.get(user);
  await recordUsage(env, {
    userId: user.id,
    tool: call.tool,
    ...(call.agentId ? { agentId: call.agentId } : {}),
    ...(activity?.toolCallId ? { toolCallId: activity.toolCallId } : {}),
    ...(activity?.activityId ? { activityId: activity.activityId } : {}),
    ...(activity?.startedAt ? { startedAt: activity.startedAt } : {}),
    timestamp: new Date().toISOString(),
    durationMs: 0,
    ok: false,
    errorClass: code,
    statusCode: 429,
    requestBytes: byteSize(call.args),
    responseBytes: 0,
  });
  const retryAt = decision.retryAt || decision.resetAt;
  const retryAtMs = retryAt ? Date.parse(retryAt) : NaN;
  const retryAfter = Number.isFinite(retryAtMs)
    ? Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))
    : 1;
  return Response.json({
    error: code,
    ...(decision.retryAt ? { retryAt: decision.retryAt } : {}),
    ...(decision.resetAt ? { resetAt: decision.resetAt } : {}),
    remaining: decision.remaining ?? 0,
  }, {
    status: 429,
    headers: {
      "retry-after": String(retryAfter),
      "cache-control": "no-store",
    },
  });
}

async function instrumentTool<T>(
  env: Env,
  user: AuthUser,
  tool: string,
  args: unknown,
  run: () => Promise<{ value: T; ok: boolean; agentId?: string; errorClass?: string; statusCode?: number; exitCode?: number | null }>,
): Promise<T> {
  const started = Date.now();
  const activity = toolActivityContexts.get(user) ?? {
    toolCallId: "tc_" + crypto.randomUUID().replace(/-/g, ""),
    startedAt: new Date().toISOString(),
  };
  const requestedAgentId = typeof args === "object" && args !== null && typeof (args as any).agentId === "string"
    ? String((args as any).agentId).slice(0, 128)
    : undefined;
  await beginUsage(env, {
    userId: user.id,
    tool,
    ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
    toolCallId: activity.toolCallId,
    ...(activity.activityId ? { activityId: activity.activityId } : {}),
    startedAt: activity.startedAt,
  });
  let outcome: { value: T; ok: boolean; agentId?: string; errorClass?: string; statusCode?: number; exitCode?: number | null } | undefined;
  try {
    outcome = await run();
    return outcome.value;
  } catch (cause) {
    await recordUsage(env, {
      userId: user.id,
      tool,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      toolCallId: activity.toolCallId,
      ...(activity.activityId ? { activityId: activity.activityId } : {}),
      startedAt: activity.startedAt,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: false,
      errorClass: cause instanceof Error ? cause.name.slice(0, 80) : "exception",
      requestBytes: byteSize(args),
      responseBytes: 0,
    });
    throw cause;
  } finally {
    if (outcome) {
      await recordUsage(env, {
        userId: user.id,
        tool,
        ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
        toolCallId: activity.toolCallId,
        ...(activity.activityId ? { activityId: activity.activityId } : {}),
        startedAt: activity.startedAt,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        ok: outcome.ok,
        ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        ...(Number.isFinite(outcome.statusCode) ? { statusCode: outcome.statusCode } : {}),
        ...(outcome.exitCode === null || Number.isFinite(outcome.exitCode) ? { exitCode: outcome.exitCode } : {}),
        requestBytes: byteSize(args),
        responseBytes: byteSize(outcome.value),
      });
    }
  }
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
  if (action === "desktop.screenshot") return "desktop_read";
  if (action === "desktop.mouse.click" || action === "desktop.keyboard.input") return "desktop_control";
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
    return { ok: false, body: await resolved.response.text(), agentId: requestedAgentId, statusCode: resolved.response.status };
  }

  const stub = env.RELAY.get(env.RELAY.idFromName(resolved.agentId));
  const response = await stub.fetch(new Request("https://relay.internal/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload }),
  }));
  const body = await response.text();

  let ok = response.ok;
  let exitCode: number | null | undefined;
  try {
    const parsed = JSON.parse(body) as { payload?: { ok?: boolean; exitCode?: unknown } };
    if (parsed.payload?.ok === false) ok = false;
    if (parsed.payload?.exitCode === null) exitCode = null;
    else if (Number.isFinite(Number(parsed.payload?.exitCode))) exitCode = Number(parsed.payload?.exitCode);
  } catch {}

  return { ok, body, agentId: resolved.agentId, statusCode: response.status, ...(exitCode === undefined ? {} : { exitCode }) };
}

function toolResult(result: { ok: boolean; body: string }) {
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text" as const, text: result.body }],
  };
}

async function screenshotToolResult(env: Env, agentId: string | undefined, result: { ok: boolean; body: string }) {
  if (!result.ok) return toolResult(result);
  try {
    const envelope = JSON.parse(result.body) as { payload?: any };
    const payload = envelope?.payload;
    if (!payload?.ok || payload.mimeType !== "image/jpeg" || typeof payload.data !== "string" || !agentId) {
      return toolResult({ ok: false, body: JSON.stringify({ error: payload?.error || "invalid_screenshot_result" }) });
    }

    const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
    const stored = await stub.fetch(new Request("https://relay.internal/temp-shot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: payload.mimeType, data: payload.data }),
    }));
    if (!stored.ok) {
      return toolResult({ ok: false, body: JSON.stringify({ error: "temp_screenshot_store_failed" }) });
    }

    const temp = await stored.json<any>();
    const tempPath = "/tmp-shot/" + encodeURIComponent(agentId) + "/" + temp.token;
    const baseUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const metadata = {
      width: payload.width,
      height: payload.height,
      desktopOriginX: payload.desktopOriginX,
      desktopOriginY: payload.desktopOriginY,
      desktopWidth: payload.desktopWidth,
      desktopHeight: payload.desktopHeight,
      scaleX: payload.scaleX,
      scaleY: payload.scaleY,
      byteLength: payload.byteLength,
      monitorIndex: payload.monitorIndex,
      isPrimary: payload.isPrimary === true,
      deviceName: payload.deviceName,
      tempUrl: baseUrl ? baseUrl + tempPath : tempPath,
      expiresAt: new Date(temp.expiresAt).toISOString(),
      expiresInSeconds: 300,
    };

    return {
      structuredContent: metadata,
      content: [{ type: "text" as const, text: JSON.stringify(metadata) }],
    };
  } catch {
    return toolResult({ ok: false, body: JSON.stringify({ error: "invalid_screenshot_result" }) });
  }
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

const READ_ONLY_TOOLS = new Set([
  "whoami", "list_agents", "ping_agent", "get_config", "get_recent_tool_calls",
  "stat_path", "list_directory", "read_file", "read_multiple_files",
  "start_search", "get_more_search_results", "list_processes", "screenshot",
  "terminal_read", "terminal_list", "terminal_batch_status", "terminal_batch_read", "read_process_output", "list_sessions",
]);

const OPEN_WORLD_TOOLS = new Set([
  "mouse_click", "keyboard_input",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_write",
  "terminal_batch_start", "terminal_batch_cancel",
  "start_process", "interact_with_process",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "write_file", "edit_block", "move_path", "delete_path", "kill_process",
  "mouse_click", "keyboard_input",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_write", "terminal_kill",
  "terminal_batch_start", "terminal_batch_cancel",
  "start_process", "interact_with_process", "force_terminate",
]);

function annotationsForTool(name: string, override: Record<string, boolean> = {}) {
  return {
    readOnlyHint: READ_ONLY_TOOLS.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    ...override,
  };
}

const SCREENSHOT_UI_URI = "ui://chat-relay/screenshot-v3.html";

function createMcpServer(env: Env, user: AuthUser) {
  const server = new McpServer({ name: "chat-relay", version: "0.7.0" });

  server.registerTool(
    "whoami",
    { description: "Show the authenticated relay user.", inputSchema: {}, annotations: annotationsForTool("whoami") } as any,
    async () => instrumentTool(env, user, "whoami", {}, async () => {
      const value = toolResult({ ok: true, body: JSON.stringify({ user }) });
      return { value, ok: true };
    }),
  );

  server.registerTool(
    "list_agents",
    { description: "List agents this user can access, including scopes and online status.", inputSchema: {}, annotations: annotationsForTool("list_agents") } as any,
    async () => instrumentTool(env, user, "list_agents", {}, async () => {
      const call = await listUserAgents(env, user);
      return { value: toolResult(call), ok: call.ok };
    }),
  );

  server.registerTool(
    "ping_agent",
    {
      description: "Check whether a permitted local agent is reachable.",
      inputSchema: { agentId: agentIdSchema },
      annotations: annotationsForTool("ping_agent"),
    } as any,
    async ({ agentId }) => instrumentTool(env, user, "ping_agent", { agentId }, async () => {
      const call = await callAgent(env, user, "read", agentId, { action: "ping" });
      return { value: toolResult(call), ok: call.ok, agentId: call.agentId };
    }),
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
        annotations: annotationsForTool(name, annotations),
      } as any,
      async (args: any) => instrumentTool(env, user, name, args, async () => {
        const agentPayload = payload(args) as any;
        const activity = toolActivityContexts.get(user);
        if (agentPayload && ["terminal.start", "terminal.shell.start", "terminal.batch.start"].includes(agentPayload.action)) {
          agentPayload.observability = {
            userId: user.id,
            ...(activity?.activityId ? { activityId: activity.activityId } : {}),
            ...(activity?.toolCallId ? { toolCallId: activity.toolCallId } : {}),
          };
        }
        const call = await callAgent(env, user, scope, args.agentId, agentPayload);
        return {
          value: toolResult(call),
          ok: call.ok,
          agentId: call.agentId,
          statusCode: call.statusCode,
          ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }),
          ...(call.ok ? {} : { errorClass: "tool_error" }),
        };
      }),
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
    "Read a UTF-8 text file by line offset/count with a bounded response and deterministic nextOffset.",
    "read",
    {
      path: z.string().min(1).max(2048),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().min(1).max(1000).optional(),
      maxBytes: z.number().int().min(1024).max(49152).optional(),
    },
    ({ path, offset, length, maxBytes }) => ({
      action: "fs.read", path, offset, length, maxBytes,
    }),
  );

  register(
    "read_multiple_files",
    "Read up to 20 UTF-8 text files with one aggregate response budget. String paths remain supported; object entries can set offset, length, and maxBytes.",
    "read",
    {
      paths: z.array(z.union([
        z.string().min(1).max(2048),
        z.object({
          path: z.string().min(1).max(2048),
          offset: z.number().int().min(0).optional(),
          length: z.number().int().min(1).max(1000).optional(),
          maxBytes: z.number().int().min(1024).max(49152).optional(),
        }),
      ])).min(1).max(20),
      maxTotalBytes: z.number().int().min(4096).max(49152).optional(),
    },
    ({ paths, maxTotalBytes }) => ({ action: "fs.readMany", paths, maxTotalBytes }),
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

  server.registerTool(
    "screenshot",
    {
      description: "Capture a Windows monitor and return a temporary JPEG URL valid for 5 minutes. monitor can be primary, secondary, or a zero-based monitor index. Requires local desktop opt-in and desktop_read permission.",
      inputSchema: {
        agentId: agentIdSchema,
        monitor: z.union([z.enum(["primary", "secondary"]), z.number().int().min(0).max(15)]).optional(),
      },
      annotations: annotationsForTool("screenshot"),
    } as any,
    async ({ agentId, monitor }: any) => instrumentTool(env, user, "screenshot", { agentId, monitor }, async () => {
      const call = await callAgent(env, user, "desktop_read", agentId, { action: "desktop.screenshot", monitor });
      return {
        value: await screenshotToolResult(env, call.agentId, call),
        ok: call.ok,
        agentId: call.agentId,
        ...(call.ok ? {} : { errorClass: "tool_error" }),
      };
    }),
  );

  register(
    "mouse_click",
    "Click a primary-desktop coordinate on the connected Windows PC. Coordinates use the desktop space described by screenshot metadata.",
    "desktop_control",
    {
      x: z.number().int().min(-32768).max(32767),
      y: z.number().int().min(-32768).max(32767),
      button: z.enum(["left", "right", "middle"]).optional(),
      clicks: z.union([z.literal(1), z.literal(2)]).optional(),
    },
    ({ x, y, button, clicks }) => ({ action: "desktop.mouse.click", x, y, button, clicks }),
    { destructiveHint: true },
  );

  register(
    "keyboard_input",
    "Type Unicode text or send one named key/modifier chord to the active Windows desktop. Supply text or key, not both.",
    "desktop_control",
    {
      text: z.string().min(1).max(8192).optional(),
      key: z.enum([
        "Enter", "Tab", "Escape", "Backspace", "Delete",
        "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
        "Home", "End", "PageUp", "PageDown", "Space",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
      ]).optional(),
      ctrl: z.boolean().optional(),
      alt: z.boolean().optional(),
      shift: z.boolean().optional(),
      win: z.boolean().optional(),
    },
    ({ text, key, ctrl, alt, shift, win }) => ({ action: "desktop.keyboard.input", text, key, ctrl, alt, shift, win }),
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
    "terminal_batch_start",
    "Start 2-20 PowerShell jobs in one MCP call with bounded per-agent concurrency and queue backpressure.",
    "terminal",
    {
      jobs: z.array(z.union([
        z.string().min(1).max(4000),
        z.object({ command: z.string().min(1).max(4000), cwd: z.string().min(1).max(2048).optional(), timeoutMs: z.number().int().min(1000).max(20000).optional() }),
      ])).min(2).max(20),
      cwd: z.string().min(1).max(2048).optional(),
      timeoutMs: z.number().int().min(1000).max(20000).optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
    },
    ({ jobs, cwd, timeoutMs, concurrency }) => ({ action: "terminal.batch.start", jobs, cwd, timeoutMs, concurrency }),
    { destructiveHint: true },
  );

  register(
    "terminal_batch_status",
    "Read bounded status for a terminal batch without command output.",
    "terminal",
    { batchId: z.string().uuid() },
    ({ batchId }) => ({ action: "terminal.batch.status", batchId }),
  );

  register(
    "terminal_batch_read",
    "Read bounded stdout/stderr and status for a terminal batch.",
    "terminal",
    { batchId: z.string().uuid(), maxChars: z.number().int().min(1024).max(24576).optional() },
    ({ batchId, maxChars }) => ({ action: "terminal.batch.read", batchId, maxChars }),
  );

  register(
    "terminal_batch_cancel",
    "Cancel queued and running jobs in a terminal batch.",
    "terminal",
    { batchId: z.string().uuid() },
    ({ batchId }) => ({ action: "terminal.batch.cancel", batchId }),
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

    if (path.startsWith("/tmp-shot/")) {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const parts = path.split("/").filter(Boolean);
      if (parts.length !== 3) return error(404, "not_found");

      const agentId = decodeURIComponent(parts[1]);
      const token = parts[2];
      if (!/^[a-z0-9_-]{1,64}$/.test(agentId) || !/^[a-f0-9]{32}$/.test(token)) {
        return error(404, "not_found");
      }

      const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
      return stub.fetch("https://relay.internal/temp-shot/" + token);
    }

    if (path === "/dashboard" && env.ASSETS) {
      return Response.redirect(url.origin + "/dashboard/", 302);
    }
    if (path.startsWith("/dashboard/") && env.ASSETS) {
      const assetPath = path.slice("/dashboard".length) || "/index.html";
      const resolvedPath = assetPath === "/" ? "/" : assetPath;
      return env.ASSETS.fetch(new Request(url.origin + resolvedPath, request));
    }

    if (path === "/health") {
      return request.method === "GET"
        ? Response.json({ status: "ok", service: "chat-relay", version: "0.7.0" })
        : error(405, "method_not_allowed");
    }

    if (path === "/.well-known/openai-apps-challenge") {
      if (request.method !== "GET") return error(405, "method_not_allowed");
      const token = String(env.OPENAI_APPS_CHALLENGE || "").trim();
      if (!token) return error(404, "not_found");
      return new Response(token, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
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
      return handleAdmin(request, env);
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

      toolActivityContexts.set(user, await activityContextForRequest(request));
      const quotaResponse = await enforceMcpQuota(request, env, user);
      if (quotaResponse) return quotaResponse;

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
      let agentId = requestedAgentId;
      if (!agentId) {
        const resolved = await resolveAgent(env, user.id, "read");
        if (!resolved.ok) return resolved.response;
        agentId = resolved.agentId;
      }

      const access = await registryJson<any>(env, "/agent-access", {
        userId: user.id,
        agentId,
      });
      if (!access.response.ok) {
        return Response.json(access.data, { status: access.response.status });
      }

      let online = false;
      if (access.data.authorized) {
        const stub = env.RELAY.get(env.RELAY.idFromName(agentId));
        const relayStatus = await stub.fetch("https://relay.internal/status")
          .then((response) => response.json<any>())
          .catch(() => ({ online: false }));
        online = Boolean(relayStatus.online);
      }

      return Response.json({
        agentId,
        agentName: access.data.agent?.name ?? agentId,
        ownerUserId: access.data.agent?.ownerUserId ?? null,
        enabled: access.data.agent?.enabled === true,
        retiredAt: access.data.agent?.retiredAt ?? null,
        lastSeenAt: access.data.agent?.lastSeenAt ?? null,
        scopes: access.data.scopes ?? [],
        authorized: access.data.authorized === true,
        reauthorizationRequired: access.data.reauthorizationRequired === true,
        online,
      });
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
