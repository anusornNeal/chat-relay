export type AgentSocketAttachment = {
  connectionGeneration?: number;
  connectedAt?: number;
  lastSeenAt?: number;
  heartbeatEnabled?: boolean;
  heartbeatMs?: number;
  processId?: number;
  protocolVersion?: number;
  agentVersion?: string;
  platform?: string;
  arch?: string;
  capabilities?: string[];
  lifecycle?: { state: string; drainStartedAt: string | null; restartRequestedAt: string | null; readyToRestart?: boolean; work: Record<string, number> };
  health?: {
    reconnectCount: number;
    reconnectAttempt: number;
    processStartedAt: string | null;
    connectedAt: string | null;
    lastDisconnectedAt: string | null;
    lastCloseCode: number | null;
    lastDisconnectReason: string | null;
    lastSocketError: string | null;
    lastConnectionDurationMs: number | null;
    queues: Record<string, { concurrency: number; active: number; queued: number; maxQueued: number; queueTimeoutMs: number }>;
  };
};

export const AGENT_CONNECTION_EVENT_LIMIT = 32;
export const AGENT_PROCESS_EPOCH_LIMIT = 8;

export type AgentConnectionEventType = "accepted" | "replaced" | "closed" | "error" | "stale" | "revoked";

export type AgentDiagnostics = {
  version: 1;
  totalAccepted: number;
  totalDisconnected: number;
  events: Array<{
    type: AgentConnectionEventType;
    at: string;
    closeCode?: number;
  }>;
  processEpochs: Array<{
    processStartedAt: string | null;
    processId: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
    maxReconnectCount: number;
    lastDisconnectedAt: string | null;
    lastCloseCode: number | null;
    lastDisconnectReason: string | null;
    lastSocketError: string | null;
    lastConnectionDurationMs: number | null;
  }>;
};

export function emptyAgentDiagnostics(): AgentDiagnostics {
  return { version: 1, totalAccepted: 0, totalDisconnected: 0, events: [], processEpochs: [] };
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function boundedInteger(value: unknown, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(0, Math.trunc(number)), max) : 0;
}

const SAFE_AGENT_DIAGNOSTIC_REASONS = new Set([
  "heartbeat_ack_timeout", "transport_pong_timeout", "transport_ping_failed", "socket_closed",
  "credential_revoked", "credential_rejected", "protocol_incompatible", "restart_requested",
  "client_shutdown", "replaced", "heartbeat_timeout", "shutdown", "SIGINT", "SIGTERM",
]);
const SAFE_NETWORK_ERROR_CODES = ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"];

export function normalizeAgentDiagnosticReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason) return null;
  if (SAFE_AGENT_DIAGNOSTIC_REASONS.has(reason)) return reason;
  if (/^unexpected_response_[1-5][0-9]{2}$/.test(reason)) return reason;
  for (const code of SAFE_NETWORK_ERROR_CODES) {
    if (reason.includes(code)) return code;
  }
  return null;
}

export function appendAgentConnectionEvent(
  diagnostics: AgentDiagnostics | null | undefined,
  event: { type: AgentConnectionEventType; at?: number; closeCode?: unknown },
): AgentDiagnostics {
  const current = diagnostics?.version === 1 ? diagnostics : emptyAgentDiagnostics();
  const closeCode = Number(event.closeCode);
  const entry = {
    type: event.type,
    at: new Date(Number.isFinite(event.at) ? event.at : Date.now()).toISOString(),
    ...(Number.isInteger(closeCode) && closeCode >= 0 && closeCode <= 4999 ? { closeCode } : {}),
  };
  const disconnected = event.type !== "accepted";
  return {
    version: 1,
    totalAccepted: boundedInteger(
      boundedInteger(current.totalAccepted, Number.MAX_SAFE_INTEGER) + (event.type === "accepted" ? 1 : 0),
      Number.MAX_SAFE_INTEGER,
    ),
    totalDisconnected: boundedInteger(
      boundedInteger(current.totalDisconnected, Number.MAX_SAFE_INTEGER) + (disconnected ? 1 : 0),
      Number.MAX_SAFE_INTEGER,
    ),
    events: [...(Array.isArray(current.events) ? current.events : []), entry].slice(-AGENT_CONNECTION_EVENT_LIMIT),
    processEpochs: (Array.isArray(current.processEpochs) ? current.processEpochs : []).slice(-AGENT_PROCESS_EPOCH_LIMIT),
  };
}

