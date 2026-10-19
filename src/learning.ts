import { DurableObject } from "cloudflare:workers";
import { canonicalLearnProjectKey } from "./project-identity";

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
const PROJECT_ALIAS_TABLE = "learning_project_alias_v1";
const MAX_PROJECT_ALIASES = 64;
const MAX_PROJECT_MERGE_ROWS = 64; // Bound synchronous SQL writes on Cloudflare Free.
const MERGE_PREVIEW_TTL_MS = 10 * 60 * 1000;
// Small deterministic revision for detecting changes between explicit preview and commit.
// Uses metadata: every normal Learn mutation changes updated_at.
function projectMergeRevision(from: string, to: string, source: any[], destination: any[]) {
  const snapshot = JSON.stringify([from, to, ...[source, destination].map((rows) =>
    rows.map((row) => [
      row.id, row.memory_key, row.kind, row.updated_at, row.content?.length,
      row.confidence, row.positive_feedback, row.negative_feedback,
    ])
  )]);
  let h1 = 2166136261;
  let h2 = 2246822519;
  for (let i = 0; i < snapshot.length; i++) {
    h1 = Math.imul(h1 ^ snapshot.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ snapshot.charCodeAt(i), 1597334677);
  }
  return (h1 >>> 0).toString(16) + ":" + (h2 >>> 0).toString(16);
}

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

type ProjectContextBucket = "architecture" | "product" | "ux" | "operations" | "development";

export type LearnCompactionGroup = {
  bucket: ProjectContextBucket;
  canonicalKey: string;
  mergedSourceKeys: string[];
  removedIds: string[];
  item: LearnRecord;
  changed: boolean;
};

export type LearnCompactionResult = {
  applied: boolean;
  scopeKey: string;
  groups: LearnCompactionGroup[];
  removedIds: string[];
  items: LearnRecord[];
  truncated: boolean;
};

const PROJECT_CONTEXT_PREFIX = "project-context:";
const PROJECT_CONTEXT_SCAN_LIMIT = 32;
const PROJECT_CONTEXT_COMPACT_TRIGGER = 6;
const PROJECT_CONTEXT_MAX_FACTS = 12;
const PROJECT_CONTEXT_MAX_CONTENT_CHARS = 3600;
const PROJECT_CONTEXT_MAX_FACT_CHARS = 560;

const PROJECT_CONTEXT_KEYWORDS: Record<ProjectContextBucket, string[]> = {
  ux: [
    "ux", "ui", "dashboard", "tui", "screen", "layout", "visual", "display",
    "presentation", "map-local", "maplocal", "favorite-domain", "favourite-domain",
  ],
  operations: [
    "durable", "request", "row-read", "row-write", "cost", "performance", "usage",
    "cache", "poll", "deploy", "ci", "reconnect", "reliability", "quota", "limit",
    "optimize", "optimization", "latency", "throughput",
  ],
  development: [
    "devflow", "branch", "worktree", "commit", "review", "test", "coding",
    "development", "convention", "release", "merge", "workflow",
  ],
  architecture: [
    "architecture", "core", "generic", "security", "auth", "permission", "routing",
    "parallel", "concurrency", "protocol", "agent", "memory", "bootstrap",
  ],
  product: [],
};

function projectContextCanonicalKey(bucket: ProjectContextBucket) {
  return PROJECT_CONTEXT_PREFIX + bucket;
}

function canonicalProjectContextBucket(key: string): ProjectContextBucket | null {
  if (!key.startsWith(PROJECT_CONTEXT_PREFIX)) return null;
  const value = key.slice(PROJECT_CONTEXT_PREFIX.length) as ProjectContextBucket;
  return ["architecture", "product", "ux", "operations", "development"].includes(value) ? value : null;
}

