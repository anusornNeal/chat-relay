function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function isoTime(value) {
  const number = Number(value);
  return new Date(Number.isFinite(number) ? number : Date.now()).toISOString();
}

function cleanReason(value) {
  const reason = String(value || "").trim();
  return reason ? reason.slice(0, 160) : null;
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
    this.heartbeatMs = boundedInteger(options.heartbeatMs, 15_000, 5_000, 60_000);
    this.processStartedAt = new Date().toISOString();
    this.state = "starting";
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastHeartbeatAt = null;
    this.lastCloseCode = null;
    this.lastDisconnectReason = null;
    this.lastConnectionDurationMs = null;
    this.lastSocketError = null;
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
    this.disconnectedAt = null;
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
    this.lastCloseCode = Number.isFinite(Number(code)) ? Number(code) : null;
    this.lastDisconnectReason = cleanReason(reason);
    this.lastConnectionDurationMs = Number.isFinite(connectedAtMs)
      ? Math.max(0, Math.trunc(Number(now) - connectedAtMs))
      : null;
    this.reconnectAttempt += 1;
    this.reconnectCount += 1;
  }

  markSocketError(reason) {
    this.lastSocketError = cleanReason(reason);
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
    this.lastDisconnectReason = cleanReason(reason);
    this.nextReconnectAt = null;
    this.nextReconnectDelayMs = null;
  }

  markStopping(reason = "shutdown", now = Date.now()) {
    this.state = "stopping";
    this.disconnectedAt = isoTime(now);
    this.lastDisconnectReason = cleanReason(reason);
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
      lastConnectionDurationMs: this.lastConnectionDurationMs,
      lastSocketError: this.lastSocketError,
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
