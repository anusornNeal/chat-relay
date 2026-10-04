import { DurableObject } from "cloudflare:workers";
import type { DashboardTopic } from "./dashboard-hub";
import { UsageAggregates } from "./usage-aggregates";

type UsageEnv = { DASHBOARD: DurableObjectNamespace };

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
  // Kept optional for source compatibility with callers; usage storage no longer persists them.
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

export type QuotaPolicy = {
  rateLimit: number;
  rateWindowSeconds: number;
  dailyCallQuota: number;
};

type QuotaState = {
  rateWindowStartMs: number;
  rateCount: number;
  day: string;
  dayCount: number;
  updatedAt: string;
};

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  rateLimit: 0,
  rateWindowSeconds: 60,
  dailyCallQuota: 0,
};

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export function normalizeQuotaPolicy(
  value: Partial<QuotaPolicy> | null | undefined,
  fallback: QuotaPolicy = DEFAULT_QUOTA_POLICY,
): QuotaPolicy {
  return {
    rateLimit: boundedInt(value?.rateLimit, fallback.rateLimit, 0, 100000),
    rateWindowSeconds: boundedInt(value?.rateWindowSeconds, fallback.rateWindowSeconds, 1, 3600),
    dailyCallQuota: boundedInt(value?.dailyCallQuota, fallback.dailyCallQuota, 0, 10000000),
  };
}

function safePart(value: string) {
  return encodeURIComponent(value.slice(0, 160));
}

function nextUtcDay(nowMs: number) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export class Usage extends DurableObject {
  private readonly usageEnv: UsageEnv;
  private readonly aggregates: UsageAggregates;
  private readonly lastOverviewPublishAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: UsageEnv) {
    super(ctx, env);
    this.usageEnv = env;
    this.aggregates = new UsageAggregates(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/quota/policy") {
      if (request.method === "GET") {
        const policy = await this.ctx.storage.get<QuotaPolicy>("quota:policy");
        return Response.json({ policy: policy ?? null });
      }
      if (request.method === "POST") {
        const body = await request.json<Partial<QuotaPolicy>>().catch(() => null);
        if (!body ||
            !Number.isFinite(Number(body.rateLimit)) ||
            !Number.isFinite(Number(body.rateWindowSeconds)) ||
            !Number.isFinite(Number(body.dailyCallQuota))) {
          return Response.json({ error: "invalid_quota_policy" }, { status: 400 });
        }
        const policy = normalizeQuotaPolicy(body);
        await this.ctx.storage.put("quota:policy", policy);
        return Response.json({ ok: true, policy });
      }
      if (request.method === "DELETE") {
        await this.ctx.storage.delete("quota:policy");
        return Response.json({ ok: true, policy: null });
      }
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    if (url.pathname === "/quota/check" && request.method === "POST") {
      const body = await request.json<any>().catch(() => null);
      const userId = String(body?.userId ?? "").slice(0, 128);
      if (!userId) return Response.json({ error: "user_id_required" }, { status: 400 });

      const nowMs = Number.isFinite(Number(body?.nowMs)) ? Number(body.nowMs) : Date.now();
      const defaultPolicy = normalizeQuotaPolicy(body?.defaultPolicy);
      const override = await this.ctx.storage.get<QuotaPolicy>("quota:policy");
      const policy = normalizeQuotaPolicy(override ?? defaultPolicy, defaultPolicy);
      const windowMs = policy.rateWindowSeconds * 1000;
      const rateWindowStartMs = Math.floor(nowMs / windowMs) * windowMs;
      const rateResetAt = new Date(rateWindowStartMs + windowMs).toISOString();
      const dailyResetAt = new Date(nextUtcDay(nowMs)).toISOString();

      if (policy.rateLimit === 0 && policy.dailyCallQuota === 0) {
        return Response.json({
          allowed: true,
          policy,
          source: override ? "admin" : "environment",
          rateRemaining: null,
          dailyRemaining: null,
          rateResetAt,
          dailyResetAt,
        });
      }

      const key = "quota:user:" + safePart(userId);
      const decision = await this.ctx.storage.transaction(async (txn) => {
        const day = new Date(nowMs).toISOString().slice(0, 10);
        const existing = await txn.get<QuotaState>(key);
        const state: QuotaState = {
          rateWindowStartMs,
          rateCount: existing?.rateWindowStartMs === rateWindowStartMs ? existing.rateCount : 0,
          day,
          dayCount: existing?.day === day ? existing.dayCount : 0,
          updatedAt: new Date(nowMs).toISOString(),
        };

        if (policy.rateLimit > 0 && state.rateCount >= policy.rateLimit) {
          return {
            allowed: false,
            code: "rate_limited",
            policy,
            source: override ? "admin" : "environment",
            retryAt: rateResetAt,
            resetAt: rateResetAt,
            remaining: 0,
          };
        }
        if (policy.dailyCallQuota > 0 && state.dayCount >= policy.dailyCallQuota) {
          return {
            allowed: false,
            code: "quota_exceeded",
            policy,
            source: override ? "admin" : "environment",
            retryAt: dailyResetAt,
            resetAt: dailyResetAt,
            remaining: 0,
          };
        }

        if (policy.rateLimit > 0) state.rateCount += 1;
        if (policy.dailyCallQuota > 0) state.dayCount += 1;
        await txn.put(key, state);
        return {
          allowed: true,
          policy,
          source: override ? "admin" : "environment",
          rateRemaining: policy.rateLimit > 0 ? Math.max(0, policy.rateLimit - state.rateCount) : null,
          dailyRemaining: policy.dailyCallQuota > 0 ? Math.max(0, policy.dailyCallQuota - state.dayCount) : null,
          rateResetAt,
          dailyResetAt,
        };
      });
      return Response.json(decision);
    }

    if (url.pathname === "/record" && request.method === "POST") {
      const body = await request.json<UsageEvent>().catch(() => null);
      if (!body?.userId || !body?.timestamp) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const timestampMs = Date.parse(String(body.timestamp));
      if (!Number.isFinite(timestampMs)) {
        return Response.json({ error: "invalid_usage_timestamp" }, { status: 400 });
      }

      const event: UsageEvent = {
        userId: String(body.userId).slice(0, 128),
        agentId: body.agentId ? String(body.agentId).slice(0, 128) : "__relay__",
        timestamp: new Date(timestampMs).toISOString(),
      };

      await this.aggregates.record(event);

      const now = Date.now();
      const lastPublishedAt = this.lastOverviewPublishAt.get(event.userId) || 0;
      if (now - lastPublishedAt >= 60_000) {
        this.lastOverviewPublishAt.set(event.userId, now);
        await publishDashboard(this.usageEnv, ["overview"], event.userId);
      }
      return Response.json({ ok: true });
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
      return Response.json(await this.aggregates.window(fromMs, toMs, { userId, agentId }));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
