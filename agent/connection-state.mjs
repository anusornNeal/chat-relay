function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function isoTime(value) {
  const number = Number(value);
  return new Date(Number.isFinite(number) ? number : Date.now()).toISOString();
}

const SAFE_REASONS = new Set([
  "socket_closed", "socket_error", "transport_pong_timeout", "transport_ping_failed",
  "heartbeat_ack_timeout", "connection_generation_changed", "credential_revoked",
  "credential_rejected", "protocol_incompatible", "restart_requested",
  "upgrade_requested", "client_shutdown", "shutdown", "replaced", "SIGINT", "SIGTERM",
]);

export function safeConnectionReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason) return null;
  if (SAFE_REASONS.has(reason) || /^unexpected_response_[1-5][0-9]{2}$/.test(reason)) return reason;
  const networkError = reason.match(/\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b/);
  return networkError ? networkError[1] : "socket_error";
}

export function classifySocketDisconnect(code, reason, socketError = null) {
  if (code === 4001 || reason === "credential_revoked" || reason === "credential_rejected") return "authorization";
  if (code === 4002 || reason === "protocol_incompatible") return "protocol";
  if (reason?.startsWith("unexpected_response_")) return "handshake";
  if (["transport_pong_timeout", "heartbeat_ack_timeout"].includes(socketError)) return "timeout";
  if (code === 1006) return "abnormal_transport";
  if (code === 1012 || reason === "restart_requested" || reason === "upgrade_requested") return "restart";
  if (code === 1000 || code === 1001) return "normal";
  return "remote_close";
}

export function computeReconnectDelay(attempt, options = {}) {
  const baseMs = boundedInteger(options.baseMs, 2000, 100, 60_000);
  const maxMs = boundedInteger(options.maxMs, 30_000, baseMs, 120_000);
  const jitterRatio = Math.min(Math.max(Number(options.jitterRatio ?? 0.2), 0), 0.5);
  const random = typeof options.random === "function" ? options.random : Math.random;
  const exponent = Math.min(Math.max(Math.trunc(Number(attempt) || 1) - 1, 0), 10);
  const raw = Math.min(maxMs, baseMs * (2 ** exponent));
  const spread = raw * jitterRatio;
  const sample = Math.min(Math.max(Number(random()) || 0, 0), 1);
  return Math.max(100, Math.round(raw - spread + (spread * 2 * sample)));
}

export class AgentConnectionState {
  constructor(options = {}) {
    this.baseReconnectMs = boundedInteger(options.baseReconnectMs, 2000, 100, 60_000);
    this.maxReconnectMs = boundedInteger(options.maxReconnectMs, 30_000, this.baseReconnectMs, 120_000);
    this.heartbeatMs = boundedInteger(options.heartbeatMs, 30_000, 5_000, 60_000);
    this.processStartedAt = new Date().toISOString();
    this.state = "starting";
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastHeartbeatAt = null;
    this.lastCloseCode = null;
    this.lastDisconnectReason = null;
    this.lastDisconnectCategory = null;
    this.lastConnectionDurationMs = null;
    this.lastSocketError = null;
    this.socketErrorForConnection = null;
    this.serverConnectionGeneration = null;
    this.reconnectAttempt = 0;
    this.reconnectCount = 0;
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
  }

  markConnecting(now = Date.now()) {
    this.state = "connecting";
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
    this.connectingAt = isoTime(now);
  }

  markConnected(now = Date.now()) {
    this.state = "connected";
    this.connectedAt = isoTime(now);
    this.socketErrorForConnection = null;
    this.disconnectedAt = null;
    this.serverConnectionGeneration = null;
    this.reconnectAttempt = 0;
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
  }

  markHeartbeat(now = Date.now()) {
    this.lastHeartbeatAt = isoTime(now);
  }

  markDisconnected(code, reason, now = Date.now()) {
    this.state = "waiting";
    const disconnectedAt = isoTime(now);
    const connectedAtMs = this.connectedAt ? Date.parse(this.connectedAt) : NaN;
    this.disconnectedAt = disconnectedAt;
    this.lastDisconnectedAt = disconnectedAt;
    const closeCode = code === null || code === undefined ? NaN : Number(code);
    this.lastCloseCode = Number.isFinite(closeCode) ? closeCode : null;
    this.lastDisconnectReason = safeConnectionReason(reason);
    this.lastDisconnectCategory = classifySocketDisconnect(this.lastCloseCode, this.lastDisconnectReason, this.socketErrorForConnection);
    this.lastConnectionDurationMs = Number.isFinite(connectedAtMs)
      ? Math.max(0, Math.trunc(Number(now) - connectedAtMs))
      : null;
    this.reconnectAttempt += 1;
    this.reconnectCount += 1;
  }

  markSocketError(reason) {
    this.socketErrorForConnection = safeConnectionReason(reason);
    this.lastSocketError = this.socketErrorForConnection;
  }

  markServerConnectionGeneration(value) {
    if (value === null || value === undefined) return true;
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      this.markSocketError("connection_generation_changed");
      return false;
    }
    if (this.serverConnectionGeneration === null) {
      this.serverConnectionGeneration = generation;
      return true;
    }
    if (this.serverConnectionGeneration === generation) return true;
    this.markSocketError("connection_generation_changed");
    return false;
  }

  scheduleReconnect(delayMs, now = Date.now()) {
    const delay = boundedInteger(delayMs, this.baseReconnectMs, 100, this.maxReconnectMs);
    this.nextReconnectDelayMs = delay;
    this.nextReconnectAt = isoTime(Number(now) + delay);
  }

  nextDelay(random = Math.random) {
    return computeReconnectDelay(this.reconnectAttempt, {
      baseMs: this.baseReconnectMs,
      maxMs: this.maxReconnectMs,
      random,
    });
  }

  markReauthorization(reason = "credential_revoked", now = Date.now()) {
    this.state = "reauthorization-required";
    this.disconnectedAt = isoTime(now);
    this.lastDisconnectReason = safeConnectionReason(reason);
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
  }

  markStopping(reason = "shutdown", now = Date.now()) {
    this.state = "stopping";
    this.disconnectedAt = isoTime(now);
    this.lastDisconnectReason = safeConnectionReason(reason);
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
  }

  snapshot() {
    return {
      state: this.state,
      processStartedAt: this.processStartedAt,
      connectingAt: this.connectingAt ?? null,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastCloseCode: this.lastCloseCode,
      lastDisconnectReason: this.lastDisconnectReason,
      lastDisconnectCategory: this.lastDisconnectCategory,
      lastConnectionDurationMs: this.lastConnectionDurationMs,
      lastSocketError: this.lastSocketError,
      serverConnectionGeneration: this.serverConnectionGeneration,
      reconnectAttempt: this.reconnectAttempt,
      reconnectCount: this.reconnectCount,
      nextReconnectAt: this.nextReconnectAt,
      nextReconnectDelayMs: this.nextReconnectDelayMs,
      baseReconnectMs: this.baseReconnectMs,
      maxReconnectMs: this.maxReconnectMs,
      heartbeatMs: this.heartbeatMs,
    };
  }
}
