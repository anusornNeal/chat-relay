import type { UsageEvent } from "./usage";

type SqlValue = string | number | ArrayBuffer | null;
type SqlCursor<Row extends Record<string, SqlValue> = Record<string, SqlValue>> = {
  toArray(): Row[];
};
type SqlStorage = {
  exec<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<Row>;
};
type Storage = DurableObjectStorage & {
  sql?: SqlStorage;
};

type QueryFilters = {
  errors: boolean;
  limit: number;
  before?: string;
  fromMs?: number;
  toMs?: number;
  userId?: string | null;
  tool?: string | null;
  agentId?: string | null;
  activityId?: string | null;
  status?: string | null;
  errorClass?: string | null;
  operational?: string | null;
  q?: string | null;
};

export type IndexedUsageRow = {
  key: string;
  event: UsageEvent;
};

const READY_KEY = "usage-query-index:v1:ready";
const BACKFILL_CURSOR_KEY = "usage-query-index:v1:cursor";
const BACKFILL_STARTED_KEY = "usage-query-index:v1:started";
const TABLE = "usage_event_query_v1";
const BACKFILL_PAGE_SIZE = 250;
const INSERT_BATCH_SIZE = 50;

function statusOf(event: UsageEvent) {
  return event.ok ? "success" : "error";
}

function sqlLike(value: string) {
  return "%" + value.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
}

export class UsageQueryIndex {
  private readonly sql: SqlStorage | null;
  private ready = false;
  private backfillStepPromise?: Promise<boolean>;

  constructor(
    private readonly storage: Storage,
    private readonly isOperationalFailure: (event: UsageEvent) => boolean,
  ) {
    this.sql = storage.sql ?? null;
    if (this.sql) this.initialize();
  }

  get available() {
    return this.sql !== null;
  }

  private initialize() {
    this.sql!.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        event_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        agent_id TEXT,
        activity_id TEXT,
        status TEXT NOT NULL,
        error_class TEXT,
        operational INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    for (const statement of [
      `CREATE INDEX IF NOT EXISTS usage_event_query_completed ON ${TABLE}(completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_user ON ${TABLE}(user_id, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_user_status ON ${TABLE}(user_id, status, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_tool ON ${TABLE}(tool, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_agent ON ${TABLE}(agent_id, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_status ON ${TABLE}(status, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_activity ON ${TABLE}(activity_id, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_error ON ${TABLE}(error_class, completed_at DESC, event_key DESC)`,
      `CREATE INDEX IF NOT EXISTS usage_event_query_operational ON ${TABLE}(operational, completed_at DESC, event_key DESC)`,
    ]) this.sql!.exec(statement);
  }

  private values(key: string, event: UsageEvent): SqlValue[] {
    return [
      key,
      event.timestamp,
      event.startedAt || event.timestamp,
      event.userId,
      event.tool,
      event.agentId || null,
      event.activityId || null,
      statusOf(event),
      event.errorClass || null,
      !event.ok && this.isOperationalFailure(event) ? 1 : 0,
      JSON.stringify(event),
    ];
  }

  upsert(key: string, event: UsageEvent) {
    if (!this.sql) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO ${TABLE}
       (event_key, completed_at, started_at, user_id, tool, agent_id, activity_id, status, error_class, operational, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...this.values(key, event),
    );
  }