function projectContextBucket(key: string, content: string): ProjectContextBucket {
  const canonical = canonicalProjectContextBucket(key);
  if (canonical) return canonical;
  const haystack = (key + " " + content).toLowerCase().replace(/[_\s]+/g, "-");
  const tokens = new Set(haystack.split(/[^a-z0-9\u0E00-\u0E7F]+/).filter(Boolean));
  const matches = (keyword: string) => {
    if (keyword.includes("-")) return haystack.includes(keyword);
    if (keyword.length <= 3) return tokens.has(keyword);
    return haystack.includes(keyword);
  };
  for (const bucket of ["ux", "operations", "development", "architecture"] as ProjectContextBucket[]) {
    if (PROJECT_CONTEXT_KEYWORDS[bucket].some(matches)) return bucket;
  }
  return "product";
}

type ProjectContextFact = {
  sourceKey: string;
  text: string;
  score: number;
  updatedAt: string;
};

function compactFactText(value: string) {
  return cleanText(value.replace(/\s+/g, " "), PROJECT_CONTEXT_MAX_FACT_CHARS);
}

function projectContextFacts(record: LearnRecord): ProjectContextFact[] {
  const canonical = canonicalProjectContextBucket(record.key);
  if (canonical) {
    const parsed: ProjectContextFact[] = [];
    for (const line of String(record.content || "").split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+\[([^\]]{1,160})\]\s+(.+)$/);
      if (!match) continue;
      const text = compactFactText(match[2]);
      if (!text) continue;
      parsed.push({
        sourceKey: cleanText(match[1], 160),
        text,
        score: record.confidence + record.positiveFeedback * 5 - record.negativeFeedback * 7,
        updatedAt: record.updatedAt,
      });
    }
    if (parsed.length) return parsed;
  }
  const text = compactFactText(record.content);
  return text ? [{
    sourceKey: record.key,
    text,
    score: record.confidence + record.positiveFeedback * 5 - record.negativeFeedback * 7,
    updatedAt: record.updatedAt,
  }] : [];
}

