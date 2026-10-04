import type { UsageEvent } from "./usage";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BKK = 7 * HOUR;
const TABLE = "usage_hourly_v3";

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
type Storage = DurableObjectStorage & { sql?: SqlStorage };

type LegacyMetric = { calls?: number };
type LegacyGroup = {
  userId: string;
  agentId?: string;
  metric?: LegacyMetric;
};
type LegacyBucket = {
  groups?: Record<string, LegacyGroup>;
  overflow?: boolean;
};

export type UsageFilters = {
  userId?: string | null;
  agentId?: string | null;
};

export type UsageCountRow = {
  userId: string;
  agentId: string;
  calls: number;
};

function hourStart(timestampMs: number) {
  return Math.floor(timestampMs / HOUR) * HOUR;
}

function bkkDayStart(timestampMs: number) {
  return Math.floor((timestampMs + BKK) / DAY) * DAY - BKK;
}

function dayKey(startMs: number) {
  return `agg:v1:day:${new Date(startMs).toISOString()}`;
}

function hourKey(startMs: number) {
  return `agg:v1:hour:${new Date(startMs).toISOString()}`;
}

function rowKey(userId: string, agentId: string) {
  return JSON.stringify([userId, agentId]);
}

function addRow(target: Map<string, UsageCountRow>, userId: string, agentId: string, calls: number) {
  if (!calls) return;
  const key = rowKey(userId, agentId);
  const current = target.get(key) || { userId, agentId, calls: 0 };
  current.calls += calls;
  target.set(key, current);
}

export class UsageAggregates {
  private readonly sql: SqlStorage | null;

