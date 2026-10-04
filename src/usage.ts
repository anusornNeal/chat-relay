import { DurableObject } from "cloudflare:workers";
import type { DashboardTopic } from "./dashboard-hub";
import { UsageAggregates } from "./usage-aggregates";

type UsageEnv = { DASHBOARD: DurableObjectNamespace };

async function publishDashboard(
  env: UsageEnv,
  topics: DashboardTopic[],
  userId?: string,
  event?: Record<string, unknown>,
) {
  try {
    const stub = env.DASHBOARD.get(env.DASHBOARD.idFromName("global"));
    await stub.fetch(new Request("https://dashboard.internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topics,
        ...(userId ? { userId } : {}),
        ...(event ? { event } : {}),
      }),
    }));
  } catch {}
}

export type UsageEvent = {
  userId: string;
  tool: string;
  agentId?: string;
  toolCallId?: string;
  activityId?: string;
  startedAt?: string;
  timestamp: string;
  durationMs: number;
  ok: boolean;
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
  requestBytes: number;
  responseBytes: number;
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

const CLEANUP_STATUS_KEY = "ops:cleanup:last";

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

function fallbackActivityId(toolCallId: string) {
  const clean = toolCallId.replace(/^tc_/, "").replace(/[^a-zA-Z0-9]/g, "");
  return "call_" + (clean.slice(0, 12) || "unknown");
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
    this.aggregates = new UsageAggregates(ctx.storage, () => false);
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
      if (!body || !body.userId || !body.tool || !body.timestamp) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const timestampMs = Date.parse(String(body.timestamp));
      if (!Number.isFinite(timestampMs)) return Response.json({ error: "invalid_usage_timestamp" }, { status: 400 });
      const event: UsageEvent = {
        userId: String(body.userId).slice(0, 128),
        tool: String(body.tool).slice(0, 160),
        ...(body.agentId ? { agentId: String(body.agentId).slice(0, 128) } : {}),
        ...(body.toolCallId ? { toolCallId: String(body.toolCallId).slice(0, 96) } : {}),
        ...(body.activityId
          ? { activityId: String(body.activityId).slice(0, 96) }
          : body.toolCallId
            ? { activityId: fallbackActivityId(String(body.toolCallId).slice(0, 96)) }
            : {}),
        ...(body.startedAt ? { startedAt: String(body.startedAt) } : {}),
        timestamp: new Date(timestampMs).toISOString(),
        durationMs: Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : 0,
        ok: body.ok === true,
        ...(body.errorClass ? { errorClass: String(body.errorClass).slice(0, 80) } : {}),
        ...(body.errorSource ? { errorSource: String(body.errorSource).slice(0, 40) } : {}),
        ...(body.errorCode ? { errorCode: String(body.errorCode).slice(0, 80) } : {}),
        ...(Number.isFinite(Number(body.statusCode)) ? { statusCode: Number(body.statusCode) } : {}),
        ...(body.exitCode === null || Number.isFinite(Number(body.exitCode)) ? { exitCode: body.exitCode === null ? null : Number(body.exitCode) } : {}),
        ...(Number.isFinite(Number(body.workerOverheadMs)) ? { workerOverheadMs: Math.max(0, Math.min(120000, Math.round(Number(body.workerOverheadMs)))) } : {}),
        ...(Number.isFinite(Number(body.relayRoundTripMs)) ? { relayRoundTripMs: Math.max(0, Math.min(120000, Math.round(Number(body.relayRoundTripMs)))) } : {}),
        ...(Number.isFinite(Number(body.transportMs)) ? { transportMs: Math.max(0, Math.min(120000, Math.round(Number(body.transportMs)))) } : {}),
        ...(Number.isFinite(Number(body.agentQueueWaitMs)) ? { agentQueueWaitMs: Math.max(0, Math.min(120000, Math.round(Number(body.agentQueueWaitMs)))) } : {}),
        ...(Number.isFinite(Number(body.agentHandlerMs)) ? { agentHandlerMs: Math.max(0, Math.min(120000, Math.round(Number(body.agentHandlerMs)))) } : {}),
        requestBytes: Number.isFinite(Number(body.requestBytes)) ? Number(body.requestBytes) : 0,
        responseBytes: Number.isFinite(Number(body.responseBytes)) ? Number(body.responseBytes) : 0,
      };
      await this.ctx.storage.transaction(async txn => {
        await this.aggregates.record(txn, event);
      });
      this.aggregates.invalidate(event);
      const now = Date.now();
      const lastPublishedAt = this.lastOverviewPublishAt.get(event.userId) || 0;
      if (now - lastPublishedAt >= 60_000) {
        this.lastOverviewPublishAt.set(event.userId, now);
        await publishDashboard(this.usageEnv, ["overview"], event.userId);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/cleanup" && request.method === "POST") {
      const body = await request.json<any>().catch(() => ({}));
      const retentionDays = boundedInt(body?.retentionDays, 30, 0, 3650);
      const limit = boundedInt(body?.limit, 250, 1, 1000);
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const records = await this.ctx.storage.list<UsageEvent>({
        prefix: "event:",
        limit: Math.min(1000, limit * 4),
      });
      const keys: string[] = [];
      let scanned = 0;
      for (const [key, event] of records) {
        scanned++;
        if (Date.parse(event.timestamp) < cutoffMs) keys.push(key);
        if (keys.length >= limit) break;
      }
      const preserved: string[] = [];
      await this.ctx.storage.transaction(async txn => {
        for (const key of keys) if (await this.aggregates.preserve(txn, records.get(key)!)) preserved.push(key);
        for (let offset = 0; offset < preserved.length; offset += 128) await txn.delete(preserved.slice(offset,offset+128));
      });
      this.aggregates.invalidate();
      const status = {
        ranAt: new Date().toISOString(),
        retentionDays,
        scanned,
        deleted: preserved.length,
        skipped: keys.length - preserved.length,
        aggregatesPreserved: true,
        bounded: true,
      };
      await this.ctx.storage.put(CLEANUP_STATUS_KEY, status);
      return Response.json({ ok: true, ...status });
    }

    if (url.pathname === "/ops/status" && request.method === "GET") {
      const lastCleanup = await this.ctx.storage.get(CLEANUP_STATUS_KEY);
      return Response.json({ ok: true, lastCleanup: lastCleanup ?? null });
    }

    if (url.pathname === "/window" && request.method === "GET") {
      const fromMs = Date.parse(url.searchParams.get("from") || "");
      const toMs = Date.parse(url.searchParams.get("to") || "");
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > 31 * 24 * 60 * 60 * 1000) {
        return Response.json({ error: "invalid_usage_window" }, { status: 400 });
      }

      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      return Response.json(await this.aggregates.window(fromMs,toMs,{userId,tool,agentId}));
    }

    if (url.pathname === "/summary" && request.method === "GET") {
      const hours = boundedInt(url.searchParams.get("hours"), 24, 1, 720);
      const userId = url.searchParams.get("userId"), tool = url.searchParams.get("tool"), agentId = url.searchParams.get("agentId");
      const now = Date.now();
      const summary = await this.aggregates.window(now-hours*3600000,now,{userId,tool,agentId},false);
      return Response.json({ hours, metric: summary.metric, activeCalls: 0, sampleSize: summary.sampleSize,
        bounded: summary.bounded, coverage: summary.coverage, p95Approximate: true });
    }

    if (url.pathname === "/query" && request.method === "GET") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      const filters = { userId, tool, agentId };

      if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        const start = Date.parse(from + "T00:00:00.000Z");
        const end = Date.parse(to + "T00:00:00.000Z");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 30 * 86400000) {
          return Response.json({ error: "invalid_usage_range" }, { status: 400 });
        }
        const days = [];
        for (let ts = start; ts <= end; ts += 86400000) {
          const rangeDay = new Date(ts).toISOString().slice(0, 10);
          const summary = await this.aggregates.window(ts, ts + 86400000 - 1, filters, false);
          days.push({ day: rangeDay, metric: summary.metric });
        }
        return Response.json({ from, to, days });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return Response.json({ error: "invalid_usage_day" }, { status: 400 });
      }
      const start = Date.parse(day + "T00:00:00.000Z");
      const summary = await this.aggregates.window(start, start + 86400000 - 1, filters, false);
      return Response.json({ day, metric: summary.metric });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