  private upsertBatch(rows: Array<[string, UsageEvent]>) {
    if (!this.sql || !rows.length) return;
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
      const bindings = batch.flatMap(([key, event]) => this.values(key, event));
      this.sql.exec(
        `INSERT OR REPLACE INTO ${TABLE}
         (event_key, completed_at, started_at, user_id, tool, agent_id, activity_id, status, error_class, operational, payload)
         VALUES ${placeholders}`,
        ...bindings,
      );
    }
  }

  async isReady() {
    if (!this.sql) return false;
    if (this.ready) return true;
    this.ready = Boolean(await this.storage.get<boolean>(READY_KEY));
    return this.ready;
  }

  async backfillStep(pageSize = BACKFILL_PAGE_SIZE): Promise<boolean> {
    if (!this.sql) return true;
    if (await this.isReady()) return true;
    if (this.backfillStepPromise) return this.backfillStepPromise;

    this.backfillStepPromise = (async () => {
      if (await this.isReady()) return true;

      const started = await this.storage.get<boolean>(BACKFILL_STARTED_KEY);
      if (!started) {
        this.sql!.exec(`DELETE FROM ${TABLE}`);
        await this.storage.put(BACKFILL_STARTED_KEY, true);
      }

      const startAfter = await this.storage.get<string>(BACKFILL_CURSOR_KEY);
      const page = await this.storage.list<UsageEvent>({
        prefix: "event:",
        limit: Math.max(1, Math.min(1000, pageSize)),
        ...(startAfter ? { startAfter } : {}),
      });
      this.upsertBatch([...page.entries()]);

      if (page.size < Math.max(1, Math.min(1000, pageSize))) {
        await this.storage.put(READY_KEY, true);
        await this.storage.delete([BACKFILL_CURSOR_KEY, BACKFILL_STARTED_KEY]);
        this.ready = true;
        return true;
      }

      const nextCursor = [...page.keys()].at(-1)!;
      await this.storage.put(BACKFILL_CURSOR_KEY, nextCursor);
      return false;
    })().finally(() => {
      this.backfillStepPromise = undefined;
    });

    return this.backfillStepPromise;
  }

  async ensureBackfilled() {
    while (!(await this.backfillStep())) {}
  }

  async markDirty() {
    this.ready = false;
    await this.storage.delete([READY_KEY, BACKFILL_CURSOR_KEY, BACKFILL_STARTED_KEY]);
  }

  delete(keys: string[]) {
    if (!this.sql || !keys.length) return;
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batch = keys.slice(offset, offset + 100);
      this.sql.exec(
        `DELETE FROM ${TABLE} WHERE event_key IN (${batch.map(() => "?").join(",")})`,
        ...batch,
      );
    }
  }

  query(filters: QueryFilters) {
    if (!this.sql) return null;
    const where: string[] = [];
    const bindings: SqlValue[] = [];

    if (filters.before) {
      const beforeCompletedAt = filters.before.slice(6, 30);
      where.push("(completed_at < ? OR (completed_at = ? AND event_key < ?))");
      bindings.push(beforeCompletedAt, beforeCompletedAt, filters.before);
    }

    const timeColumn = filters.errors ? "completed_at" : "started_at";
    if (Number.isFinite(filters.fromMs)) {
      where.push(`${timeColumn} >= ?`);
      bindings.push(new Date(filters.fromMs!).toISOString());
    }
    if (Number.isFinite(filters.toMs)) {
      where.push(`${timeColumn} <= ?`);
      bindings.push(new Date(filters.toMs!).toISOString());
    }

    const equality: Array<[string, string | null | undefined]> = [
      ["user_id", filters.userId],
      ["tool", filters.tool],
      ["agent_id", filters.agentId],
      ["activity_id", filters.activityId],
      ["status", filters.status],
      ["error_class", filters.errorClass],
    ];
    for (const [column, value] of equality) {
      if (!value) continue;
      where.push(`${column} = ?`);
      bindings.push(value);
    }

    if (filters.errors && !filters.status) {
      where.push("status = 'error'");
    }
    if (filters.operational === "true" || filters.operational === "false") {
      where.push("operational = ?");
      bindings.push(filters.operational === "true" ? 1 : 0);
    }

    const q = String(filters.q || "").trim().toLowerCase();
    if (q) {
      const pattern = sqlLike(q);
      where.push("(LOWER(tool) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(agent_id, '')) LIKE ? ESCAPE '\\')");
      bindings.push(pattern, pattern);
    }

    const fetchLimit = Math.max(1, Math.min(101, filters.limit + 1));
    bindings.push(fetchLimit);
    const rows = this.sql.exec<{ event_key: string; payload: string }>(
      `SELECT event_key, payload
       FROM ${TABLE}
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY completed_at DESC, event_key DESC
       LIMIT ?`,
      ...bindings,
    ).toArray();

    const page = rows.slice(0, filters.limit).map((row) => ({
      key: String(row.event_key),
      event: JSON.parse(String(row.payload)) as UsageEvent,
    }));
    return {
      rows: page,
      hasMore: rows.length > filters.limit,
      nextBefore: rows.length > filters.limit && page.length ? page.at(-1)!.key : null,
      rowsReadUpperBound: rows.length,
    };
  }
}
