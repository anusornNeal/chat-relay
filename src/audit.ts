import { DurableObject } from "cloudflare:workers";

export type AuditActor = {
  kind: "operator" | "admin-user" | "anonymous" | "system";
  userId?: string;
};

export type AuditTarget = {
  type: string;
  id?: string;
};

export type AuditEventInput = {
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: "success" | "failure";
  metadata?: Record<string, unknown>;
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  result: "success" | "failure";
  metadata: Record<string, string | number | boolean | null>;
};

const SENSITIVE_KEY = /(password|token|secret|command|content|payload|input|authorization|cookie|csrf)/i;
const STATUS_KEY = "ops:cleanup:last";

function cleanText(value: unknown, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

function safeMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    if (!key || SENSITIVE_KEY.test(key)) continue;
    const safeKey = cleanText(key, 64);
    if (!safeKey) continue;
    if (raw === null || typeof raw === "boolean") output[safeKey] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) output[safeKey] = raw;
    else if (typeof raw === "string") output[safeKey] = raw.slice(0, 240);
  }
  return output;
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

export class Audit extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/record" && request.method === "POST") {
      const body = await request.json<AuditEventInput>().catch(() => null);
      if (!body || !body.actor || !body.action || !body.target || !body.result) {
        return Response.json({ error: "invalid_audit_event" }, { status: 400 });
      }
      const action = cleanText(body.action, 120);
      const targetType = cleanText(body.target.type, 80);
      if (!action || !targetType || !["success", "failure"].includes(body.result)) {
        return Response.json({ error: "invalid_audit_event" }, { status: 400 });
      }
      const timestamp = new Date().toISOString();
      const id = crypto.randomUUID();
      const event: AuditEvent = {
        id,
        timestamp,
        actor: {
          kind: ["operator", "admin-user", "anonymous", "system"].includes(body.actor.kind)
            ? body.actor.kind
            : "system",
          ...(body.actor.userId ? { userId: cleanText(body.actor.userId, 128) } : {}),
        },
        action,
        target: {
          type: targetType,
          ...(body.target.id ? { id: cleanText(body.target.id, 160) } : {}),
        },
        result: body.result,
        metadata: safeMetadata(body.metadata),
      };
      await this.ctx.storage.put(`audit:${timestamp}:${id}`, event);
      return Response.json({ ok: true, id, timestamp });
    }

    if (url.pathname === "/query" && request.method === "GET") {
      const limit = bounded(url.searchParams.get("limit"), 50, 1, 100);
      const action = url.searchParams.get("action");
      const actorUserId = url.searchParams.get("actorUserId");
      const targetId = url.searchParams.get("targetId");
      const scanLimit = Math.min(1000, Math.max(limit, limit * 10));
      const records = await this.ctx.storage.list<AuditEvent>({
        prefix: "audit:",
        reverse: true,
        limit: scanLimit,
      });
      const items = [...records.values()].filter((event) =>
        (!action || event.action === action) &&
        (!actorUserId || event.actor.userId === actorUserId) &&
        (!targetId || event.target.id === targetId)
      ).slice(0, limit);
      return Response.json({ items, limit, scanned: records.size });
    }

    if (url.pathname === "/cleanup" && request.method === "POST") {
      const body = await request.json<any>().catch(() => ({}));
      const retentionDays = bounded(body?.retentionDays, 180, 0, 3650);
      const limit = bounded(body?.limit, 250, 1, 1000);
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const records = await this.ctx.storage.list<AuditEvent>({ prefix: "audit:", limit: Math.min(1000, limit * 4) });
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
        bounded: true,
      };
      await this.ctx.storage.put(STATUS_KEY, status);
      return Response.json({ ok: true, ...status });
    }

    if (url.pathname === "/ops/status" && request.method === "GET") {
      const lastCleanup = await this.ctx.storage.get(STATUS_KEY);
      return Response.json({ ok: true, lastCleanup: lastCleanup ?? null });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