export function recordAgentProcessEpoch(
  diagnostics: AgentDiagnostics | null | undefined,
  input: { processId?: unknown; health?: unknown; seenAt?: number },
): AgentDiagnostics {
  const current = diagnostics?.version === 1 ? diagnostics : emptyAgentDiagnostics();
  const health = input.health && typeof input.health === "object" ? input.health as Record<string, unknown> : {};
  const processStartedAt = safeIsoTimestamp(health.processStartedAt);
  const rawProcessId = Number(input.processId);
  const processId = Number.isInteger(rawProcessId) && rawProcessId >= 0 && rawProcessId <= 0x7fffffff ? rawProcessId : null;
  if (processStartedAt === null && processId === null) return current;

  const seenAt = new Date(Number.isFinite(input.seenAt) ? input.seenAt : Date.now()).toISOString();
  const reconnectCount = boundedInteger(health.reconnectCount, 1_000_000);
  const lastDisconnectedAt = safeIsoTimestamp(health.lastDisconnectedAt);
  const lastDisconnectReason = normalizeAgentDiagnosticReason(health.lastDisconnectReason);
  const lastSocketError = normalizeAgentDiagnosticReason(health.lastSocketError);
  const rawCloseCode = Number(health.lastCloseCode);
  const lastCloseCode = Number.isInteger(rawCloseCode) && rawCloseCode >= 0 && rawCloseCode <= 4999 ? rawCloseCode : null;
  const rawDuration = Number(health.lastConnectionDurationMs);
  const lastConnectionDurationMs = Number.isFinite(rawDuration) && rawDuration >= 0
    ? Math.min(Math.trunc(rawDuration), 365 * 24 * 60 * 60 * 1000)
    : null;
  const epochs = Array.isArray(current.processEpochs) ? [...current.processEpochs] : [];
  const existingIndex = epochs.findIndex((epoch) => processStartedAt !== null
    ? epoch.processStartedAt === processStartedAt
    : epoch.processStartedAt === null && epoch.processId === processId);
  const previous = existingIndex >= 0 ? epochs.splice(existingIndex, 1)[0] : null;
  epochs.push({
    processStartedAt,
    processId,
    firstSeenAt: previous?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
    maxReconnectCount: Math.max(previous?.maxReconnectCount ?? 0, reconnectCount),
    lastDisconnectedAt,
    lastCloseCode,
    lastDisconnectReason,
    lastSocketError,
    lastConnectionDurationMs,
  });
  return {
    version: 1,
    totalAccepted: boundedInteger(current.totalAccepted, Number.MAX_SAFE_INTEGER),
    totalDisconnected: boundedInteger(current.totalDisconnected, Number.MAX_SAFE_INTEGER),
    events: (Array.isArray(current.events) ? current.events : []).slice(-AGENT_CONNECTION_EVENT_LIMIT),
    processEpochs: epochs.slice(-AGENT_PROCESS_EPOCH_LIMIT),
  };
}

export const AGENT_PROTOCOL_VERSION = 1;

const DEFAULT_AGENT_HEARTBEAT_TTL_MS = 45_000;
const MAX_AGENT_HEARTBEAT_TTL_MS = 180_000;
const MAX_AGENT_CAPABILITIES = 64;

export function normalizeAgentText(value: unknown, maxLength = 80): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeAgentCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const capability = normalizeAgentText(item, 64);
    if (!capability || !/^[a-z0-9._-]+$/i.test(capability) || seen.has(capability)) continue;
    seen.add(capability);
    output.push(capability);
    if (output.length >= MAX_AGENT_CAPABILITIES) break;
  }
  return output;
}

