export type AgentSocketAttachment = {
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
    lastDisconnectReason: string | null;
    queues: Record<string, { concurrency: number; active: number; queued: number; maxQueued: number; queueTimeoutMs: number }>;
  };
};

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
  return {
    reconnectCount: bounded(value?.reconnectCount, 1_000_000),
    reconnectAttempt: bounded(value?.reconnectAttempt, 1_000_000),
    lastDisconnectReason: normalizeAgentText(value?.lastDisconnectReason, 160),
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
  };
}
