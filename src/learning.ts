import { DurableObject } from "cloudflare:workers";

export type LearnScope = "global" | "project" | "agent";
export type LearnKind = "preference" | "project_context" | "tool_pattern" | "workflow" | "correction" | "agent_context";

export type LearnRecord = {
  id: string;
  kind: LearnKind;
  scope: LearnScope;
  scopeKey: string | null;
  content: string;
  confidence: number;
  positiveFeedback: number;
  negativeFeedback: number;
  createdAt: string;
  updatedAt: string;
};

const TABLE = "learning_memory_v1";
const KINDS = new Set<LearnKind>(["preference","project_context","tool_pattern","workflow","correction","agent_context"]);
const SCOPES = new Set<LearnScope>(["global","project","agent"]);

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}
function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}
function parseScope(value: unknown): LearnScope | null {
  const v = cleanText(value, 16) as LearnScope;
  return SCOPES.has(v) ? v : null;
}
function parseKind(value: unknown): LearnKind | null {
  const v = cleanText(value, 32) as LearnKind;
  return KINDS.has(v) ? v : null;
}
function recordId(kind: LearnKind, scope: LearnScope, scopeKey: string | null, key: string) {
  return [kind, scope, scopeKey ?? "", key].map(encodeURIComponent).join("|").slice(0, 400);
}
function rowToRecord(row: any): LearnRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as LearnKind,
    scope: String(row.scope) as LearnScope,
    scopeKey: row.scope_key == null ? null : String(row.scope_key),
    content: String(row.content),
    confidence: Number(row.confidence),
    positiveFeedback: Number(row.positive_feedback),
    negativeFeedback: Number(row.negative_feedback),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class Learning extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT,
        content TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 100,
        positive_feedback INTEGER NOT NULL DEFAULT 0,
        negative_feedback INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_scope ON ${TABLE}(scope, scope_key, updated_at)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_kind ON ${TABLE}(kind, updated_at)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/get" && request.method === "POST") return this.get(request);
    if (url.pathname === "/put" && request.method === "POST") return this.put(request);
    if (url.pathname === "/delete" && request.method === "POST") return this.delete(request);
    if (url.pathname === "/feedback" && request.method === "POST") return this.feedback(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async get(request: Request) {
    const body = await request.json<any>().catch(() => null);
    if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });
    const scopes = Array.isArray(body.scopes) ? body.scopes.slice(0, 8) : [];
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    for (const entry of scopes) {
      const scope = parseScope(entry?.scope);
      if (!scope) continue;
      if (scope === "global") {
        clauses.push("(scope = ? AND scope_key IS NULL)");
        args.push(scope);
      } else {
        const scopeKey = cleanText(entry?.scopeKey, 200);
        if (!scopeKey) continue;
        clauses.push("(scope = ? AND scope_key = ?)");
        args.push(scope, scopeKey);
      }
    }
    if (!clauses.length) return Response.json({ items: [], limit: 0 });
    const kind = body.kind == null ? null : parseKind(body.kind);
    if (body.kind != null && !kind) return Response.json({ error: "invalid_kind" }, { status: 400 });
    const limit = boundedInt(body.limit, 50, 1, 100);
    const sql = `SELECT * FROM ${TABLE} WHERE (${clauses.join(" OR ")})${kind ? " AND kind = ?" : ""} ORDER BY updated_at DESC, id ASC LIMIT ?`;
    if (kind) args.push(kind);
    args.push(limit);
    const items = this.ctx.storage.sql.exec<any>(sql, ...args).toArray().map(rowToRecord);
    return Response.json({ items, limit });
  }

  private async put(request: Request) {
    const body = await request.json<any>().catch(() => null);
    const kind = parseKind(body?.kind);
    const scope = parseScope(body?.scope);
    const rawKey = String(body?.key ?? "").trim();
    const rawContent = String(body?.content ?? "").trim();
    const rawScopeKey = String(body?.scopeKey ?? "").trim();
    if (rawKey.length > 160 || rawContent.length > 4000 || rawScopeKey.length > 200) {
      return Response.json({ error: "memory_too_large" }, { status: 400 });
    }
    const key = cleanText(rawKey, 160);
    const content = cleanText(rawContent, 4000);
    const scopeKey = scope === "global" ? null : cleanText(rawScopeKey, 200);
    if (!kind || !scope || !key || !content || (scope !== "global" && !scopeKey)) {
      return Response.json({ error: "invalid_memory" }, { status: 400 });
    }
    const confidence = boundedInt(body?.confidence, 100, 0, 100);
    const id = recordId(kind, scope, scopeKey, key);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO ${TABLE} (id, kind, scope, scope_key, content, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, confidence=excluded.confidence, updated_at=excluded.updated_at`,
      id, kind, scope, scopeKey, content, confidence, now, now,
    );
    const row = this.ctx.storage.sql.exec<any>(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, id).toArray()[0];
    return Response.json({ ok: true, item: rowToRecord(row) });
  }

  private async delete(request: Request) {
    const body = await request.json<any>().catch(() => null);
    const id = cleanText(body?.id, 400);
    if (!id) return Response.json({ error: "id_required" }, { status: 400 });
    const existing = this.ctx.storage.sql.exec<any>(`SELECT id FROM ${TABLE} WHERE id = ? LIMIT 1`, id).toArray();
    if (!existing.length) return Response.json({ ok: true, deleted: false });
    this.ctx.storage.sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, id);
    return Response.json({ ok: true, deleted: true });
  }

  private async feedback(request: Request) {
    const body = await request.json<any>().catch(() => null);
    const id = cleanText(body?.id, 400);
    const value = cleanText(body?.value, 16);
    if (!id || !["positive","negative"].includes(value)) return Response.json({ error: "invalid_feedback" }, { status: 400 });
    const column = value === "positive" ? "positive_feedback" : "negative_feedback";
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(`UPDATE ${TABLE} SET ${column} = ${column} + 1, updated_at = ? WHERE id = ?`, now, id);
    const row = this.ctx.storage.sql.exec<any>(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, id).toArray()[0];
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ ok: true, item: rowToRecord(row) });
  }
}
