import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

interface Env {
  RELAY: DurableObjectNamespace;
  AGENT_TOKEN?: string;
  CALLER_TOKEN?: string;
}

type Pending = { resolve: (response: Response) => void; timeout: ReturnType<typeof setTimeout> };
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

const error = (status: number, code: string) => Response.json({ error: code }, { status });
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
    const agent = this.agent;
    if (!agent) return error(503, "agent_offline");
    if (!hasPayload(body)) return error(400, "payload_required");
    const requestId = crypto.randomUUID();
    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(error(504, "agent_timeout"));
      }, TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timeout });
      try { agent.send(JSON.stringify({ requestId, payload: body.payload })); }
      catch { this.disconnect(agent); }
    });
  }
}

function createMcpServer(env: Env) {
  const server = new McpServer({ name: "chat-relay", version: "0.1.0" });

  server.registerTool(
    "ping_agent",
    {
      description: "Check that the connected local chat-relay agent is reachable and return its pong response.",
      inputSchema: {},
    },
    async () => {
      const stub = env.RELAY.get(env.RELAY.idFromName("default"));
      const response = await stub.fetch(new Request("https://relay.internal/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { action: "ping" } }),
      }));
      const body = await response.text();
      return {
        ...(response.ok ? {} : { isError: true }),
        content: [{ type: "text" as const, text: body }],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      return createMcpHandler(() => createMcpServer(env), {
        route: "/mcp",
        responseMode: "json",
      })(request, env, ctx);
    }
    if (path === "/health") return request.method === "GET"
      ? Response.json({ status: "ok", service: "chat-relay" })
      : error(405, "method_not_allowed");
    if (path !== "/agent" && path !== "/relay" && path !== "/status") {
      return error(404, "not_found");
    }
    if (request.method !== (path === "/relay" ? "POST" : "GET")) {
      return error(405, "method_not_allowed");
    }
    const token = path === "/agent" ? env.AGENT_TOKEN : env.CALLER_TOKEN;
    if (!token) return error(503, "relay_not_configured");
    if (!authorized(request, token)) return error(401, "unauthorized");
    if (path === "/relay" && request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      return error(415, "json_required");
    }
    const stub = env.RELAY.get(env.RELAY.idFromName("default"));
    if (path !== "/relay") return stub.fetch(request);
    let body: unknown;
    try { body = await readJson(request); }
    catch (cause) {
      const code = cause instanceof Error && cause.message === "payload_too_large"
        ? "payload_too_large" : "invalid_json";
      return error(code === "payload_too_large" ? 413 : 400, code);
    }
    return stub.fetch(new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  },
};
