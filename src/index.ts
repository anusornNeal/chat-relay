import { DurableObject } from "cloudflare:workers";
import { DashboardHub } from "./dashboard-hub";
import { Audit } from "./audit";
import { Registry } from "./registry";
import { Usage } from "./usage";
import { AGENT_PROTOCOL_VERSION, agentLiveness, normalizeAgentHealth, normalizeAgentHello, normalizeAgentLifecycle, normalizeAgentText, readAgentAttachment, writeAgentAttachment, type AgentSocketAttachment } from "./agent-state";
import workerApp, { publishDashboard } from "./worker-app";
import { MAX_BYTES, error, hasPayload } from "./http-utils";
import type { Env } from "./env";

export { Audit, DashboardHub, Registry, Usage };
export default workerApp;

type Pending = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
};

const TIMEOUT_MS = 30_000;
const TEMP_ARTIFACT_DEFAULT_TTL_SECONDS = 300;
const TEMP_ARTIFACT_MAX_TTL_SECONDS = 900;
const TEMP_ARTIFACT_EXPIRED_TOMBSTONE_MS = 60_000;
const TEMP_ARTIFACT_MIME_TYPES = new Set([
  "text/plain; charset=utf-8",
  "text/markdown; charset=utf-8",
  "application/json",
  "application/octet-stream",
  "image/jpeg",
  "image/png",
]);

function safeArtifactFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
  return normalized || null;
}

