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

function fallbackActivityId(toolCallId: string) {
  const clean = toolCallId.replace(/^tc_/, "").replace(/[^a-zA-Z0-9]/g, "");
  return "call_" + (clean.slice(0, 12) || "unknown");
}

function normalizeFailureDiagnostics(event: UsageEvent): Pick<UsageEvent, "errorCode" | "failureStage" | "retryable"> {
  if (event.ok) return {};
  let errorCode = String(event.errorCode || event.errorClass || "tool_error").toLowerCase().slice(0, 80);
  let failureStage = "tool";

  if (errorCode === "path_not_allowed" || errorCode === "permission_denied" || errorCode.startsWith("invalid_")) {
    failureStage = "validation";
  } else if (errorCode === "rate_limited" || errorCode === "quota_exceeded" || event.statusCode === 429) {
    failureStage = "policy";
  } else if (event.exitCode !== null && event.exitCode !== undefined && Number(event.exitCode) !== 0) {
    failureStage = "process";
    if (!errorCode || errorCode === "tool_error") errorCode = "process_exit_nonzero";
  } else if (String(event.errorSource || "").toLowerCase() === "worker") {
    failureStage = "worker";
  } else if (String(event.errorSource || "").toLowerCase() === "relay") {
    failureStage = "relay";
  } else if (String(event.errorSource || "").toLowerCase() === "agent") {
    failureStage = "agent";
  }

  if (/timeout|timed_out/.test(errorCode)) failureStage = "timeout";
  if (/agent_(offline|stale|unavailable)|http_5\d\d/.test(errorCode)) failureStage = "relay";

  const retryable =
    event.statusCode === 429 ||
    Number(event.statusCode || 0) >= 500 ||
    failureStage === "timeout" ||
    failureStage === "relay" ||
    /temporar|busy|rate_limited/.test(errorCode);

  return { errorCode, failureStage, retryable };
}

function humanizeErrorCode(value: string) {
  return value
    .replace(/:.*/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function classifyFailure(event: UsageEvent) {
  const normalized = normalizeFailureDiagnostics(event);
  const errorCode = String(normalized.errorCode || event.errorCode || event.errorClass || "tool_error").toLowerCase();
  const failureStage = String(normalized.failureStage || "tool");

  if (errorCode === "command_blocked") {
    return { ...normalized, failureCategory: "handled", severity: "info", operational: false, diagnosticLabel: "Blocked by policy" };
  }
  if (errorCode.startsWith("replacement_count_mismatch")) {
    return { ...normalized, failureCategory: "handled", severity: "info", operational: false, diagnosticLabel: "Edit target changed" };
  }
  if (failureStage === "validation" || failureStage === "policy") {
    return { ...normalized, failureCategory: "handled", severity: "info", operational: false, diagnosticLabel: humanizeErrorCode(errorCode) };
  }
  if (failureStage === "process" || errorCode === "process_exit_nonzero") {
    return { ...normalized, failureCategory: "tool", severity: "warning", operational: false, diagnosticLabel: "Command failed" };
  }
  if (failureStage === "timeout" || failureStage === "relay" || failureStage === "worker") {
    const diagnosticLabel =
      /agent_.*timeout|agent_timeout/.test(errorCode) ? "Agent timed out" :
      /agent_(offline|stale|unavailable)/.test(errorCode) ? "Agent offline" :
      humanizeErrorCode(errorCode);
    return { ...normalized, failureCategory: "infrastructure", severity: "error", operational: true, diagnosticLabel };
  }
  return { ...normalized, failureCategory: "tool", severity: "warning", operational: false, diagnosticLabel: humanizeErrorCode(errorCode) };
}

type ActivityCursor = { timestamp: string; id: string };
type ScanCursor = { v: 2; before: string; legacy?: ActivityCursor };
const RAW_QUERY_SCAN_LIMIT = 500;

function encodeScanCursor(cursor: ScanCursor) {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeScanCursor(value: string | null): ScanCursor | ActivityCursor | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
    if (parsed.v !== undefined) {
      if (parsed.v !== 2 || typeof parsed.before !== "string" || parsed.before.length > 1024 ||
          !/^event:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:/.test(parsed.before)) return null;
      const timestamp = parsed.before.slice(6,30);
      if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp ||
          !/^[A-Za-z0-9%_.:~-]+$/.test(parsed.before.slice(31))) return null;
      if (parsed.legacy && (typeof parsed.legacy.timestamp !== "string" || !Number.isFinite(Date.parse(parsed.legacy.timestamp)) ||
          typeof parsed.legacy.id !== "string" || parsed.legacy.id.length > 200)) return null;
      return { v: 2, before: parsed.before, ...(parsed.legacy ? { legacy: parsed.legacy } : {}) };
    }
    return decodeActivityCursor(value);
  } catch { return null; }
}

function activityTimestamp(event: any) {
  return String(event.timestamp || event.startedAt || "");
}

