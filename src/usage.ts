import { DurableObject } from "cloudflare:workers";

export type UsageEvent = {
  userId: string;
  tool: string;
  agentId?: string;
  timestamp: string;
  durationMs: number;
  ok: boolean;
  errorClass?: string;
  requestBytes: number;
  responseBytes: number;
};

type Metric = {
  calls: number;
  errors: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  minDurationMs: number;
  maxDurationMs: number;
};

const emptyMetric = (): Metric => ({
  calls: 0,
  errors: 0,
  durationMs: 0,
  requestBytes: 0,
  responseBytes: 0,
  minDurationMs: Number.MAX_SAFE_INTEGER,
  maxDurationMs: 0,
});

function addMetric(metric: Metric | undefined, event: UsageEvent): Metric {
  const next = metric ?? emptyMetric();
  next.calls += 1;
  next.errors += event.ok ? 0 : 1;
  next.durationMs += Math.max(0, Math.round(event.durationMs));
  next.requestBytes += Math.max(0, Math.round(event.requestBytes));
  next.responseBytes += Math.max(0, Math.round(event.responseBytes));
  next.minDurationMs = Math.min(next.minDurationMs, Math.max(0, Math.round(event.durationMs)));
  next.maxDurationMs = Math.max(next.maxDurationMs, Math.max(0, Math.round(event.durationMs)));
  return next;
}

function publicMetric(metric: Metric | undefined) {
  if (!metric) return null;
  return {
    ...metric,
    minDurationMs: metric.calls ? metric.minDurationMs : 0,
    avgDurationMs: metric.calls ? metric.durationMs / metric.calls : 0,
    errorRate: metric.calls ? metric.errors / metric.calls : 0,
  };
}

function safePart(value: string) {
  return encodeURIComponent(value.slice(0, 160));
}

export class Usage extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/record" && request.method === "POST") {
      const body = await request.json<UsageEvent>().catch(() => null);
      if (!body || !body.userId || !body.tool || !body.timestamp) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const event: UsageEvent = {
        userId: String(body.userId).slice(0, 128),
        tool: String(body.tool).slice(0, 160),
        ...(body.agentId ? { agentId: String(body.agentId).slice(0, 128) } : {}),
        timestamp: String(body.timestamp),
        durationMs: Number(body.durationMs) || 0,
        ok: body.ok === true,
        ...(body.errorClass ? { errorClass: String(body.errorClass).slice(0, 80) } : {}),
        requestBytes: Number(body.requestBytes) || 0,
        responseBytes: Number(body.responseBytes) || 0,
      };
      const day = event.timestamp.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return Response.json({ error: "invalid_usage_timestamp" }, { status: 400 });
      }

      const metricKeys = [
        `day:${day}:total`,
        `day:${day}:user:${safePart(event.userId)}`,
        `day:${day}:tool:${safePart(event.tool)}`,
        ...(event.agentId ? [`day:${day}:agent:${safePart(event.agentId)}`] : []),
      ];
      const existing = await Promise.all(metricKeys.map((key) => this.ctx.storage.get<Metric>(key)));
      const writes: Record<string, Metric> = {};
      metricKeys.forEach((key, index) => {
        writes[key] = addMetric(existing[index], event);
      });

      const eventKey = `event:${event.timestamp}:${crypto.randomUUID()}`;
      await this.ctx.storage.put({
        ...writes,
        [eventKey]: event,
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/query" && request.method === "GET") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      const key = userId
        ? `day:${day}:user:${safePart(userId)}`
        : tool
          ? `day:${day}:tool:${safePart(tool)}`
          : agentId
            ? `day:${day}:agent:${safePart(agentId)}`
            : `day:${day}:total`;
      const metric = await this.ctx.storage.get<Metric>(key);
      const recentLimit = Math.max(0, Math.min(100, Number(url.searchParams.get("recentLimit")) || 0));
      let recent: UsageEvent[] = [];
      if (recentLimit > 0) {
        const events = await this.ctx.storage.list<UsageEvent>({ prefix: "event:", reverse: true, limit: recentLimit });
        recent = [...events.values()].filter((event) =>
          (!userId || event.userId === userId) &&
          (!tool || event.tool === tool) &&
          (!agentId || event.agentId === agentId)
        ).slice(0, recentLimit);
      }
      return Response.json({ day, metric: publicMetric(metric), recent });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
