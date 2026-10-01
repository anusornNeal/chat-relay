import { DurableObject } from "cloudflare:workers";

export const DASHBOARD_TOPICS = ["overview", "calls", "users", "errors", "agents"] as const;
export type DashboardTopic = typeof DASHBOARD_TOPICS[number];

type DashboardSocketAttachment = {
  userId: string;
  admin: boolean;
};

type DashboardPublishEvent = {
  topics?: unknown;
  userId?: unknown;
};

const topicSet = new Set<string>(DASHBOARD_TOPICS);

function normalizeTopics(value: unknown): DashboardTopic[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((topic): topic is string => typeof topic === "string" && topicSet.has(topic))
    .slice(0, DASHBOARD_TOPICS.length))] as DashboardTopic[];
}

export class DashboardHub extends DurableObject {
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
      if (!topics.length) return Response.json({ ok: true, delivered: 0 });

      const audienceUserId = typeof body.userId === "string" ? body.userId.slice(0, 160) : "";
      const payload = JSON.stringify({
        type: "invalidate",
        topics,
        at: new Date().toISOString(),
      });

      let delivered = 0;
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as DashboardSocketAttachment | null;
        if (!attachment) continue;
        if (audienceUserId && !attachment.admin && attachment.userId !== audienceUserId) continue;
        try {
          socket.send(payload);
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
