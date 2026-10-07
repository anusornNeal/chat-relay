import { DurableObject } from "cloudflare:workers";
import { DashboardHub } from "./dashboard-hub";
import { Audit } from "./audit";
import { Registry } from "./registry";
import { Usage } from "./usage";
import { Learning } from "./learning";
import { AGENT_PROTOCOL_VERSION, agentConnectionGeneration, agentLiveness, appendAgentConnectionEvent, emptyAgentDiagnostics, isAuthoritativeAgentSocket, nextAgentConnectionGeneration, normalizeAgentHealth, normalizeAgentHello, normalizeAgentLifecycle, normalizeAgentText, readAgentAttachment, recordAgentProcessEpoch, selectLatestAgentSocket, writeAgentAttachment, type AgentConnectionEventType, type AgentDiagnostics, type AgentSocketAttachment } from "./agent-state";
import workerApp, { publishDashboard } from "./worker-app";
import { MAX_BYTES, error, hasPayload } from "./http-utils";
import { relayResultHeaders } from "./relay-result";
import type { Env } from "./env";

export { Audit, DashboardHub, Registry, Usage, Learning };
export default workerApp;

type Pending = {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
  maxResponseBytes: number;
};

const TIMEOUT_MS = 30_000;
const AGENT_DIAGNOSTICS_KEY = "agent:diagnostics";
const TEMP_ARTIFACT_DEFAULT_TTL_SECONDS = 300;
const TEMP_ARTIFACT_MAX_TTL_SECONDS = 900;
const MAX_NATIVE_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_SCREENSHOT_RESPONSE_BYTES = 3 * 1024 * 1024;
const TEMP_ARTIFACT_TABLE = "relay_temp_artifact_v3";
const TEMP_ARTIFACT_SQL_CHUNK_BYTES = 1_850_000;
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
  private diagnosticsWrites: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.relayEnv = env;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${TEMP_ARTIFACT_TABLE} (
        token TEXT NOT NULL,
        part INTEGER NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        filename TEXT,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (token, part)
      ) WITHOUT ROWID
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS relay_temp_artifact_v3_expires
      ON ${TEMP_ARTIFACT_TABLE}(expires_at)
    `);
    this.agent = this.recoverAgentSocket();
  }

  private recoverAgentSocket(): WebSocket | null {
    return selectLatestAgentSocket(this.ctx.getWebSockets());
  }

  private resolveAgent(): WebSocket | null {
    this.agent = selectLatestAgentSocket([
      ...(this.agent ? [this.agent] : []),
      ...this.ctx.getWebSockets(),
    ]);
    return this.agent;
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
      case "/status": return this.agentStatus();
      case "/disconnect": return this.disconnectAgent();
      case "/relay": return this.relay(request);
      case "/control": return this.control(request);
      case "/temp-shot": return this.storeTempShot(request);
      case "/temp-artifact": return this.storeTempArtifact(request);
      default: return error(404, "not_found");
    }
  }

  private async control(request: Request): Promise<Response> {
    if (request.method !== "POST") return error(405, "method_not_allowed");
    const body = await request.json<any>().catch(() => null);
    if (body?.control === "learn_activity" && body?.activity && typeof body.activity === "object") {
      const activity = body.activity;
      const tools = new Set(["learn_prepare", "learn_get", "learn_put", "learn_delete", "learn_feedback"]);
      const tool = tools.has(String(activity.tool)) ? String(activity.tool) : "";
      if (!tool || typeof activity.ok !== "boolean") return error(400, "invalid_learn_activity");

      const rawDurationMs = Number(activity.durationMs);
      const durationMs = Number.isFinite(rawDurationMs)
        ? Math.max(0, Math.min(Math.round(rawDurationMs), 10 * 60_000))
        : null;
      const change = activity.change && typeof activity.change === "object" ? activity.change : null;
      let normalizedChange = null;
      if (change) {
        const types = new Set(["created", "updated", "reinforced", "weakened", "removed"]);
        const type = types.has(String(change.type)) ? String(change.type) : "";
        const key = normalizeAgentText(change.key, 160);
        if (type && key) {
          normalizedChange = {
            eventId: normalizeAgentText(change.eventId, 160),
            memoryId: normalizeAgentText(change.memoryId, 160),
            type,
            key,
            kind: normalizeAgentText(change.kind, 40),
            scope: normalizeAgentText(change.scope, 20),
            scopeKey: normalizeAgentText(change.scopeKey, 200) || null,
            confidence: Number.isFinite(Number(change.confidence)) ? Number(change.confidence) : null,
            previousConfidence: Number.isFinite(Number(change.previousConfidence)) ? Number(change.previousConfidence) : null,
            at: normalizeAgentText(change.at, 64) || new Date().toISOString(),
          };
        }
      }

      const agent = this.resolveAgent();
      if (!agent) return Response.json({ ok: true, delivered: false });
      try {
        agent.send(JSON.stringify({
          control: "learn_activity",
          activity: {
            eventId: normalizeAgentText(activity.eventId, 160) || "learn-call-" + crypto.randomUUID(),
            tool,
            ok: activity.ok,
            durationMs,
            at: normalizeAgentText(activity.at, 64) || new Date().toISOString(),
            scopeSummary: normalizeAgentText(activity.scopeSummary, 80) || null,
            kind: normalizeAgentText(activity.kind, 40) || null,
            feedback: activity.feedback === "positive" || activity.feedback === "negative" ? activity.feedback : null,
            ...(normalizedChange ? { change: normalizedChange } : {}),
          },
        }));
        return Response.json({ ok: true, delivered: true });
      } catch {
        return Response.json({ ok: true, delivered: false });
      }
    }

    if (body?.control !== "learn_activity" || !body?.change || typeof body.change !== "object") {
      return error(400, "invalid_control");
    }
    const change = body.change;
    const types = new Set(["created", "updated", "reinforced", "weakened", "removed"]);
    const type = types.has(String(change.type)) ? String(change.type) : "";
    const memoryId = normalizeAgentText(change.memoryId, 160);
    const key = normalizeAgentText(change.key, 160);
    const summary = normalizeAgentText(change.summary, 320);
    if (!type || !memoryId || !key || !summary) return error(400, "invalid_learn_activity");

    const agent = this.resolveAgent();
    if (!agent) return Response.json({ ok: true, delivered: false });
    try {
      agent.send(JSON.stringify({
        control: "learn_activity",
        change: {
          eventId: normalizeAgentText(change.eventId, 160),
          memoryId,
          type,
          key,
          kind: normalizeAgentText(change.kind, 40),
          scope: normalizeAgentText(change.scope, 20),
          scopeKey: normalizeAgentText(change.scopeKey, 200) || null,
          summary,
          confidence: Number.isFinite(Number(change.confidence)) ? Number(change.confidence) : null,
          previousConfidence: Number.isFinite(Number(change.previousConfidence)) ? Number(change.previousConfidence) : null,
          at: normalizeAgentText(change.at, 64) || new Date().toISOString(),
        },
      }));
      return Response.json({ ok: true, delivered: true });
    } catch {
      return Response.json({ ok: true, delivered: false });
    }
  }

  private async readDiagnostics(): Promise<AgentDiagnostics> {
    await this.diagnosticsWrites;
    try {
      return await this.ctx.storage.get<AgentDiagnostics>(AGENT_DIAGNOSTICS_KEY) ?? emptyAgentDiagnostics();
    } catch {
      return emptyAgentDiagnostics();
    }
  }

  private queueDiagnosticsUpdate(update: (current: AgentDiagnostics) => AgentDiagnostics, persisted?: () => void): Promise<void> {
    const write = this.diagnosticsWrites.then(async () => {
      const current = await this.ctx.storage.get<AgentDiagnostics>(AGENT_DIAGNOSTICS_KEY) ?? emptyAgentDiagnostics();
      await this.ctx.storage.put(AGENT_DIAGNOSTICS_KEY, update(current));
      persisted?.();
    });
    const safeWrite = write.catch(() => {});
    this.diagnosticsWrites = safeWrite;
    this.ctx.waitUntil(safeWrite);
    return safeWrite;
  }

  private recordConnectionEvent(type: AgentConnectionEventType, closeCode?: number): Promise<void> {
    return this.queueDiagnosticsUpdate((current) => appendAgentConnectionEvent(current, { type, closeCode }));
  }

  private async agentStatus(): Promise<Response> {
    const [diagnostics] = await Promise.all([this.readDiagnostics()]);
    return Response.json({ ...agentLiveness(this.resolveAgent()), diagnostics });
  }

  private nextConnectionGeneration(): number {
    let latest = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const generation = agentConnectionGeneration(socket);
      if (generation !== null) latest = Math.max(latest, generation);
    }
    return nextAgentConnectionGeneration(latest || undefined);
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
    const body = await request.json<any>().catch(() => null);
    const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
    if (typeof body?.data !== "string" ||
        (screenshotOnly ? mimeType !== "image/jpeg" : !TEMP_ARTIFACT_MIME_TYPES.has(mimeType))) {
      return error(400, screenshotOnly ? "invalid_screenshot" : "invalid_artifact");
    }

    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0)); }
    catch { return error(400, screenshotOnly ? "invalid_screenshot" : "invalid_artifact"); }
    const maxArtifactBytes = screenshotOnly ? MAX_NATIVE_SCREENSHOT_BYTES : MAX_BYTES;
    if (bytes.byteLength <= 0 || bytes.byteLength > maxArtifactBytes) {
      return error(413, screenshotOnly ? "screenshot_too_large" : "artifact_too_large", { maxBytes: maxArtifactBytes });
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
    const kind = prefix === "temp-shot:" ? "shot" : "artifact";
    const chunks: ArrayBuffer[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += TEMP_ARTIFACT_SQL_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + TEMP_ARTIFACT_SQL_CHUNK_BYTES);
      chunks.push(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + end) as ArrayBuffer);
    }

    // Normal captures/artifacts are one WITHOUT ROWID SQL row. A native JPEG
    // above Cloudflare's 2 MB row ceiling is split into only two rows instead
    // of the old dozens of 48 KiB KV writes.
    const values = chunks.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings: Array<string | number | ArrayBuffer | null> = [];
    chunks.forEach((chunk, part) => {
      bindings.push(token, part, kind, mimeType, chunk, filename, expiresAt);
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO ${TEMP_ARTIFACT_TABLE}
       (token, part, kind, mime_type, data, filename, expires_at)
       VALUES ${values}`,
      ...bindings,
    );

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

    const kind = prefix === "temp-shot:" ? "shot" : "artifact";
    const rows = this.ctx.storage.sql.exec<{
      part: number;
      mime_type: string;
      data: ArrayBuffer;
      filename: string | null;
      expires_at: number;
    }>(
      `SELECT part, mime_type, data, filename, expires_at
       FROM ${TEMP_ARTIFACT_TABLE}
       WHERE token = ? AND kind = ?
       ORDER BY part`,
      token,
      kind,
    ).toArray();
    const row = rows[0];
    if (row) {
      if (Date.now() >= Number(row.expires_at)) {
        this.ctx.storage.sql.exec(`DELETE FROM ${TEMP_ARTIFACT_TABLE} WHERE token = ?`, token);
        return error(410, "expired");
      }
      const parts = rows.map((entry) => new Uint8Array(entry.data as ArrayBuffer));
      const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      const filename = safeArtifactFilename(row.filename);
      return new Response(bytes, {
        headers: {
          "content-type": row.mime_type || "application/octet-stream",
          "cache-control": "private, no-store, max-age=0",
          "content-disposition": filename ? `inline; filename="${filename}"` : "inline",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // Rolling-deploy compatibility for artifacts created by the old KV/chunk path.
    const key = prefix + token;
    const artifact = await this.ctx.storage.get<any>(key);
    if (!artifact) return error(404, "not_found");
    if (artifact.expired === true || typeof artifact.expiresAt !== "number" || Date.now() >= artifact.expiresAt) {
      if (artifact.chunked === true && prefix === "temp-shot:" && Number.isInteger(artifact.chunkCount)) {
        const chunkKeys = Array.from({ length: artifact.chunkCount }, (_, index) => `temp-shot-chunk:${token}:${index}`);
        if (chunkKeys.length) await this.ctx.storage.delete(chunkKeys);
      }
      await this.ctx.storage.delete(key);
      return error(410, "expired");
    }

    let bytes: Uint8Array;
    try {
      if (artifact.chunked === true && prefix === "temp-shot:" && Number.isInteger(artifact.chunkCount)) {
        const chunkKeys = Array.from({ length: artifact.chunkCount }, (_, index) => `temp-shot-chunk:${token}:${index}`);
        const chunks = await this.ctx.storage.get<Uint8Array>(chunkKeys);
        const ordered = chunkKeys.map((chunkKey) => chunks.get(chunkKey));
        if (ordered.some((chunk) => !(chunk instanceof Uint8Array))) throw new Error("missing_screenshot_chunk");
        const totalBytes = ordered.reduce((sum, chunk) => sum + chunk!.byteLength, 0);
        bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of ordered) {
          bytes.set(chunk!, offset);
          offset += chunk!.byteLength;
        }
      } else {
        bytes = Uint8Array.from(atob(artifact.data), (c) => c.charCodeAt(0));
      }
    } catch {
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
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `DELETE FROM ${TEMP_ARTIFACT_TABLE} WHERE expires_at <= ?`,
      now,
    );
    const sqlNext = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      `SELECT MIN(expires_at) AS expires_at FROM ${TEMP_ARTIFACT_TABLE}`,
    ).toArray()[0]?.expires_at;
    let nextExpiry = sqlNext === null || sqlNext === undefined ? null : Number(sqlNext);

    // Clean up legacy KV artifacts during rolling upgrades. New artifacts never
    // enter these prefixes.
    const [shots, artifacts] = await Promise.all([
      this.ctx.storage.list<any>({ prefix: "temp-shot:" }),
      this.ctx.storage.list<any>({ prefix: "temp-artifact:" }),
    ]);
    for (const [entries, isShot] of [[shots, true], [artifacts, false]] as const) {
      for (const [key, artifact] of entries) {
        const expiresAt = typeof artifact?.expiresAt === "number" ? artifact.expiresAt : 0;
        if (expiresAt <= now) {
          if (isShot && artifact?.chunked === true && Number.isInteger(artifact.chunkCount)) {
            const token = key.slice("temp-shot:".length);
            const chunkKeys = Array.from({ length: artifact.chunkCount }, (_, index) => `temp-shot-chunk:${token}:${index}`);
            if (chunkKeys.length) await this.ctx.storage.delete(chunkKeys);
          }
          await this.ctx.storage.delete(key);
        } else if (nextExpiry === null || expiresAt < nextExpiry) {
          nextExpiry = expiresAt;
        }
      }
    }

    if (nextExpiry === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(nextExpiry);
  }

  private async connectAgent(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return error(426, "websocket_required");
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionGeneration = this.nextConnectionGeneration();

    const existingAgent = this.resolveAgent();
    const existingGeneration = agentConnectionGeneration(existingAgent);
    if (existingGeneration !== null && existingGeneration >= connectionGeneration) {
      try { server.close(1000, "superseded"); } catch {}
      return error(409, "connection_superseded");
    }

    this.ctx.acceptWebSocket(server);
    const connectedAt = Date.now();
    writeAgentAttachment(server, { connectionGeneration, connectedAt, lastSeenAt: connectedAt, heartbeatEnabled: false });
    this.agent = server;
    if (existingAgent) {
      try { existingAgent.close(1000, "replaced"); } catch {}
      this.failPending(503, "agent_disconnected");
      this.recordConnectionEvent("replaced", 1000);
    }
    this.recordConnectionEvent("accepted");
    this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents"]));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async disconnectAgent(): Promise<Response> {
    const resolvedAgent = this.resolveAgent();
    const sockets = [...new Set([
      ...(resolvedAgent ? [resolvedAgent] : []),
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
    if (sockets.length > 0) this.recordConnectionEvent("revoked", 4001);
    this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
    return Response.json({ ok: true, disconnected: sockets.length });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.handleMessage(socket, message);
  }

  webSocketClose(socket: WebSocket, code: number): void {
    this.disconnect(socket, "closed", code);
  }

  webSocketError(socket: WebSocket): void {
    this.disconnect(socket, "error");
  }

  private handleMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (!isAuthoritativeAgentSocket(socket, this.resolveAgent()) || typeof data !== "string") return;

    const responseBytes = new TextEncoder().encode(data).byteLength;
    const requestIdHint = data.slice(0, 256).match(/"requestId"\s*:\s*"([^"]+)"/)?.[1];
    const pendingHint = requestIdHint ? this.pending.get(requestIdHint) : undefined;
    const maxResponseBytes = pendingHint?.maxResponseBytes ?? MAX_BYTES;
    if (responseBytes > maxResponseBytes) {
      if (!requestIdHint || !pendingHint) return;
      clearTimeout(pendingHint.timeout);
      this.pending.delete(requestIdHint);
      pendingHint.resolve(error(502, "agent_response_too_large", { maxBytes: maxResponseBytes }));
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
      const health = normalizeAgentHealth((message as any).health);
      const previous = readAgentAttachment(socket);
      const epochSignature = (processId: unknown, value: any) => JSON.stringify([
        Number(processId), value?.processStartedAt, value?.reconnectCount, value?.lastDisconnectedAt,
        value?.lastCloseCode, value?.lastDisconnectReason, value?.lastSocketError, value?.lastConnectionDurationMs,
      ]);
      const signature = epochSignature((message as any).processId, health);
      const changed = previous.persistedEpochSignature !== signature;
      writeAgentAttachment(socket, {
        lastSeenAt: Date.now(),
        heartbeatEnabled: true,
        heartbeatMs: Number((message as any).heartbeatMs),
        processId: Number((message as any).processId),
        lifecycle: normalizeAgentLifecycle((message as any).lifecycle),
        health,
      });
      if (changed) this.queueDiagnosticsUpdate((current) => recordAgentProcessEpoch(current, {
        processId: (message as any).processId,
        health,
      }), () => writeAgentAttachment(socket, { persistedEpochSignature: signature }));
      try {
        socket.send(JSON.stringify({
          control: "agent_heartbeat_ack",
          at: Date.now(),
          connectionGeneration: agentConnectionGeneration(socket),
        }));
      } catch {}
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
    const responseBody = {
      requestId,
      payload: message.payload,
      meta: {
        relayRoundTripMs,
        transportMs,
        agentQueueWaitMs,
        agentHandlerMs,
        lane: normalizeAgentText(agentMeta.lane, 32),
      },
    };
    pending.resolve(new Response(JSON.stringify(responseBody), {
      headers: relayResultHeaders(message.payload, {
        relayRoundTripMs,
        transportMs,
        agentQueueWaitMs,
        agentHandlerMs,
      }),
    }));
  }

  private disconnect(socket: WebSocket, type: "closed" | "error" = "closed", closeCode?: number): void {
    if (!isAuthoritativeAgentSocket(socket, this.resolveAgent())) return;
    this.agent = null;
    this.failPending(503, "agent_disconnected");
    this.recordConnectionEvent(type, closeCode);
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
    const currentAgent = this.resolveAgent();
    if (!currentAgent) return error(503, "agent_offline");
    const liveness = agentLiveness(currentAgent);
    if (liveness.stale) {
      const staleAgent = currentAgent;
      this.agent = null;
      try { staleAgent.close(4000, "heartbeat_timeout"); } catch {}
      this.failPending(503, "agent_stale");
      this.recordConnectionEvent("stale", 4000);
      this.ctx.waitUntil(publishDashboard(this.relayEnv, ["overview", "users", "agents", "calls"]));
      return error(503, "agent_stale", { lastSeenAt: liveness.lastSeenAt, heartbeatTtlMs: liveness.heartbeatTtlMs });
    }

    const requestId = crypto.randomUUID();
    const agent = currentAgent;

    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(error(504, "agent_timeout"));
      }, TIMEOUT_MS);

      const payload = (body as any).payload;
      const isNativeScreenshot = payload?.action === "desktop.screenshot" && payload?.native === true;
      this.pending.set(requestId, {
        resolve,
        timeout,
        startedAt: Date.now(),
        maxResponseBytes: isNativeScreenshot ? MAX_NATIVE_SCREENSHOT_RESPONSE_BYTES : MAX_BYTES,
      });
      try {
        agent.send(JSON.stringify({ requestId, payload: body.payload }));
      } catch {
        this.disconnect(agent);
      }
    });
  }
}