function mergeProjectContextContent(
  records: LearnRecord[],
  incoming?: { key: string; content: string; confidence: number; updatedAt: string },
) {
  const bySource = new Map<string, ProjectContextFact>();
  for (const record of records) {
    for (const fact of projectContextFacts(record)) {
      const current = bySource.get(fact.sourceKey);
      if (!current || fact.updatedAt >= current.updatedAt) bySource.set(fact.sourceKey, fact);
    }
  }

  if (incoming) {
    const incomingRecord: LearnRecord = {
      id: "incoming",
      key: incoming.key,
      kind: "project_context",
      scope: "project",
      scopeKey: null,
      content: incoming.content,
      confidence: incoming.confidence,
      positiveFeedback: 0,
      negativeFeedback: 0,
      createdAt: incoming.updatedAt,
      updatedAt: incoming.updatedAt,
    };
    for (const fact of projectContextFacts(incomingRecord)) {
      bySource.set(fact.sourceKey, {
        ...fact,
        score: 10_000 + incoming.confidence,
        updatedAt: incoming.updatedAt,
      });
    }
  }

  const ranked = [...bySource.values()].sort((a, b) =>
    b.score - a.score ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.sourceKey.localeCompare(b.sourceKey)
  );

  const chosen: ProjectContextFact[] = [];
  const seenText = new Set<string>();
  for (const fact of ranked) {
    if (chosen.length >= PROJECT_CONTEXT_MAX_FACTS) break;
    const normalized = fact.text.toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]+/g, " ").trim();
    if (normalized && seenText.has(normalized)) continue;
    if (normalized) seenText.add(normalized);
    chosen.push(fact);
  }

  chosen.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
  const lines: string[] = [];
  let used = 0;
  for (const fact of chosen) {
    const prefix = "- [" + cleanText(fact.sourceKey, 160) + "] ";
    const remaining = PROJECT_CONTEXT_MAX_CONTENT_CHARS - used - prefix.length - 1;
    if (remaining <= 24) break;
    const text = fact.text.slice(0, remaining);
    lines.push(prefix + text);
    used += prefix.length + text.length + 1;
  }
  return {
    content: lines.join("\n"),
    sourceKeys: chosen.map((fact) => fact.sourceKey),
  };
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
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS learning_preflight_v1 (activity_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (activity_id,scope)) WITHOUT ROWID");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${PROJECT_ALIAS_TABLE} (
      alias_key TEXT PRIMARY KEY, project_key TEXT NOT NULL
    ) WITHOUT ROWID`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS learning_project_merge_preview_v1 (
      token TEXT PRIMARY KEY, source_key TEXT NOT NULL, target_key TEXT NOT NULL,
      revision TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    this.migrateProjectKeys();

  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/preflight-check" && request.method === "POST") {
      const input = await request.json<any>().catch(() => null);
      const activityId = String(input?.activityId || "");
      const scope = String(input?.scope || "");
      if (!/^act_[a-f0-9]{20}$/.test(activityId) || !/^(global|project:[^\s]{1,200})$/.test(scope)) return Response.json({ error: "invalid_preflight" }, { status: 400 });
      const row = this.ctx.storage.sql.exec<{ expires_at: number }>(
        "SELECT expires_at FROM learning_preflight_v1 WHERE activity_id=? AND scope=?", activityId, scope
      ).toArray()[0];
      return Response.json({ prepared: Boolean(row && row.expires_at > Date.now()) });
    }
    if (url.pathname === "/preflight-mark" && request.method === "POST") {
      const input = await request.json<any>().catch(() => null);
      const activityId = String(input?.activityId || "");
      const scopes: unknown[] = Array.isArray(input?.scopes) ? input.scopes : [];
      if (!/^act_[a-f0-9]{20}$/.test(activityId) || !scopes.length || scopes.length > 4 ||
          scopes.some((scope) => typeof scope !== "string" || !/^(global|project:[^\s]{1,200})$/.test(scope))) {
        return Response.json({ error: "invalid_preflight" }, { status: 400 });
      }
      const expiresAt = Date.now() + 4 * 60 * 60 * 1000;
      this.ctx.storage.sql.exec("DELETE FROM learning_preflight_v1 WHERE (activity_id, scope) IN (SELECT activity_id, scope FROM learning_preflight_v1 WHERE expires_at <= ? LIMIT 32)", Date.now());
      for (const scope of scopes) this.ctx.storage.sql.exec(
        "INSERT INTO learning_preflight_v1 (activity_id, scope, expires_at) VALUES (?,?,?) ON CONFLICT(activity_id,scope) DO UPDATE SET expires_at=excluded.expires_at",
        activityId, scope, expiresAt
      );
      return Response.json({ ok: true });
    }
    if (url.pathname === "/project-resolve" && request.method === "POST") return this.resolveProject(request);
    if (url.pathname === "/project-merge-preview" && request.method === "POST") return this.previewProjectMerge(request);
    if (url.pathname === "/project-merge-confirm" && request.method === "POST") return this.mergeProject(request, true);
    if (url.pathname === "/project-merge" && request.method === "POST") return this.mergeProject(request);
    if (url.pathname === "/get" && request.method === "POST") return this.get(request);
    if (url.pathname === "/profile" && request.method === "POST") return this.profile(request);
    if (url.pathname === "/put" && request.method === "POST") return this.put(request);
    if (url.pathname === "/delete" && request.method === "POST") return this.delete(request);
    if (url.pathname === "/feedback" && request.method === "POST") return this.feedback(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // One bounded migration per account DO cold start, not per tool call.
  // Re-key only direct project roots, retaining IDs, content, feedback and timestamps.
  private migrateProjectKeys() {
    const rows = this.ctx.storage.sql.exec<{ id: string; scope_key: string }>(
      `SELECT id, scope_key FROM ${TABLE} WHERE scope = 'project' AND scope_key IS NOT NULL LIMIT ?`,
      MAX_MEMORIES + 1,
    ).toArray();
    if (rows.length > MAX_MEMORIES) return; // Never partially migrate an oversized legacy account.
    for (const row of rows) {
      const canonical = canonicalLearnProjectKey(row.scope_key);
      if (canonical && canonical !== row.scope_key) {
        this.ctx.storage.sql.exec(`UPDATE ${TABLE} SET scope_key = ? WHERE id = ?`, canonical, row.id);
      }
    }
  }

  // An account owns its own Learning DO, so aliases never cross user boundaries.
  // Resolve only at Learn read/prepare/write, never on ordinary Relay tool calls.
  private resolveProjectKey(value: unknown): string | null {
    const key = canonicalLearnProjectKey(value);
    if (!key) return null;
    const row = this.ctx.storage.sql.exec<{ project_key: string }>(
      `SELECT project_key FROM ${PROJECT_ALIAS_TABLE} WHERE alias_key=? LIMIT 1`, key,
    ).toArray()[0];
    if (row) return row.project_key;
    // A registered folder alias applies even with different parent directories.
    // Unregistered folder names never cause automatic merges.
    const path = key.replace(/\\/g, "/");
    if (/^(?:[a-z]:\/|\/)/i.test(path)) {
      const leaf = path.split("/").filter(Boolean).at(-1)?.toLowerCase();
      if (leaf && leaf !== key) {
        const local = this.ctx.storage.sql.exec<{ project_key: string }>(
          `SELECT project_key FROM ${PROJECT_ALIAS_TABLE} WHERE alias_key=? LIMIT 1`, leaf,
        ).toArray()[0];
        if (local) return local.project_key;
      }
    }
    return key; // Mappings are flattened at creation time.
  }

  private async resolveProject(request: Request): Promise<Response> {
    const body = await request.json<any>().catch(() => null);
    const original = canonicalLearnProjectKey(body?.projectKey);
    if (!original) return Response.json({ error: "invalid_project" }, { status: 400 });
    const projectKey = this.resolveProjectKey(original);
    return Response.json({ projectKey, alias: original === projectKey ? null : original });
  }

  private async previewProjectMerge(request: Request): Promise<Response> {
    const body = await request.json<any>().catch(() => null);
    const from = canonicalLearnProjectKey(body?.from);
    const to = canonicalLearnProjectKey(body?.to);
    if (!from || !to || from === to) return Response.json({ error: "invalid_project_merge" }, { status: 400 });
    const target = this.resolveProjectKey(to);
    if (!target || from === target) return Response.json({ error: "invalid_project_merge" }, { status: 400 });
    const previous = this.ctx.storage.sql.exec<{ project_key: string }>(
      `SELECT project_key FROM ${PROJECT_ALIAS_TABLE} WHERE alias_key=? LIMIT 1`, from,
    ).toArray()[0];
    if (previous && previous.project_key !== target)
      return Response.json({ error: "alias_conflict", projectKey: previous.project_key }, { status: 409 });
    if (previous?.project_key === target)
      return Response.json({ ok: true, alreadyMerged: true, from, to: target, sourceCount: 0, confirmationToken: null });

    const source = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE} WHERE scope='project' AND scope_key=? ORDER BY id LIMIT ?`,
      from, MAX_PROJECT_MERGE_ROWS + 1,
    ).toArray();
    if (source.length > MAX_PROJECT_MERGE_ROWS)
      return Response.json({ error: "merge_too_large", limit: MAX_PROJECT_MERGE_ROWS }, { status: 409 });
    const destination = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE} WHERE scope='project' AND scope_key=? ORDER BY id LIMIT ?`,
      target, MAX_MEMORIES + 1,
    ).toArray();
    if (destination.length > MAX_MEMORIES)
      return Response.json({ error: "merge_too_large" }, { status: 409 });
    const aliasCount = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${PROJECT_ALIAS_TABLE}`,
    ).toArray()[0]?.count ?? 0;
    if (aliasCount >= MAX_PROJECT_ALIASES)
      return Response.json({ error: "alias_limit" }, { status: 409 });

    const byIdentity = new Map(destination.map((row: any) => [row.kind + "\0" + row.memory_key, row]));
    const conflicts: Array<{ key: string; kind: string }> = [];
    let identical = 0;
    for (const row of source) {
      const existing = byIdentity.get(row.kind + "\0" + row.memory_key) as any;
      if (existing?.content === row.content) identical++;
      else if (existing) conflicts.push({ key: String(row.memory_key), kind: String(row.kind) });
    }
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + MERGE_PREVIEW_TTL_MS;
    this.ctx.storage.sql.exec(
      "DELETE FROM learning_project_merge_preview_v1 WHERE token IN (SELECT token FROM learning_project_merge_preview_v1 WHERE expires_at <= ? LIMIT 32)",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO learning_project_merge_preview_v1 (token,source_key,target_key,revision,expires_at) VALUES (?,?,?,?,?)",
      token, from, target, projectMergeRevision(from, target, source, destination), expiresAt,
    );
    return Response.json({
      ok: true, action: "preview", from, to: target,
      sourceCount: source.length, targetCount: destination.length,
      willMove: source.length - identical, willDeduplicate: identical,
      willRename: conflicts.length, conflicts: conflicts.slice(0, 12),
      resultingCount: source.length + destination.length - identical,
      confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(),
      instruction: "Show the preview and obtain explicit user approval before commit. Then call learn_merge_projects with action=commit, confirmed=true and this confirmationToken.",
    });
  }

  private async mergeProject(request: Request, requireConfirmation = false): Promise<Response> {
    const body = await request.json<any>().catch(() => null);
    const from = canonicalLearnProjectKey(body?.from);
    const to = canonicalLearnProjectKey(body?.to);
    if (!from || !to || from === to) return Response.json({ error: "invalid_project_merge" }, { status: 400 });
    const target = this.resolveProjectKey(to);
    if (!target || from === target) return Response.json({ error: "invalid_project_merge" }, { status: 400 });
    const previous = this.ctx.storage.sql.exec<{ project_key: string }>(
      `SELECT project_key FROM ${PROJECT_ALIAS_TABLE} WHERE alias_key=? LIMIT 1`, from,
    ).toArray()[0];
    if (previous && previous.project_key !== target) {
      return Response.json({ error: "alias_conflict", projectKey: previous.project_key }, { status: 409 });
    }
    const source = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE} WHERE scope = 'project' AND scope_key = ? ORDER BY id LIMIT ?`, from, MAX_PROJECT_MERGE_ROWS + 1,
    ).toArray();
    if (source.length > MAX_PROJECT_MERGE_ROWS) return Response.json({ error: "merge_too_large", limit: MAX_PROJECT_MERGE_ROWS }, { status: 409 });
    const destination = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE} WHERE scope = 'project' AND scope_key = ? ORDER BY id LIMIT ?`, target, MAX_MEMORIES + 1,
    ).toArray();
    if (destination.length > MAX_MEMORIES) return Response.json({ error: "merge_too_large" }, { status: 409 });
    const currentAliases = this.ctx.storage.sql.exec<{ alias_key: string; project_key: string }>(
      `SELECT alias_key, project_key FROM ${PROJECT_ALIAS_TABLE} LIMIT ?`, MAX_PROJECT_ALIASES + 1,
    ).toArray();
    if (currentAliases.length >= MAX_PROJECT_ALIASES && !previous) {
      return Response.json({ error: "alias_limit" }, { status: 409 });
    }

    let confirmationToken: string | null = null;
    if (requireConfirmation) {
      const token = String(body?.confirmationToken ?? "");
      if (body?.confirmed !== true || !/^[a-f0-9-]{36}$/i.test(token))
        return Response.json({ error: "merge_confirmation_required" }, { status: 403 });
      const grant = this.ctx.storage.sql.exec<{
        source_key: string; target_key: string; revision: string; expires_at: number
      }>(
        "SELECT source_key,target_key,revision,expires_at FROM learning_project_merge_preview_v1 WHERE token=? LIMIT 1", token,
      ).toArray()[0];
      if (!grant || grant.source_key !== from || grant.target_key !== target || grant.expires_at <= Date.now())
        return Response.json({ error: "merge_preview_expired", retryPreview: true }, { status: 409 });
      if (grant.revision !== projectMergeRevision(from, target, source, destination))
        return Response.json({ error: "merge_preview_stale", retryPreview: true }, { status: 409 });
      confirmationToken = token;
    }

    let moved = 0;
    let deduplicated = 0;
    let renamed = 0;
    const collisions = new Map(destination.map((row: any) => [row.kind + "\0" + row.memory_key, row]));
    const doMerge = () => {
      for (const row of source) {
        let key = String(row.memory_key);
        const collision = collisions.get(row.kind + "\0" + key) as any;
        if (collision && collision.content === row.content) {
          const confidence = Math.max(Number(row.confidence), Number(collision.confidence));
          const positives = Math.max(Number(row.positive_feedback), Number(collision.positive_feedback));
          const negatives = Math.max(Number(row.negative_feedback), Number(collision.negative_feedback));
          const createdAt = [row.created_at, collision.created_at].sort()[0];
          const updatedAt = [row.updated_at, collision.updated_at].sort().at(-1);
          this.ctx.storage.sql.exec(
            `UPDATE ${TABLE} SET confidence=?, positive_feedback=?, negative_feedback=?, created_at=?, updated_at=? WHERE id=?`,
            confidence, positives, negatives, createdAt, updatedAt, collision.id,
          );
          this.ctx.storage.sql.exec(`DELETE FROM ${TABLE} WHERE id=?`, row.id);
          deduplicated++;
          continue;
        }
        if (collision) {
          const suffix = "-merged-" + String(row.id).slice(-12);
          key = key.slice(0, 160 - suffix.length) + suffix;
          renamed++;
        }
        this.ctx.storage.sql.exec(`UPDATE ${TABLE} SET scope_key=?, memory_key=? WHERE id=?`, target, key, row.id);
        collisions.set(row.kind + "\0" + key, { ...row, memory_key: key });
        moved++;
      }
      // Single-use token is consumed atomically with the merge.
      if (confirmationToken) this.ctx.storage.sql.exec(
        "DELETE FROM learning_project_merge_preview_v1 WHERE token=?", confirmationToken,
      );
      // Flatten aliases that pointed to this source before saving the source mapping.
      this.ctx.storage.sql.exec(`UPDATE ${PROJECT_ALIAS_TABLE} SET project_key=? WHERE project_key=?`, target, from);
      this.ctx.storage.sql.exec(
        `INSERT INTO ${PROJECT_ALIAS_TABLE} (alias_key, project_key) VALUES (?,?)
          ON CONFLICT(alias_key) DO UPDATE SET project_key=excluded.project_key`, from, target,
      );
    };
    this.ctx.storage.transactionSync(doMerge);
    if (this.memoryCount !== null) this.memoryCount -= deduplicated;
    return Response.json({ ok: true, from, to: target, moved, deduplicated, renamed, aliases: [from] });
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

  private async putProjectContext(
    sourceKey: string,
    incomingContent: string,
    scopeKey: string,
    confidence: number,
  ) {
    const now = new Date().toISOString();
    const rows = this.ctx.storage.sql.exec<any>(
      `SELECT * FROM ${TABLE}
       WHERE kind = ? AND scope = ? AND scope_key = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      "project_context",
      "project",
      scopeKey,
      PROJECT_CONTEXT_SCAN_LIMIT,
    ).toArray().map(rowToRecord);

    const incomingBucket = projectContextBucket(sourceKey, incomingContent);
    const sweepAll = rows.length >= PROJECT_CONTEXT_COMPACT_TRIGGER ||
      rows.some((record) => canonicalProjectContextBucket(record.key) === null);
    const buckets = new Set<ProjectContextBucket>([incomingBucket]);
    if (sweepAll) {
      for (const record of rows) buckets.add(projectContextBucket(record.key, record.content));
    }

    const potentialDeletions = rows.filter((record) => canonicalProjectContextBucket(record.key) === null).length;
    const targetRows = rows.filter((record) => projectContextBucket(record.key, record.content) === incomingBucket);
    const targetCanonicalKey = projectContextCanonicalKey(incomingBucket);
    const targetCanonicalId = await recordId("project_context", "project", scopeKey, targetCanonicalKey);
    const targetCanonicalExists = targetRows.some((record) => record.id === targetCanonicalId || record.key === targetCanonicalKey);
    if (!targetCanonicalExists && targetRows.length === 0 && potentialDeletions === 0 && !(await this.ensureMemoryCapacity())) {
      return Response.json({ error: "memory_limit", limit: MAX_MEMORIES }, { status: 409 });
    }

    const groups: LearnCompactionGroup[] = [];
    const removedIds: string[] = [];
    const changedItems: LearnRecord[] = [];
    let targetItem: LearnRecord | null = null;
    let targetWasExisting = false;

    for (const bucket of buckets) {
      const canonicalKey = projectContextCanonicalKey(bucket);
      const canonicalId = await recordId("project_context", "project", scopeKey, canonicalKey);
      const bucketRows = rows.filter((record) => projectContextBucket(record.key, record.content) === bucket);
      const canonicalExisting = bucketRows.find((record) => record.id === canonicalId || record.key === canonicalKey) ?? null;
      const incoming = bucket === incomingBucket
        ? { key: sourceKey, content: incomingContent, confidence, updatedAt: now }
        : undefined;
      const merged = mergeProjectContextContent(bucketRows, incoming);
      if (!merged.content) continue;

      const groupConfidence = Math.max(
        incoming?.confidence ?? 0,
        ...bucketRows.map((record) => record.confidence),
      );
      const feedbackSource = canonicalExisting ??
        [...bucketRows].sort((a, b) =>
          b.confidence - a.confidence ||
          b.updatedAt.localeCompare(a.updatedAt)
        )[0] ??
        null;
      const positiveFeedback = feedbackSource?.positiveFeedback === 1 ? 1 : 0;
      const negativeFeedback = feedbackSource?.negativeFeedback === 1 && positiveFeedback === 0 ? 1 : 0;
      const createdAt = canonicalExisting?.createdAt ??
        bucketRows.map((record) => record.createdAt).sort()[0] ??
        now;

      const item: LearnRecord = {
        id: canonicalExisting?.id ?? canonicalId,
        key: canonicalKey,
        kind: "project_context",
        scope: "project",
        scopeKey,
        content: merged.content,
        confidence: groupConfidence,
        positiveFeedback,
        negativeFeedback,
        createdAt,
        updatedAt: now,
      };

      const fragments = bucketRows.filter((record) => record.id !== item.id);
      const writeNeeded = !canonicalExisting ||
        canonicalExisting.content !== item.content ||
        canonicalExisting.confidence !== item.confidence ||
        canonicalExisting.positiveFeedback !== item.positiveFeedback ||
        canonicalExisting.negativeFeedback !== item.negativeFeedback;
      const groupChanged = writeNeeded || fragments.length > 0;

      if (writeNeeded) {
        this.ctx.storage.sql.exec(
          `INSERT INTO ${TABLE} (id, memory_key, kind, scope, scope_key, content, confidence, positive_feedback, negative_feedback, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             memory_key=excluded.memory_key,
             content=excluded.content,
             confidence=excluded.confidence,
             positive_feedback=excluded.positive_feedback,
             negative_feedback=excluded.negative_feedback,
             updated_at=excluded.updated_at`,
          item.id,
          item.key,
          item.kind,
          item.scope,
          item.scopeKey,
          item.content,
          item.confidence,
          item.positiveFeedback,
          item.negativeFeedback,
          item.createdAt,
          item.updatedAt,
        );
      } else if (canonicalExisting) {
        item.updatedAt = canonicalExisting.updatedAt;
      }

      for (const fragment of fragments) {
        this.ctx.storage.sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, fragment.id);
        removedIds.push(fragment.id);
      }

      if (this.memoryCount !== null) {
        if (!canonicalExisting && writeNeeded) this.memoryCount += 1;
        this.memoryCount = Math.max(0, this.memoryCount - fragments.length);
      }

      if (groupChanged) changedItems.push(item);
      groups.push({
        bucket,
        canonicalKey,
        mergedSourceKeys: merged.sourceKeys,
        removedIds: fragments.map((record) => record.id),
        item,
        changed: groupChanged,
      });

      if (bucket === incomingBucket) {
        targetItem = item;
        targetWasExisting = Boolean(canonicalExisting);
      }
    }

    if (!targetItem) {
      return Response.json({ error: "project_context_compaction_failed" }, { status: 500 });
    }

    const changed = groups.some((group) => group.changed);
    const compaction: LearnCompactionResult = {
      applied: changed && (removedIds.length > 0 || groups.some((group) => group.mergedSourceKeys.length > 1)),
      scopeKey,
      groups,
      removedIds,
      items: changedItems,
      truncated: rows.length >= PROJECT_CONTEXT_SCAN_LIMIT,
    };

    if (!changed) {
      return Response.json({ ok: true, changed: false, item: targetItem, change: null, compaction });
    }

    const change = this.makeChange({
      memoryId: targetItem.id,
      type: targetWasExisting ? "updated" : "created",
      key: targetItem.key,
      kind: targetItem.kind,
      scope: targetItem.scope,
      scopeKey: targetItem.scopeKey,
      summary: summarizeMemory(targetItem.content),
      confidence: targetItem.confidence,
      previousConfidence: targetWasExisting ? targetItem.confidence : null,
      at: now,
    });
    return Response.json({ ok: true, changed: true, item: targetItem, change, compaction });
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
        const scopeKey = scope === "project" ? this.resolveProjectKey(entry?.scopeKey) : cleanText(entry?.scopeKey, 200);
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
      const resolvedProjectKey = scopeSelectors.find((item) => item.scope === "project")?.scopeKey ?? null;
      return Response.json({ items, limit, strategy: "balanced-kind", perKind, routingReserve, resolvedProjectKey });
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
    const aliases = this.ctx.storage.sql.exec<{ alias_key: string; project_key: string }>(
      `SELECT alias_key, project_key FROM ${PROJECT_ALIAS_TABLE} ORDER BY alias_key LIMIT ?`, MAX_PROJECT_ALIASES,
    ).toArray().map((row) => ({ alias: row.alias_key, projectKey: row.project_key }));
    return Response.json({
      items, aliases,
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
    const scopeKey = scope === "global" ? null : scope === "project" ? this.resolveProjectKey(rawScopeKey) : cleanText(rawScopeKey, 200);
    if (!kind || !scope || !key || !content || (scope !== "global" && !scopeKey)) {
      return Response.json({ error: "invalid_memory" }, { status: 400 });
    }

    const confidence = boundedInt(body?.confidence, 100, 0, 100);
    if (kind === "project_context" && scope === "project" && scopeKey) {
      return this.putProjectContext(key, content, scopeKey, confidence);
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
