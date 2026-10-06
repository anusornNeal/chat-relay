import { DurableObject } from "cloudflare:workers";

export type LearnScope = "global" | "project" | "agent";
export type LearnKind =
  | "preference"
  | "response_style"
  | "work_style"
  | "coding_style"
  | "problem_solving"
  | "project_context"
  | "tool_pattern"
  | "workflow"
  | "correction"
  | "agent_context";

export type LearnChangeType = "created" | "updated" | "reinforced" | "weakened" | "removed";

export type LearnRecord = {
  id: string;
  key: string;
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

export type LearnChange = {
  eventId: string;
  memoryId: string;
  type: LearnChangeType;
  key: string;
  kind: LearnKind;
  scope: LearnScope;
  scopeKey: string | null;
  summary: string;
  confidence: number | null;
  previousConfidence: number | null;
  at: string;
};

const TABLE = "learning_memory_v1";
const KIND_VALUES: LearnKind[] = [
  "preference",
  "response_style",
  "work_style",
  "coding_style",
  "problem_solving",
  "project_context",
  "tool_pattern",
  "workflow",
  "correction",
  "agent_context",
];
const KINDS = new Set<LearnKind>(KIND_VALUES);
const SCOPES = new Set<LearnScope>(["global", "project", "agent"]);
const MAX_MEMORIES = 512;

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
function legacyMemoryKey(id: string) {
  if (id.startsWith("mem_")) return "";
  const parts = id.split("|");
  if (parts.length < 4) return "";
  try { return decodeURIComponent(parts[3]); }
  catch { return parts[3]; }
}
async function recordId(kind: LearnKind, scope: LearnScope, scopeKey: string | null, key: string) {
  const canonical = JSON.stringify([kind, scope, scopeKey ?? "", key]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "mem_" + [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function rowToRecord(row: any): LearnRecord {
  const id = String(row.id);
  const key = row.memory_key == null || String(row.memory_key) === ""
    ? legacyMemoryKey(id)
    : String(row.memory_key);
  return {
    id,
    key,
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
function summarizeMemory(content: string) {
  return cleanText(content.replace(/\s+/g, " "), 320);
}

export class Learning extends DurableObject {
  private memoryCount: number | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        memory_key TEXT NOT NULL,
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

    const columns = this.ctx.storage.sql.exec<any>(`PRAGMA table_info(${TABLE})`).toArray();
    if (!columns.some((column) => String(column.name) === "memory_key")) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${TABLE} ADD COLUMN memory_key TEXT`);
      const legacyRows = this.ctx.storage.sql.exec<any>(
        `SELECT id FROM ${TABLE} WHERE memory_key IS NULL`,
      ).toArray();
      for (const row of legacyRows) {
        const id = String(row.id);
        const key = legacyMemoryKey(id);
        this.ctx.storage.sql.exec(
          `UPDATE ${TABLE} SET memory_key = ? WHERE id = ?`,
          key,
          id,
        );
      }
    }

    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_scope ON ${TABLE}(scope, scope_key, updated_at)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_kind ON ${TABLE}(kind, updated_at)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_identity ON ${TABLE}(kind, scope, scope_key, memory_key)`);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS learning_memory_v1_retrieval ON ${TABLE}(scope, scope_key, kind, confidence DESC, positive_feedback DESC, negative_feedback ASC, updated_at DESC)`);

  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/get" && request.method === "POST") return this.get(request);
    if (url.pathname === "/profile" && request.method === "POST") return this.profile(request);
    if (url.pathname === "/put" && request.method === "POST") return this.put(request);
    if (url.pathname === "/delete" && request.method === "POST") return this.delete(request);
    if (url.pathname === "/feedback" && request.method === "POST") return this.feedback(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async ensureMemoryCapacity() {
    if (this.memoryCount === null) {
      const countRow = this.ctx.storage.sql.exec<any>(`SELECT COUNT(*) AS count FROM ${TABLE}`).toArray()[0];
      this.memoryCount = Number(countRow?.count ?? 0);
    }
    return this.memoryCount < MAX_MEMORIES;
  }

  private makeChange(input: Omit<LearnChange, "eventId">): LearnChange {
    return { eventId: "lev_" + crypto.randomUUID().replaceAll("-", ""), ...input };
  }

  private async get(request: Request) {
    const body = await request.json<any>().catch(() => null);
    if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });

    const scopeSelectors: Array<{ scope: LearnScope; scopeKey: string | null }> = [];
    const scopes = Array.isArray(body.scopes) ? body.scopes.slice(0, 8) : [];
    for (const entry of scopes) {
      const scope = parseScope(entry?.scope);
      if (!scope) continue;
      if (scope === "global") {
        scopeSelectors.push({ scope, scopeKey: null });
      } else {
        const scopeKey = cleanText(entry?.scopeKey, 200);
        if (scopeKey) scopeSelectors.push({ scope, scopeKey });
      }
    }
    if (!scopeSelectors.length) return Response.json({ items: [], limit: 0 });

    const kind = body.kind == null ? null : parseKind(body.kind);
    if (body.kind != null && !kind) return Response.json({ error: "invalid_kind" }, { status: 400 });

    let kinds = kind ? [kind] : KIND_VALUES;
    if (!kind && Array.isArray(body.kinds)) {
      const parsed = body.kinds.slice(0, KIND_VALUES.length).map(parseKind).filter(Boolean) as LearnKind[];
      if (!parsed.length && body.kinds.length) return Response.json({ error: "invalid_kind" }, { status: 400 });
      if (parsed.length) kinds = [...new Set(parsed)];
    }

    const limit = boundedInt(body.limit, 50, 1, 100);
    const perKind = boundedInt(body.perKind, 0, 0, 8);
    const routingReserve = boundedInt(body.routingReserve, 0, 0, 32);

    if (perKind > 0) {
      const selected = new Map<string, LearnRecord>();
      for (const selector of scopeSelectors) {
        for (const selectedKind of kinds) {
          const selectedLimit = routingReserve > 0 && selector.scope === "global" && selectedKind === "project_context"
            ? Math.max(perKind, routingReserve)
            : perKind;
          const rows = selector.scopeKey === null
            ? this.ctx.storage.sql.exec<any>(
                `SELECT * FROM ${TABLE}
                 WHERE scope = ? AND scope_key IS NULL AND kind = ?
                 ORDER BY confidence DESC, positive_feedback DESC, negative_feedback ASC, updated_at DESC, id ASC
                 LIMIT ?`,
                selector.scope,
                selectedKind,
                selectedLimit,
              ).toArray()
            : this.ctx.storage.sql.exec<any>(
                `SELECT * FROM ${TABLE}
                 WHERE scope = ? AND scope_key = ? AND kind = ?
                 ORDER BY confidence DESC, positive_feedback DESC, negative_feedback ASC, updated_at DESC, id ASC
                 LIMIT ?`,
                selector.scope,
                selector.scopeKey,
                selectedKind,
                selectedLimit,
              ).toArray();
          for (const row of rows) {
            const record = rowToRecord(row);
            selected.set(record.id, record);
          }
        }
      }

      const items = [...selected.values()]
        .sort((a, b) =>
          b.confidence - a.confidence ||
          b.positiveFeedback - a.positiveFeedback ||
          a.negativeFeedback - b.negativeFeedback ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id)
        )
        .slice(0, limit);
      return Response.json({ items, limit, strategy: "balanced-kind", perKind, routingReserve });
    }

    const clauses: string[] = [];
    const args: (string | number)[] = [];
    for (const selector of scopeSelectors) {
      if (selector.scopeKey === null) {
        clauses.push("(scope = ? AND scope_key IS NULL)");
        args.push(selector.scope);
      } else {
        clauses.push("(scope = ? AND scope_key = ?)");
        args.push(selector.scope, selector.scopeKey);
      }
    }

    const sql = `SELECT * FROM ${TABLE} WHERE (${clauses.join(" OR ")})${kind ? " AND kind = ?" : ""} ORDER BY updated_at DESC, id ASC LIMIT ?`;
    if (kind) args.push(kind);
    args.push(limit);
    const items = this.ctx.storage.sql.exec<any>(sql, ...args).toArray().map(rowToRecord);
    return Response.json({ items, limit, strategy: "recent" });
  }

  private async profile(request: Request) {
    const body = await request.json<any>().catch(() => ({}));
    const limit = boundedInt(body?.limit, 100, 1, 100);
    const items = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE} ORDER BY updated_at DESC, id ASC LIMIT ?`,
      limit,
    ).toArray().map(rowToRecord);

    const byScope = { global: 0, project: 0, agent: 0 };
    const byKind: Record<string, number> = {};
    for (const item of items) {
      byScope[item.scope] += 1;
      byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    }
    return Response.json({
      items,
      summary: { total: items.length, byScope, byKind },
      limits: { memories: MAX_MEMORIES, returned: limit },
    });
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

    const existingRow = scopeKey === null
      ? this.ctx.storage.sql.exec<any>(
          `SELECT * FROM ${TABLE} WHERE kind = ? AND scope = ? AND scope_key IS NULL AND memory_key = ? LIMIT 1`,
          kind,
          scope,
          key,
        ).toArray()[0]
      : this.ctx.storage.sql.exec<any>(
          `SELECT * FROM ${TABLE} WHERE kind = ? AND scope = ? AND scope_key = ? AND memory_key = ? LIMIT 1`,
          kind,
          scope,
          scopeKey,
          key,
        ).toArray()[0];
    const existing = existingRow ? rowToRecord(existingRow) : null;

    if (!existing && !(await this.ensureMemoryCapacity())) {
      return Response.json({ error: "memory_limit", limit: MAX_MEMORIES }, { status: 409 });
    }

    const confidence = boundedInt(body?.confidence, 100, 0, 100);
    if (existing && existing.content === content && existing.confidence === confidence) {
      return Response.json({ ok: true, changed: false, item: existing, change: null });
    }

    const id = existing?.id ?? await recordId(kind, scope, scopeKey, key);
    const now = new Date().toISOString();
    const item: LearnRecord = {
      id,
      key,
      kind,
      scope,
      scopeKey,
      content,
      confidence,
      positiveFeedback: existing?.positiveFeedback ?? 0,
      negativeFeedback: existing?.negativeFeedback ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.ctx.storage.sql.exec(
      `INSERT INTO ${TABLE} (id, memory_key, kind, scope, scope_key, content, confidence, positive_feedback, negative_feedback, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET memory_key=excluded.memory_key, content=excluded.content, confidence=excluded.confidence, updated_at=excluded.updated_at`,
      id,
      key,
      kind,
      scope,
      scopeKey,
      content,
      confidence,
      item.positiveFeedback,
      item.negativeFeedback,
      item.createdAt,
      now,
    );
    if (!existing && this.memoryCount !== null) this.memoryCount += 1;

    let type: LearnChangeType = "created";
    if (existing) {
      if (existing.content !== content) type = "updated";
      else if (confidence > existing.confidence) type = "reinforced";
      else type = "weakened";
    }
    const change = this.makeChange({
      memoryId: id,
      type,
      key,
      kind,
      scope,
      scopeKey,
      summary: summarizeMemory(content),
      confidence,
      previousConfidence: existing?.confidence ?? null,
      at: now,
    });
    return Response.json({ ok: true, changed: true, item, change });
  }

  private async delete(request: Request) {
    const body = await request.json<any>().catch(() => null);
    const id = cleanText(body?.id, 400);
    if (!id) return Response.json({ error: "id_required" }, { status: 400 });
    const existingRow = this.ctx.storage.sql.exec<any>(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, id).toArray()[0];
    if (!existingRow) return Response.json({ ok: true, changed: false, deleted: false, change: null });
    const existing = rowToRecord(existingRow);
    this.ctx.storage.sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, id);
    if (this.memoryCount !== null) this.memoryCount = Math.max(0, this.memoryCount - 1);
    const now = new Date().toISOString();
    const change = this.makeChange({
      memoryId: existing.id,
      type: "removed",
      key: existing.key,
      kind: existing.kind,
      scope: existing.scope,
      scopeKey: existing.scopeKey,
      summary: summarizeMemory(existing.content),
      confidence: null,
      previousConfidence: existing.confidence,
      at: now,
    });
    return Response.json({ ok: true, changed: true, deleted: true, change });
  }

  private async feedback(request: Request) {
    const body = await request.json<any>().catch(() => null);
    const id = cleanText(body?.id, 400);
    const value = cleanText(body?.value, 16);
    if (!id || !["positive", "negative"].includes(value)) {
      return Response.json({ error: "invalid_feedback" }, { status: 400 });
    }

    const existingRow = this.ctx.storage.sql.exec<any>(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, id).toArray()[0];
    if (!existingRow) return Response.json({ error: "not_found" }, { status: 404 });
    const existing = rowToRecord(existingRow);
    const positiveFeedback = value === "positive" ? 1 : 0;
    const negativeFeedback = value === "negative" ? 1 : 0;
    if (existing.positiveFeedback === positiveFeedback && existing.negativeFeedback === negativeFeedback) {
      return Response.json({ ok: true, changed: false, item: existing });
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE ${TABLE} SET positive_feedback = ?, negative_feedback = ?, updated_at = ? WHERE id = ?`,
      positiveFeedback,
      negativeFeedback,
      now,
      id,
    );
    const item: LearnRecord = {
      ...existing,
      positiveFeedback,
      negativeFeedback,
      updatedAt: now,
    };
    const change = this.makeChange({
      memoryId: item.id,
      type: value === "positive" ? "reinforced" : "weakened",
      key: item.key,
      kind: item.kind,
      scope: item.scope,
      scopeKey: item.scopeKey,
      summary: summarizeMemory(item.content),
      confidence: item.confidence,
      previousConfidence: item.confidence,
      at: now,
    });
    return Response.json({ ok: true, changed: true, item, change });
  }
}