export class Relay extends DurableObject {
  private agent: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly relayEnv: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.relayEnv = env;
    this.agent = ctx.getWebSockets().at(-1) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/temp-shot/")) {
      return this.getTempShot(path.slice("/temp-shot/".length));
    }
    if (path.startsWith("/temp-artifact/")) {
      return this.getTempArtifact(path.slice("/temp-artifact/".length));
    }
    switch (path) {
      case "/agent": return this.connectAgent(request);
      case "/status": return Response.json(agentLiveness(this.agent));
      case "/disconnect": return this.disconnectAgent();
      case "/relay": return this.relay(request);
      case "/temp-shot": return this.storeTempShot(request);
      case "/temp-artifact": return this.storeTempArtifact(request);
      default: return error(404, "not_found");
    }
  }

  async alarm(): Promise<void> {
    await this.cleanupTempArtifacts();
  }


  private async storeTempShot(request: Request): Promise<Response> {
    return this.storeTempArtifact(request, "temp-shot:", true);
  }

  private async storeTempArtifact(
    request: Request,
    prefix = "temp-artifact:",
    screenshotOnly = false,
  ): Promise<Response> {
    if (request.method !== "POST") return error(405, "method_not_allowed");

    let body: any;
    try { body = await request.json(); }
    catch { return error(400, "invalid_json"); }

    const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
    if (typeof body?.data !== "string" ||
        (screenshotOnly ? mimeType !== "image/jpeg" : !TEMP_ARTIFACT_MIME_TYPES.has(mimeType))) {
      return error(400, screenshotOnly ? "invalid_screenshot" : "invalid_artifact");
    }

    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0)); }
    catch { return error(400, screenshotOnly ? "invalid_screenshot" : "invalid_artifact"); }
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_BYTES) {
      return error(413, screenshotOnly ? "screenshot_too_large" : "artifact_too_large", { maxBytes: MAX_BYTES });
    }

    const requestedTtl = Number(body?.ttlSeconds);
    const ttlSeconds = screenshotOnly
      ? TEMP_ARTIFACT_DEFAULT_TTL_SECONDS
      : Number.isFinite(requestedTtl)
        ? Math.min(Math.max(Math.trunc(requestedTtl), 1), TEMP_ARTIFACT_MAX_TTL_SECONDS)
        : TEMP_ARTIFACT_DEFAULT_TTL_SECONDS;
    const token = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const filename = screenshotOnly ? null : safeArtifactFilename(body?.filename);
    await this.ctx.storage.put(prefix + token, {
      mimeType,
      data: body.data,
      expiresAt,
      ...(filename ? { filename } : {}),
    });

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
    }

    return Response.json({ ok: true, token, expiresAt, ttlSeconds });
  }

  private async getTempShot(token: string): Promise<Response> {
    return this.getTempArtifact(token, "temp-shot:", "invalid_screenshot");
  }

  private async getTempArtifact(
    token: string,
    prefix = "temp-artifact:",
    invalidCode = "invalid_artifact",
  ): Promise<Response> {
    if (!/^[a-f0-9]{32}$/.test(token)) return error(404, "not_found");

    const key = prefix + token;
    const artifact = await this.ctx.storage.get<any>(key);
    if (!artifact) return error(404, "not_found");

    if (artifact.expired === true || typeof artifact.expiresAt !== "number" || Date.now() >= artifact.expiresAt) {
      await this.ctx.storage.delete(key);
      return error(410, "expired");
    }

    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(artifact.data), (c) => c.charCodeAt(0)); }
    catch {
      await this.ctx.storage.delete(key);
      return error(500, invalidCode);
    }

    const filename = safeArtifactFilename(artifact.filename);
    return new Response(bytes, {
      headers: {
        "content-type": artifact.mimeType || "application/octet-stream",
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": filename ? `inline; filename="${filename}"` : "inline",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private async cleanupTempArtifacts(): Promise<void> {
    const [shots, artifacts] = await Promise.all([
      this.ctx.storage.list<any>({ prefix: "temp-shot:" }),
      this.ctx.storage.list<any>({ prefix: "temp-artifact:" }),
    ]);
    const now = Date.now();
    let nextExpiry: number | null = null;

    for (const entries of [shots, artifacts]) {
      for (const [key, artifact] of entries) {
        const expiresAt = typeof artifact?.expiresAt === "number" ? artifact.expiresAt : 0;
        const deleteAfter = artifact?.expired === true && typeof artifact?.deleteAfter === "number"
          ? artifact.deleteAfter
          : null;
        if (deleteAfter !== null) {
          if (deleteAfter <= now) {
            await this.ctx.storage.delete(key);
          } else if (nextExpiry === null || deleteAfter < nextExpiry) {
            nextExpiry = deleteAfter;
          }
          continue;
        }
        if (expiresAt <= now) {
          const tombstoneUntil = now + TEMP_ARTIFACT_EXPIRED_TOMBSTONE_MS;
          await this.ctx.storage.put(key, {
            expired: true,
            expiresAt,
            deleteAfter: tombstoneUntil,
          });
          if (nextExpiry === null || tombstoneUntil < nextExpiry) nextExpiry = tombstoneUntil;
        } else if (nextExpiry === null || expiresAt < nextExpiry) {
          nextExpiry = expiresAt;
        }
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
    const connectedAt = Date.now();
    writeAgentAttachment(server, { connectedAt, lastSeenAt: connectedAt, heartbeatEnabled: false });
    this.agent = server;
    this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents"]));
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
    this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
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
    const control = typeof message === "object" && message !== null
      ? String((message as any).control ?? "")
      : "";
    if (control === "agent_hello") {
      const hello = normalizeAgentHello(message);
      if (hello.protocolVersion !== AGENT_PROTOCOL_VERSION) {
        try {
          socket.send(JSON.stringify({
            control: "protocol_incompatible",
            expectedProtocolVersion: AGENT_PROTOCOL_VERSION,
            receivedProtocolVersion: hello.protocolVersion,
          }));
        } catch {}
        this.agent = null;
        this.failPending(503, "agent_incompatible");
        this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
        try { socket.close(4002, "protocol_incompatible"); } catch {}
        return;
      }
      writeAgentAttachment(socket, {
        lastSeenAt: Date.now(),
        protocolVersion: hello.protocolVersion,
        ...(hello.agentVersion ? { agentVersion: hello.agentVersion } : {}),
        ...(hello.platform ? { platform: hello.platform } : {}),
        ...(hello.arch ? { arch: hello.arch } : {}),
        capabilities: hello.capabilities,
      });
      return;
    }
    if (control === "agent_heartbeat") {
      writeAgentAttachment(socket, {
        lastSeenAt: Date.now(),
        heartbeatEnabled: true,
        heartbeatMs: Number((message as any).heartbeatMs),
        processId: Number((message as any).processId),
        lifecycle: normalizeAgentLifecycle((message as any).lifecycle),
        health: normalizeAgentHealth((message as any).health),
      });
      return;
    }
    if (readAgentAttachment(socket).heartbeatEnabled === true) {
      writeAgentAttachment(socket, { lastSeenAt: Date.now() });
    }
    if (!hasPayload(message) || typeof (message as { requestId?: unknown }).requestId !== "string") return;

    const requestId = (message as { requestId: string }).requestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    const agentMeta = (message as any).meta && typeof (message as any).meta === "object" ? (message as any).meta : {};
    const relayRoundTripMs = Math.max(0, Date.now() - pending.startedAt);
    const agentQueueWaitMs = Math.max(0, Number(agentMeta.agentQueueWaitMs) || 0);
    const agentHandlerMs = Math.max(0, Number(agentMeta.agentHandlerMs) || 0);
    const transportMs = Math.max(0, relayRoundTripMs - agentQueueWaitMs - agentHandlerMs);
    pending.resolve(Response.json({
      requestId,
      payload: message.payload,
      meta: {
        relayRoundTripMs,
        transportMs,
        agentQueueWaitMs,
        agentHandlerMs,
        lane: normalizeAgentText(agentMeta.lane, 32),
      },
    }));
  }

  private disconnect(socket: WebSocket): void {
    if (socket !== this.agent) return;
    this.agent = null;
    this.failPending(503, "agent_disconnected");
    this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
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
    const liveness = agentLiveness(this.agent);
    if (liveness.stale) {
      const staleAgent = this.agent;
      this.agent = null;
      try { staleAgent.close(4000, "heartbeat_timeout"); } catch {}
      this.failPending(503, "agent_stale");
      this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
      return error(503, "agent_stale", { lastSeenAt: liveness.lastSeenAt, heartbeatTtlMs: liveness.heartbeatTtlMs });
    }

    const requestId = crypto.randomUUID();
    const agent = this.agent;

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(error(504, "agent_timeout"));
      }, TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timeout, startedAt: Date.now() });
      try {
        agent.send(JSON.stringify({ requestId, payload: body.payload }));
      } catch {
        this.disconnect(agent);
      }
    });
  }
}