export function normalizeAgentHello(message: any) {
  const protocolVersion = Number(message?.protocolVersion);
  return {
    protocolVersion: Number.isInteger(protocolVersion) ? protocolVersion : null,
    agentVersion: normalizeAgentText(message?.agentVersion),
    platform: normalizeAgentText(message?.platform, 32),
    arch: normalizeAgentText(message?.arch, 32),
    capabilities: normalizeAgentCapabilities(message?.capabilities),
  };
}

export function normalizeAgentLifecycle(value: any) {
  const state = ["running", "draining", "restart-pending"].includes(String(value?.state)) ? String(value.state) : "running";
  const work = value?.work && typeof value.work === "object" ? value.work : {};
  const count = (key: string) => Math.max(0, Number(work[key]) || 0);
  return {
    state,
    drainStartedAt: normalizeAgentText(value?.drainStartedAt, 64),
    restartRequestedAt: normalizeAgentText(value?.restartRequestedAt, 64),
    readyToRestart: value?.readyToRestart === true,
    work: {
      activeSessions: count("activeSessions"),
      activeBatchJobs: count("activeBatchJobs"),
      queuedBatchJobs: count("queuedBatchJobs"),
      activeTerminalExecs: count("activeTerminalExecs"),
      queuedTerminalExecs: count("queuedTerminalExecs"),
      total: count("total"),
    },
  };
}

export function normalizeAgentHealth(value: any) {
  const bounded = (input: unknown, max = 1_000_000) => Math.min(Math.max(0, Number(input) || 0), max);
  const queues: Record<string, { concurrency: number; active: number; queued: number; maxQueued: number; queueTimeoutMs: number }> = {};
  const source = value?.queues && typeof value.queues === "object" ? value.queues : {};
  for (const name of ["agent", "filesystem", "process", "terminalExec", "terminalControl", "desktopRead"]) {
    const lane = source[name];
    if (!lane || typeof lane !== "object") continue;
    queues[name] = {
      concurrency: bounded(lane.concurrency, 64),
      active: bounded(lane.active, 512),
      queued: bounded(lane.queued, 512),
      maxQueued: bounded(lane.maxQueued, 512),
      queueTimeoutMs: bounded(lane.queueTimeoutMs, 120_000),
    };
  }
  const closeCode = value?.lastCloseCode === null || value?.lastCloseCode === undefined ? NaN : Number(value.lastCloseCode);
  const duration = value?.lastConnectionDurationMs === null || value?.lastConnectionDurationMs === undefined ? NaN : Number(value.lastConnectionDurationMs);
  return {
    reconnectCount: bounded(value?.reconnectCount, 1_000_000),
    reconnectAttempt: bounded(value?.reconnectAttempt, 1_000_000),
    processStartedAt: normalizeAgentText(value?.processStartedAt, 64),
    connectedAt: normalizeAgentText(value?.connectedAt, 64),
    lastDisconnectedAt: normalizeAgentText(value?.lastDisconnectedAt, 64),
    lastCloseCode: Number.isInteger(closeCode) && closeCode >= 0 && closeCode <= 4999 ? closeCode : null,
    lastDisconnectReason: normalizeAgentDiagnosticReason(value?.lastDisconnectReason),
    lastSocketError: normalizeAgentDiagnosticReason(value?.lastSocketError),
    lastConnectionDurationMs: Number.isFinite(duration) && duration >= 0 ? Math.min(Math.trunc(duration), 365 * 24 * 60 * 60 * 1000) : null,
    queues,
  };
}

export function readAgentAttachment(socket: WebSocket | null): AgentSocketAttachment {
  if (!socket) return {};
  try {
    const value = (socket as any).deserializeAttachment?.();
    return value && typeof value === "object" ? value as AgentSocketAttachment : {};
  } catch {
    return {};
  }
}

export function writeAgentAttachment(socket: WebSocket, patch: AgentSocketAttachment): void {
  try {
    const current = readAgentAttachment(socket);
    (socket as any).serializeAttachment?.({ ...current, ...patch });
  } catch {}
}