  constructor(private readonly storage: Storage) {
    this.sql = storage.sql ?? null;
    if (this.sql) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          bucket_key TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          calls INTEGER NOT NULL
        ) WITHOUT ROWID
      `);
    }
  }

  invalidate(_event?: UsageEvent) {
    // SQL is the source of truth; there is no in-memory aggregate cache to invalidate.
  }

  async record(event: UsageEvent) {
    const timestampMs = Date.parse(event.timestamp);
    const hourMs = hourStart(timestampMs);
    const userId = event.userId;
    const agentId = event.agentId || "";

    if (this.sql) {
      const bucketKey = `${String(hourMs).padStart(13, "0")}|${encodeURIComponent(userId)}|${encodeURIComponent(agentId)}`;
      this.sql.exec(
        `INSERT INTO ${TABLE} (bucket_key, user_id, agent_id, calls)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(bucket_key)
         DO UPDATE SET calls = calls + 1`,
        bucketKey,
        userId,
        agentId,
      );
      return;
    }

    // Test/runtime fallback for non-SQL storage. Production Usage is a SQLite DO.
    const key = `usage:v2:${String(hourMs).padStart(13, "0")}:${encodeURIComponent(userId)}:${encodeURIComponent(agentId)}`;
    const current = Number(await this.storage.get<number>(key) || 0);
    await this.storage.put(key, current + 1);
  }

  private sqlRows(fromMs: number, toMs: number, filters: UsageFilters) {
    if (!this.sql) return { rows: [] as UsageCountRow[], firstHour: null as number | null };

    const startKey = `${String(hourStart(fromMs)).padStart(13, "0")}|`;
    const endKey = `${String(hourStart(toMs) + HOUR).padStart(13, "0")}|`;
    const where = ["bucket_key >= ?", "bucket_key < ?"];
    const bindings: SqlValue[] = [startKey, endKey];
    if (filters.userId) {
      where.push("user_id = ?");
      bindings.push(filters.userId);
    }
    if (filters.agentId) {
      where.push("agent_id = ?");
      bindings.push(filters.agentId);
    }

    const rows = this.sql.exec<{
      kind: string;
      user_id: string | null;
      agent_id: string | null;
      calls: number | null;
      first_key: string | null;
    }>(
      `WITH filtered AS (
         SELECT user_id, agent_id, SUM(calls) AS calls
         FROM ${TABLE}
         WHERE ${where.join(" AND ")}
         GROUP BY user_id, agent_id
       )
       SELECT 'data' AS kind, user_id, agent_id, calls, NULL AS first_key FROM filtered
       UNION ALL
       SELECT 'meta' AS kind, NULL AS user_id, NULL AS agent_id, NULL AS calls,
              (SELECT MIN(bucket_key) FROM ${TABLE}) AS first_key`,
      ...bindings,
    ).toArray();

    const data: UsageCountRow[] = [];
    let firstHour: number | null = null;
    for (const row of rows) {
      if (row.kind === "meta") {
        const firstKey = row.first_key;
        firstHour = firstKey ? Number(firstKey.slice(0, 13)) : null;
        continue;
      }
      data.push({
        userId: String(row.user_id || ""),
        agentId: String(row.agent_id || ""),
        calls: Number(row.calls || 0),
      });
    }
    return { rows: data, firstHour };
  }

  private async fallbackRows(fromMs: number, toMs: number, filters: UsageFilters) {
    if (this.sql) return [] as UsageCountRow[];
    const records = await this.storage.list<number>({ prefix: "usage:v2:" });
    const rows = new Map<string, UsageCountRow>();
    for (const [key, value] of records) {
      const parts = key.split(":");
      if (parts.length < 5) continue;
      const hourMs = Number(parts[2]);
      if (!Number.isFinite(hourMs) || hourMs < hourStart(fromMs) || hourMs > hourStart(toMs)) continue;
      const userId = decodeURIComponent(parts[3] || "");
      const agentId = decodeURIComponent(parts.slice(4).join(":") || "");
      if (filters.userId && userId !== filters.userId) continue;
      if (filters.agentId && agentId !== filters.agentId) continue;
      addRow(rows, userId, agentId, Number(value || 0));
    }
    return [...rows.values()];
  }

  private consumeLegacyBucket(
    target: Map<string, UsageCountRow>,
    bucket: LegacyBucket | undefined,
    filters: UsageFilters,
  ) {
    if (!bucket?.groups) return;
    for (const group of Object.values(bucket.groups)) {
      const userId = String(group.userId || "");
      const agentId = String(group.agentId || "__relay__");
      if (!userId) continue;
      if (filters.userId && userId !== filters.userId) continue;
      if (filters.agentId && agentId !== filters.agentId) continue;
      addRow(target, userId, agentId, Number(group.metric?.calls || 0));
    }
  }

  private async legacyRows(
    fromMs: number,
    toMs: number,
    filters: UsageFilters,
    firstSqlHour: number | null,
  ) {
    let legacyTo = toMs;
    if (firstSqlHour !== null) {
      const cutoverDay = bkkDayStart(firstSqlHour);
      if (fromMs > cutoverDay + DAY - 1) return [] as UsageCountRow[];
      legacyTo = Math.min(legacyTo, cutoverDay + DAY - 1);
    }
    if (legacyTo < fromMs) return [] as UsageCountRow[];

    const starts: number[] = [];
    for (let cursor = bkkDayStart(fromMs); cursor <= legacyTo; cursor += DAY) starts.push(cursor);
    if (!starts.length) return [] as UsageCountRow[];

    const dayKeys = starts.map(dayKey);
    const buckets = await this.storage.get<LegacyBucket>(dayKeys);
    const result = new Map<string, UsageCountRow>();
    const overflowDays: number[] = [];

    for (let index = 0; index < starts.length; index++) {
      const bucket = buckets.get(dayKeys[index]);
      if (bucket?.overflow) overflowDays.push(starts[index]);
      else this.consumeLegacyBucket(result, bucket, filters);
    }

    // Rare legacy overflow fallback: still one batched read for all affected hours.
    if (overflowDays.length) {
      const hourStarts = overflowDays.flatMap((day) =>
        Array.from({ length: 24 }, (_, index) => day + index * HOUR),
      );
      const hourKeys = hourStarts.map(hourKey);
      const hours = await this.storage.get<LegacyBucket>(hourKeys);
      for (const key of hourKeys) this.consumeLegacyBucket(result, hours.get(key), filters);
    }

    return [...result.values()];
  }

  async window(
    fromMs: number,
    toMs: number,
    filters: UsageFilters = {},
    _includeBuckets = false,
  ) {
    const sql = this.sqlRows(fromMs, toMs, filters);
    const currentRows = this.sql ? sql.rows : await this.fallbackRows(fromMs, toMs, filters);
    const legacy = await this.legacyRows(fromMs, toMs, filters, this.sql ? sql.firstHour : null);

    const combined = new Map<string, UsageCountRow>();
    for (const row of legacy) addRow(combined, row.userId, row.agentId, row.calls);
    for (const row of currentRows) addRow(combined, row.userId, row.agentId, row.calls);

    const agents = [...combined.values()]
      .sort((a, b) => b.calls - a.calls || a.userId.localeCompare(b.userId) || a.agentId.localeCompare(b.agentId));

    const userMap = new Map<string, number>();
    let calls = 0;
    for (const row of agents) {
      calls += row.calls;
      userMap.set(row.userId, (userMap.get(row.userId) || 0) + row.calls);
    }
    const users = [...userMap.entries()]
      .map(([userId, userCalls]) => ({ userId, calls: userCalls }))
      .sort((a, b) => b.calls - a.calls || a.userId.localeCompare(b.userId));

    return {
      metric: calls ? { calls } : null,
      users,
      agents,
      sampleSize: calls,
      bounded: false,
      coverage: legacy.length ? "legacy+sql" : "sql",
    };
  }
}