function activityStableId(event: any) {
  return String(event.toolCallId || event.activityId || [event.userId, event.tool, event.agentId || "", activityTimestamp(event)].join(":"));
}

function decodeActivityCursor(value: string | null): ActivityCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(padded));
    if (typeof parsed?.timestamp !== "string" || typeof parsed?.id !== "string" || !Number.isFinite(Date.parse(parsed.timestamp))) return null;
    return { timestamp: parsed.timestamp, id: parsed.id.slice(0, 200) };
  } catch {
    return null;
  }
}

function olderThanCursor(event: any, cursor: ActivityCursor) {
  const eventTime = Date.parse(activityTimestamp(event));
  const cursorTime = Date.parse(cursor.timestamp);
  if (eventTime !== cursorTime) return eventTime < cursorTime;
  return activityStableId(event).localeCompare(cursor.id) < 0;
}

function nextUtcDay(nowMs: number) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export class Usage extends DurableObject {
  private readonly usageEnv: UsageEnv;
  private readonly aggregates: UsageAggregates;
  private activeHydration?: Promise<Map<string, ActiveUsageEvent>>;
  private async activeEvents() {
    const result = await (this.activeHydration ||= (async () => {
      const result = new Map<string, ActiveUsageEvent>();
      let startAfter: string | undefined;
      for (;;) {
        const page = await this.ctx.storage.list<ActiveUsageEvent>({ prefix: "active:", limit: 1000, ...(startAfter ? { startAfter } : {}) });
        for (const [key, event] of page) result.set(key,event);
        if (page.size < 1000) break;
        startAfter = [...page.keys()].at(-1)!;
      }
      return result;
    })().catch(error => { this.activeHydration = undefined; throw error; }));
    const cutoff = Date.now()-3600000;
    const stale = [...result].filter(([,event]) => Date.parse(event.startedAt) < cutoff);
    if (stale.length) {
      const removed = await this.ctx.storage.transaction(async txn => {
        const keys: string[] = [];
        for (const [key,event] of stale) {
          const current = await txn.get<ActiveUsageEvent>(key);
          if (current?.startedAt === event.startedAt) keys.push(key);
        }
        for (let offset = 0; offset < keys.length; offset += 128) await txn.delete(keys.slice(offset,offset+128));
        return keys;
      });
      for (const key of removed) {
        if (Date.parse(result.get(key)?.startedAt || "") < cutoff) result.delete(key);
      }
    }
    return result;
  }

  constructor(ctx: DurableObjectState, env: UsageEnv) {
    super(ctx, env);
    this.usageEnv = env;
    this.aggregates = new UsageAggregates(ctx.storage, event => !event.ok && classifyFailure(event).operational);
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
        activityId: body?.activityId ? String(body.activityId).slice(0, 96) : fallbackActivityId(toolCallId),
      };
      const active = await this.activeEvents();
      await this.ctx.storage.put("active:" + safePart(toolCallId), event);
      active.set("active:" + safePart(toolCallId), event);
      await publishDashboard(this.usageEnv, [], event.userId, {
        type: "tool_started",
        userId: event.userId,
        tool: event.tool,
        toolCallId: event.toolCallId,
        activityId: event.activityId,
        agentId: event.agentId,
        startedAt: event.startedAt,
      });
      return Response.json({ ok: true });
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
      if (!event.ok) Object.assign(event, normalizeFailureDiagnostics(event));
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
      const active = event.toolCallId ? await this.activeEvents() : undefined;
      await this.ctx.storage.transaction(async txn => {
        // Bootstrap from retained raw before adding the new event, then commit all representations atomically.
        await this.aggregates.record(txn, event);
        const writes: Record<string, Metric> = {};
        for (const key of metricKeys) writes[key] = addMetric(await txn.get<Metric>(key), event);
        if (event.toolCallId) await txn.delete("active:" + safePart(event.toolCallId));
        await txn.put({ ...writes, [`event:${event.timestamp}:${crypto.randomUUID()}`]: event });
      });
      if (event.toolCallId) active!.delete("active:" + safePart(event.toolCallId));
      this.aggregates.invalidate(event);
      await publishDashboard(
        this.usageEnv,
        event.ok ? ["overview"] : ["overview", "errors"],
        event.userId,
        {
          type: "tool_finished",
          userId: event.userId,
          tool: event.tool,
          toolCallId: event.toolCallId,
          activityId: event.activityId,
          agentId: event.agentId,
          startedAt: event.startedAt || event.timestamp,
          timestamp: event.timestamp,
          durationMs: event.durationMs,
          ok: event.ok,
          errorClass: event.errorClass,
          errorSource: event.errorSource,
          errorCode: event.errorCode,
          failureStage: event.failureStage,
          retryable: event.retryable,
          statusCode: event.statusCode,
          exitCode: event.exitCode,
          workerOverheadMs: event.workerOverheadMs,
          relayRoundTripMs: event.relayRoundTripMs,
          transportMs: event.transportMs,
          agentQueueWaitMs: event.agentQueueWaitMs,
          agentHandlerMs: event.agentHandlerMs,
        },
      );
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
      const active = [...(await this.activeEvents()).values()].filter(event => Date.parse(event.startedAt) >= now-300000 &&
        (!userId || event.userId === userId) && (!tool || event.tool === tool) && (!agentId || event.agentId === agentId));
      return Response.json({ hours, metric: summary.metric, activeCalls: active.length, sampleSize: summary.sampleSize,
        bounded: summary.bounded, coverage: summary.coverage, p95Approximate: true });
    }

    if ((url.pathname === "/activity/query" || url.pathname === "/errors/query") && request.method === "GET") {
      const errors = url.pathname === "/errors/query";
      const requestedState = url.searchParams.get("state");
      const state = errors || requestedState === "history" ? "history" : requestedState === "active" ? "active" : "all";
      const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 100);
      const cursorValue = url.searchParams.get("cursor");
      const cursor = decodeScanCursor(cursorValue);
      if (cursorValue && !cursor) return Response.json({ error: "invalid_cursor" }, { status: 400 });
      const scan = cursor && "v" in cursor ? cursor : null;
      const legacy = scan?.legacy || (cursor && !("v" in cursor) ? cursor : null);
      const fromMs = Date.parse(url.searchParams.get("from") || "");
      const toMs = Date.parse(url.searchParams.get("to") || "");
      const matches = (event: any) => {
        const when = Date.parse(errors ? event.timestamp : event.startedAt || event.timestamp);
        return (!errors || event.ok === false) && ["userId", "tool", "agentId", ...(errors ? ["errorClass"] : ["activityId", "status"])].every(key =>
          !url.searchParams.get(key) || event[key] === url.searchParams.get(key)) &&
          (!errors || (url.searchParams.get("operational") === null || String(event.operational) === url.searchParams.get("operational"))) &&
          (!Number.isFinite(fromMs) || when >= fromMs) && (!Number.isFinite(toMs) || when <= toMs) &&
          (!legacy || olderThanCursor(event, legacy));
      };
      // Storage order is the completion timestamp plus the unique storage key. Activity
      // date filters still use startedAt, so they must not narrow completion key bounds.
      const toEnd = errors && Number.isFinite(toMs) ? "event:" + new Date(toMs).toISOString() + ":\uffff" : undefined;
      const end = scan?.before && toEnd ? (scan.before < toEnd ? scan.before : toEnd) : scan?.before || toEnd;
      const start = errors && Number.isFinite(fromMs) ? "event:" + new Date(fromMs).toISOString() : undefined;
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs) return Response.json({ error: "invalid_usage_window" }, { status: 400 });
      const records = state === "active" || (start && end && end <= start) ? new Map<string, UsageEvent>() : await this.ctx.storage.list<UsageEvent>({
        prefix: "event:", reverse: true, limit: RAW_QUERY_SCAN_LIMIT,
        ...(end ? { end } : {}),
        ...(start ? { start } : {}),
      });
      const history = [...records].map(([key, event]) => ({ key, event: errors ? { ...event, ...classifyFailure(event) } : {
        ...event, activityId: event.activityId || (event.toolCallId ? fallbackActivityId(event.toolCallId) : undefined),
        status: event.ok ? "success" : "error",
      } }));
      const frontier = [...records.keys()].at(-1);
      const storageHasMore = records.size === RAW_QUERY_SCAN_LIMIT;
      const active = state === "history" ? [] : [...(await this.activeEvents()).values()]
        .filter(event => Date.parse(event.startedAt) >= Date.now() - 3600000)
        .map(event => ({ key: "event:" + new Date(event.startedAt).toISOString() + ":~active:" + encodeURIComponent(event.toolCallId)
          .replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase()), event: {
          ...event, activityId: event.activityId || fallbackActivityId(event.toolCallId), timestamp: event.startedAt, status: "running",
        } }))
        .filter(row => (!scan || row.key < scan.before) && (!storageHasMore || !frontier || row.key >= frontier));
      const matched = [...history, ...active].filter(row => matches(row.event))
        .sort((a,b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
      const page = matched.slice(0, limit);
      const hasMore = matched.length > limit || storageHasMore;
      const before = matched.length > limit ? page.at(-1)!.key : frontier;
      const nextCursor = hasMore && before ? encodeScanCursor({ v: 2, before, ...(legacy ? { legacy } : {}) }) : null;
      return Response.json({ ...(errors ? {} : { state }), items: page.map(row => row.event), pageSize: page.length,
        matchedTotal: matched.length, matchedTotalLowerBound: hasMore, hasMore: Boolean(nextCursor), nextCursor,
        bounded: storageHasMore, scanned: records.size, scanLimit: RAW_QUERY_SCAN_LIMIT });
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
