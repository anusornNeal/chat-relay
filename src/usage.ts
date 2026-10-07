import { DurableObject } from "cloudflare:workers";
import type { DashboardTopic } from "./dashboard-hub";
import { UsageAggregates } from "./usage-aggregates";
import { DailyOptionalBudget } from "./usage-budget.mjs";

type UsageEnv = {
  DASHBOARD: DurableObjectNamespace;
  USAGE_DASHBOARD_PUBLISH_DAILY_BUDGET?: string;
};

async function publishDashboard(
  env: UsageEnv,
  topics: DashboardTopic[],
  userId?: string,
) {
  try {
    const stub = env.DASHBOARD.get(env.DASHBOARD.idFromName("global"));
    await stub.fetch(new Request("https://dashboard.internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topics, ...(userId ? { userId } : {}) }),
    }));
  } catch {}
}

export type UsageEvent = {
  userId: string;
  agentId?: string;
  timestamp: string;
  // Kept optional for rolling compatibility; rich fields are folded into hourly aggregates, never raw history.
  tool?: string;
  toolCallId?: string;
  activityId?: string;
  startedAt?: string;
  durationMs?: number;
  ok?: boolean;
  errorClass?: string;
  errorSource?: string;
  errorCode?: string;
  failureStage?: string;
  retryable?: boolean;
  statusCode?: number;
  exitCode?: number | null;
  workerOverheadMs?: number;
  relayRoundTripMs?: number;
  transportMs?: number;
  agentQueueWaitMs?: number;
  agentHandlerMs?: number;
  requestBytes?: number;
  responseBytes?: number;
};

function normalizeUsageEvent(body: any): { event?: UsageEvent; skipped?: true; error?: string } {
  if (!body?.userId || !body?.timestamp) return { error: "invalid_usage_event" };
  const timestampMs = Date.parse(String(body.timestamp));
  if (!Number.isFinite(timestampMs)) return { error: "invalid_usage_timestamp" };

  const agentId = body.agentId ? String(body.agentId).slice(0, 128) : "";
  if (!agentId || agentId === "__relay__") return { skipped: true };

  return {
    event: {
      userId: String(body.userId).slice(0, 128),
      agentId,
      timestamp: new Date(timestampMs).toISOString(),
      ...(body.tool ? { tool: String(body.tool).slice(0, 128) } : {}),
      durationMs: Number.isFinite(Number(body.durationMs))
        ? Math.min(120_000, Math.max(0, Math.round(Number(body.durationMs))))
        : 0,
      ok: body.ok !== false,
      ...(body.errorClass ? { errorClass: String(body.errorClass).slice(0, 80) } : {}),
      ...(body.errorSource ? { errorSource: String(body.errorSource).slice(0, 80) } : {}),
      ...(body.errorCode ? { errorCode: String(body.errorCode).slice(0, 80) } : {}),
      ...(body.failureStage ? { failureStage: String(body.failureStage).slice(0, 80) } : {}),
      ...(Number.isFinite(Number(body.requestBytes)) ? { requestBytes: Math.max(0, Math.round(Number(body.requestBytes))) } : {}),
      ...(Number.isFinite(Number(body.responseBytes)) ? { responseBytes: Math.max(0, Math.round(Number(body.responseBytes))) } : {}),
    },
  };
}

export class Usage extends DurableObject {
  private readonly usageEnv: UsageEnv;
  private readonly aggregates: UsageAggregates;
  private readonly lastOverviewPublishAt = new Map<string, number>();
  private readonly dashboardPublishBudget = new DailyOptionalBudget();

  constructor(ctx: DurableObjectState, env: UsageEnv) {
    super(ctx, env);
    this.usageEnv = env;
    this.aggregates = new UsageAggregates(ctx.storage);
  }

  private async publishOverviewForUsers(userIds: Iterable<string>) {
    const now = Date.now();
    for (const userId of new Set(userIds)) {
      const lastPublishedAt = this.lastOverviewPublishAt.get(userId) || 0;
      if (now - lastPublishedAt < 60_000) continue;
      this.lastOverviewPublishAt.set(userId, now);
      const publishBudget = this.dashboardPublishBudget.consume(
        this.usageEnv.USAGE_DASHBOARD_PUBLISH_DAILY_BUDGET,
        now,
      );
      if (publishBudget.allowed) {
        await publishDashboard(this.usageEnv, ["overview"], userId);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/budget/status" && request.method === "GET") {
      return Response.json({
        dashboardPublish: this.dashboardPublishBudget.snapshot(
          this.usageEnv.USAGE_DASHBOARD_PUBLISH_DAILY_BUDGET,
        ),
      });
    }

    if (url.pathname === "/record" && request.method === "POST") {
      const body = await request.json<UsageEvent>().catch(() => null);
      const normalized = normalizeUsageEvent(body);
      if (normalized.error) return Response.json({ error: normalized.error }, { status: 400 });
      if (normalized.skipped || !normalized.event) return Response.json({ ok: true, skipped: true });

      await this.aggregates.record(normalized.event);
      await this.publishOverviewForUsers([normalized.event.userId]);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/record-batch" && request.method === "POST") {
      const body = await request.json<{ events?: UsageEvent[] }>().catch(() => null);
      if (!Array.isArray(body?.events) || body.events.length === 0 || body.events.length > 256) {
        return Response.json({ error: "invalid_usage_batch" }, { status: 400 });
      }

      const events: UsageEvent[] = [];
      let skipped = 0;
      for (const raw of body.events) {
        const normalized = normalizeUsageEvent(raw);
        if (normalized.error) return Response.json({ error: normalized.error }, { status: 400 });
        if (normalized.skipped || !normalized.event) {
          skipped += 1;
          continue;
        }
        events.push(normalized.event);
      }

      if (events.length) {
        await this.aggregates.recordBatch(events);
        await this.publishOverviewForUsers(events.map((event) => event.userId));
      }
      return Response.json({ ok: true, accepted: events.length, skipped });
    }

    if (url.pathname === "/window" && request.method === "GET") {
      const fromMs = Date.parse(url.searchParams.get("from") || "");
      const toMs = Date.parse(url.searchParams.get("to") || "");
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
          toMs < fromMs || toMs - fromMs > 31 * 24 * 60 * 60 * 1000) {
        return Response.json({ error: "invalid_usage_window" }, { status: 400 });
      }

      const userId = url.searchParams.get("userId");
      const agentId = url.searchParams.get("agentId");
      const includeDetails = url.searchParams.get("details") === "1";
      return Response.json(await this.aggregates.window(fromMs, toMs, { userId, agentId }, includeDetails));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
