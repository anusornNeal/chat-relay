import { DurableObject } from "cloudflare:workers";

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
  statusCode?: number;
  exitCode?: number | null;
  requestBytes: number;
  responseBytes: number;
};

type ActiveUsageEvent = {
  userId: string;
  tool: string;
  agentId?: string;
  toolCallId: string;
  activityId?: string;
  startedAt: string;
};

export type QuotaPolicy = {
  rateLimit: number;
  rateWindowSeconds: number;
  dailyCallQuota: number;
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

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
}

function safePart(value: string) {
  return encodeURIComponent(value.slice(0, 160));
}

function nextUtcDay(nowMs: number) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export class Usage extends DurableObject {
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
      const key = "quota:user:" + safePart(userId);

      const decision = await this.ctx.storage.transaction(async (txn) => {
        const override = await txn.get<QuotaPolicy>("quota:policy");
        const policy = normalizeQuotaPolicy(override ?? defaultPolicy, defaultPolicy);
        const windowMs = policy.rateWindowSeconds * 1000;
        const rateWindowStartMs = Math.floor(nowMs / windowMs) * windowMs;
        const day = new Date(nowMs).toISOString().slice(0, 10);
        const existing = await txn.get<QuotaState>(key);
        const state: QuotaState = {
          rateWindowStartMs,
          rateCount: existing?.rateWindowStartMs === rateWindowStartMs ? existing.rateCount : 0,
          day,
          dayCount: existing?.day === day ? existing.dayCount : 0,
          updatedAt: new Date(nowMs).toISOString(),
        };
        const rateResetAt = new Date(rateWindowStartMs + windowMs).toISOString();
        const dailyResetAt = new Date(nextUtcDay(nowMs)).toISOString();

        if (policy.rateLimit > 0 && state.rateCount >= policy.rateLimit) {
          await txn.put(key, state);
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
          await txn.put(key, state);
          return {
            allowed: false,
            code: "quota_exceeded",
            policy,
            source: override ? "admin" : "environment",
            retryAt: dailyResetAt,
            resetAt: dailyResetAt,            remaining: 0,
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

    if (url.pathname === "/activity/start" && request.method === "POST") {
      const body = await request.json<any>().catch(() => null);
      const userId = String(body?.userId ?? "").slice(0, 128);
      const tool = String(body?.tool ?? "").slice(0, 160);
      const toolCallId = String(body?.toolCallId ?? "").slice(0, 96);
      const startedAt = String(body?.startedAt ?? body?.timestamp ?? "");
      if (!userId || !tool || !toolCallId || !Number.isFinite(Date.parse(startedAt))) {
        return Response.json({ error: "invalid_active_usage_event" }, { status: 400 });
      }
      const event: ActiveUsageEvent = {
        userId,
        tool,
        toolCallId,
        startedAt,
        ...(body?.agentId ? { agentId: String(body.agentId).slice(0, 128) } : {}),
        ...(body?.activityId ? { activityId: String(body.activityId).slice(0, 96) } : {}),
      };
      await this.ctx.storage.put("active:" + safePart(toolCallId), event);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/record" && request.method === "POST") {
      const body = await request.json<UsageEvent>().catch(() => null);
      if (!body || !body.userId || !body.tool || !body.timestamp) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const event: UsageEvent = {
        userId: String(body.userId).slice(0, 128),
        tool: String(body.tool).slice(0, 160),
        ...(body.agentId ? { agentId: String(body.agentId).slice(0, 128) } : {}),
        ...(body.toolCallId ? { toolCallId: String(body.toolCallId).slice(0, 96) } : {}),
        ...(body.activityId ? { activityId: String(body.activityId).slice(0, 96) } : {}),
        ...(body.startedAt ? { startedAt: String(body.startedAt) } : {}),
        timestamp: String(body.timestamp),
        durationMs: Number(body.durationMs) || 0,
        ok: body.ok === true,
        ...(body.errorClass ? { errorClass: String(body.errorClass).slice(0, 80) } : {}),
        ...(Number.isFinite(Number(body.statusCode)) ? { statusCode: Number(body.statusCode) } : {}),
        ...(body.exitCode === null || Number.isFinite(Number(body.exitCode)) ? { exitCode: body.exitCode === null ? null : Number(body.exitCode) } : {}),
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

      if (event.toolCallId) await this.ctx.storage.delete("active:" + safePart(event.toolCallId));
      const eventKey = `event:${event.timestamp}:${crypto.randomUUID()}`;
      await this.ctx.storage.put({
        ...writes,
        [eventKey]: event,
      });
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
      if (keys.length) await this.ctx.storage.delete(keys);
      const status = {
        ranAt: new Date().toISOString(),
        retentionDays,
        scanned,
        deleted: keys.length,
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

    if (url.pathname === "/summary" && request.method === "GET") {
      const hours = boundedInt(url.searchParams.get("hours"), 24, 1, 720);
      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
      const records = await this.ctx.storage.list<UsageEvent>({ prefix: "event:", reverse: true, limit: 1000 });
      const events = [...records.values()].filter((event) => {
        const when = Date.parse(event.timestamp);
        return when >= cutoffMs && (!userId || event.userId === userId) &&
          (!tool || event.tool === tool) && (!agentId || event.agentId === agentId);
      });
      let metric: Metric | undefined;
      for (const event of events) metric = addMetric(metric, event);
      const activeRecords = await this.ctx.storage.list<ActiveUsageEvent>({ prefix: "active:", limit: 1000 });
      const activeCutoffMs = Date.now() - 5 * 60 * 1000;
      const active = [...activeRecords.values()].filter((event) =>
        Date.parse(event.startedAt) >= activeCutoffMs &&
        (!userId || event.userId === userId) && (!tool || event.tool === tool) && (!agentId || event.agentId === agentId)
      );
      return Response.json({
        hours,
        metric: metric ? { ...publicMetric(metric), p95DurationMs: percentile95(events.map((event) => Math.max(0, event.durationMs))) } : null,
        activeCalls: active.length,
        sampleSize: events.length,
        bounded: records.size >= 1000,
      });
    }

    if (url.pathname === "/activity/query" && request.method === "GET") {
      const state = url.searchParams.get("state") === "active" ? "active" : "history";
      const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 500);
      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      const activityId = url.searchParams.get("activityId");
      const fromMs = Date.parse(url.searchParams.get("from") || "");
      const toMs = Date.parse(url.searchParams.get("to") || "");
      const matches = (event: any) => {
        const when = Date.parse(event.startedAt || event.timestamp || "");
        return (!userId || event.userId === userId) &&
          (!tool || event.tool === tool) &&
          (!agentId || event.agentId === agentId) &&
          (!activityId || event.activityId === activityId) &&
          (!Number.isFinite(fromMs) || when >= fromMs) &&
          (!Number.isFinite(toMs) || when <= toMs);
      };
      if (state === "active") {
        const records = await this.ctx.storage.list<ActiveUsageEvent>({ prefix: "active:", limit: 1000 });
        const activeCutoffMs = Date.now() - 5 * 60 * 1000;
        const staleKeys: string[] = [];
        const items = [...records.entries()].filter(([key, event]) => {
          const fresh = Date.parse(event.startedAt) >= activeCutoffMs;
          if (!fresh) staleKeys.push(key);
          return fresh && matches(event);
        }).slice(0, limit).map(([, event]) => event);
        if (staleKeys.length) await this.ctx.storage.delete(staleKeys);
        return Response.json({ state, items, total: items.length });
      }
      const records = await this.ctx.storage.list<UsageEvent>({ prefix: "event:", reverse: true, limit: 1000 });
      const items = [...records.values()].filter(matches).slice(0, limit);
      return Response.json({ state, items, total: items.length });
    }

    if (url.pathname === "/errors/query" && request.method === "GET") {
      const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 500);
      const userId = url.searchParams.get("userId");
      const tool = url.searchParams.get("tool");
      const agentId = url.searchParams.get("agentId");
      const errorClass = url.searchParams.get("errorClass");
      const fromMs = Date.parse(url.searchParams.get("from") || "");
      const toMs = Date.parse(url.searchParams.get("to") || "");
      const records = await this.ctx.storage.list<UsageEvent>({ prefix: "event:", reverse: true, limit: 1000 });
      const items = [...records.values()].filter((event) => {
        const when = Date.parse(event.timestamp);
        return !event.ok && (!userId || event.userId === userId) &&
          (!tool || event.tool === tool) && (!agentId || event.agentId === agentId) &&
          (!errorClass || event.errorClass === errorClass) &&
          (!Number.isFinite(fromMs) || when >= fromMs) && (!Number.isFinite(toMs) || when <= toMs);
      }).slice(0, limit);
      return Response.json({ items, total: items.length });
    }

    if (url.pathname === "/query" && request.method === "GET") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get("from");      const to = url.searchParams.get("to");
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

      if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        const start = Date.parse(from + "T00:00:00.000Z");
        const end = Date.parse(to + "T00:00:00.000Z");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 30 * 86400000) {
          return Response.json({ error: "invalid_usage_range" }, { status: 400 });
        }
        const days = [];
        for (let ts = start; ts <= end; ts += 86400000) {
          const rangeDay = new Date(ts).toISOString().slice(0, 10);
          const rangeKey = userId
            ? "day:" + rangeDay + ":user:" + safePart(userId)
            : tool
              ? "day:" + rangeDay + ":tool:" + safePart(tool)
              : agentId
                ? "day:" + rangeDay + ":agent:" + safePart(agentId)
                : "day:" + rangeDay + ":total";
          days.push({ day: rangeDay, metric: publicMetric(await this.ctx.storage.get<Metric>(rangeKey)) });
        }
        return Response.json({ from, to, days });
      }

      const metric = await this.ctx.storage.get<Metric>(key);
      const recentLimit = Math.max(0, Math.min(1000, Number(url.searchParams.get("recentLimit")) || 0));
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