export function validAgentConnectionGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function nextAgentConnectionGeneration(stored: unknown): number {
  if (stored === undefined || stored === null) return 1;
  if (typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 0) {
    throw new Error("invalid_agent_connection_generation");
  }
  if (stored === Number.MAX_SAFE_INTEGER) throw new Error("agent_connection_generation_exhausted");
  return stored + 1;
}

export function agentConnectionGeneration(socket: WebSocket | null): number | null {
  return validAgentConnectionGeneration(readAgentAttachment(socket).connectionGeneration);
}

function legacyAgentSocketTimestamp(socket: WebSocket): number {
  const attachment = readAgentAttachment(socket);
  const timestamp = attachment.lastSeenAt ?? attachment.connectedAt;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}

export function selectLatestAgentSocket(sockets: WebSocket[]): WebSocket | null {
  const generated = sockets.filter((socket) => agentConnectionGeneration(socket) !== null);
  if (generated.length > 0) {
    return generated.reduce((latest, socket) =>
      agentConnectionGeneration(socket)! > agentConnectionGeneration(latest)! ? socket : latest);
  }

  // Compatibility for sockets accepted before connection generations existed.
  const legacy = sockets.filter((socket) => readAgentAttachment(socket).connectionGeneration === undefined);
  if (legacy.length === 0) return null;
  return legacy.reduce((latest, socket) =>
    legacyAgentSocketTimestamp(socket) > legacyAgentSocketTimestamp(latest) ? socket : latest);
}

export function isAuthoritativeAgentSocket(socket: WebSocket, authoritative: WebSocket | null): boolean {
  if (!authoritative) return false;
  const socketGeneration = agentConnectionGeneration(socket);
  const authoritativeGeneration = agentConnectionGeneration(authoritative);
  return socketGeneration !== null && authoritativeGeneration !== null
    ? socketGeneration === authoritativeGeneration
    : socket === authoritative;
}

export function agentLiveness(socket: WebSocket | null) {
  if (!socket) {
    return {
      online: false,
      connected: false,
      stale: false,
      heartbeatEnabled: false,
      connectedAt: null,
      lastSeenAt: null,
      heartbeatTtlMs: null,
      processId: null,
      protocolVersion: null,
      agentVersion: null,
      platform: null,
      arch: null,
      capabilities: [],
      lifecycle: null,
      health: null,
      connectionGeneration: null,
    };
  }
  const attachment = readAgentAttachment(socket);
  const heartbeatEnabled = attachment.heartbeatEnabled === true;
  const heartbeatMs = Number.isFinite(Number(attachment.heartbeatMs))
    ? Math.min(Math.max(Number(attachment.heartbeatMs), 5_000), 60_000)
    : null;
  const heartbeatTtlMs = heartbeatEnabled
    ? Math.min(MAX_AGENT_HEARTBEAT_TTL_MS, Math.max(DEFAULT_AGENT_HEARTBEAT_TTL_MS, (heartbeatMs ?? 15_000) * 3))
    : null;
  const lastSeenMs = Number.isFinite(Number(attachment.lastSeenAt)) ? Number(attachment.lastSeenAt) : null;
  const stale = heartbeatEnabled && (lastSeenMs === null || Date.now() - lastSeenMs > heartbeatTtlMs!);
  return {
    online: !stale,
    connected: true,
    stale,
    heartbeatEnabled,
    connectedAt: Number.isFinite(Number(attachment.connectedAt)) ? new Date(Number(attachment.connectedAt)).toISOString() : null,
    lastSeenAt: lastSeenMs === null ? null : new Date(lastSeenMs).toISOString(),
    heartbeatTtlMs,
    processId: Number.isFinite(Number(attachment.processId)) ? Number(attachment.processId) : null,
    protocolVersion: Number.isInteger(Number(attachment.protocolVersion)) ? Number(attachment.protocolVersion) : null,
    agentVersion: attachment.agentVersion ?? null,
    platform: attachment.platform ?? null,
    arch: attachment.arch ?? null,
    capabilities: Array.isArray(attachment.capabilities) ? attachment.capabilities : [],
    lifecycle: attachment.lifecycle ?? null,
    health: attachment.health ?? null,
    connectionGeneration: agentConnectionGeneration(socket),
  };
}
