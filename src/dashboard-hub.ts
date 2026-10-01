import { DurableObject } from "cloudflare:workers";

export const DASHBOARD_TOPICS = ["overview", "calls", "users", "errors", "agents"] as const;
export type DashboardTopic = typeof DASHBOARD_TOPICS[number];

type DashboardHubEnv = {
  REGISTRY: DurableObjectNamespace;
};

type DashboardSocketAttachment = {
  userId: string;
  admin: boolean;
};

type DashboardLifecycleEvent = {
  type: "tool_started" | "tool_finished";
  userId: string;
  tool: string;
  toolCallId: string;
  activityId?: string;
  agentId?: string;
  agentName?: string;
  startedAt: string;
  timestamp?: string;
  durationMs?: number;
  status?: "success" | "error";
  ok?: boolean;
  errorClass?: string;
  errorSource?: string;
  errorCode?: string;
  failureStage?: string;
  retryable?: boolean;
  statusCode?: number;
  exitCode?: number | null;
};

type DashboardPublishEvent = {
  topics?: unknown;
  userId?: unknown;
  event?: unknown;
};

const topicSet = new Set<string>(DASHBOARD_TOPICS);

function normalizeTopics(value: unknown): DashboardTopic[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((topic): topic is string => typeof topic === "string" && topicSet.has(topic))
    .slice(0, DASHBOARD_TOPICS.length))] as DashboardTopic[];
}

function safeString(value: unknown, maxLength: number) {
  return typeof value === "string" && value ? value.slice(0, maxLength) : "";
}

function safeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeLifecycleEvent(value: unknown): DashboardLifecycleEvent | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const type = input.type === "tool_started" || input.type === "tool_finished" ? input.type : null;
  if (!type) return null;

  const userId = safeString(input.userId, 128);
  const tool = safeString(input.tool, 160);
  const toolCallId = safeString(input.toolCallId, 96);
  const startedAt = safeString(input.startedAt, 64);
  if (!userId || !tool || !toolCallId || !Number.isFinite(Date.parse(startedAt))) return null;

  const event: DashboardLifecycleEvent = {
    type,
    userId,
    tool,
    toolCallId,
    startedAt,
  };
  const activityId = safeString(input.activityId, 96);
  const agentId = safeString(input.agentId, 128);
  if (activityId) event.activityId = activityId;
  if (agentId) event.agentId = agentId;

  if (type === "tool_finished") {
    const timestamp = safeString(input.timestamp, 64);
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
    event.timestamp = timestamp;
    event.durationMs = Math.max(0, safeNumber(input.durationMs) ?? 0);
    event.ok = input.ok === true;
    event.status = event.ok ? "success" : "error";

    for (const [key, maxLength] of [
      ["errorClass", 80],
      ["errorSource", 40],
      ["errorCode", 80],
      ["failureStage", 40],
    ] as const) {
      const text = safeString(input[key], maxLength);
      if (text) (event as any)[key] = text;
    }
    if (typeof input.retryable === "boolean") event.retryable = input.retryable;
    const statusCode = safeNumber(input.statusCode);
    if (statusCode !== undefined) event.statusCode = statusCode;
    if (input.exitCode === null) event.exitCode = null;
    else {
      const exitCode = safeNumber(input.exitCode);
      if (exitCode !== undefined) event.exitCode = exitCode;
    }
  }

  return event;
}

export class DashboardHub extends DurableObject {
  private readonly hubEnv: DashboardHubEnv;
  private readonly agentNames = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: DashboardHubEnv) {
    super(ctx, env);
    this.hubEnv = env;
  }

  private async enrichLifecycle(event: DashboardLifecycleEvent | null) {
    if (!event?.agentId) return event;
    let agentName = this.agentNames.get(event.agentId);
    if (!agentName) {
      try {
        const stub = this.hubEnv.REGISTRY.get(this.hubEnv.REGISTRY.idFromName("global"));
        const response = await stub.fetch("https://registry.internal/state");
        if (response.ok) {
          const state = await response.json<any>();
          agentName = String((state.agents ?? []).find((agent: any) => agent.id === event.agentId)?.name || "").slice(0, 120);
          if (agentName) this.agentNames.set(event.agentId, agentName);
        }
      } catch {}
    }
    return agentName ? { ...event, agentName } : event;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "websocket_required" }, { status: 426 });
      }
      const userId = (request.headers.get("x-dashboard-user-id") || "").slice(0, 160);
      if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
      const admin = request.headers.get("x-dashboard-admin") === "1";

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ userId, admin } satisfies DashboardSocketAttachment);
      server.send(JSON.stringify({ type: "ready", at: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      const body = await request.json<DashboardPublishEvent>().catch(() => ({}));
      const topics = normalizeTopics(body.topics);
      if (topics.includes("agents")) this.agentNames.clear();
      const lifecycle = await this.enrichLifecycle(normalizeLifecycleEvent(body.event));
      if (!topics.length && !lifecycle) return Response.json({ ok: true, delivered: 0 });

      const requestedAudience = safeString(body.userId, 128);
      const audienceUserId = requestedAudience || lifecycle?.userId || "";
      const payloads = [
        ...(lifecycle ? [JSON.stringify(lifecycle)] : []),
        ...(topics.length ? [JSON.stringify({
          type: "invalidate",
          topics,
          at: new Date().toISOString(),
        })] : []),
      ];

      let delivered = 0;
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as DashboardSocketAttachment | null;
        if (!attachment) continue;
        if (audienceUserId && !attachment.admin && attachment.userId !== audienceUserId) continue;
        try {
          for (const payload of payloads) socket.send(payload);
          delivered += 1;
        } catch {
          try { socket.close(1011, "send_failed"); } catch {}
        }
      }
      return Response.json({ ok: true, delivered });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({ connections: this.ctx.getWebSockets().length });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 256) return;
    let data: unknown;
    try { data = JSON.parse(message); } catch { return; }
    if ((data as { type?: unknown })?.type !== "ping") return;
    try {
      socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
    } catch {}
  }

  webSocketClose(): void {}
  webSocketError(): void {}
}
