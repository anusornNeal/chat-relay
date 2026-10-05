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

function operationalFailure(event: UsageEvent) {
  if (event.ok !== false) return false;
  const stage = String(event.failureStage || "").toLowerCase();
  const source = String(event.errorSource || "").toLowerCase();
  const code = String(event.errorCode || "").toLowerCase();
  if (["timeout", "relay", "worker"].includes(stage) || ["relay", "worker"].includes(source)) return true;
  return /agent_(timeout|offline|stale|unavailable)/.test(code);
}

function durationBin(durationMs: number) {
  if (durationMs <= 0) return 0;
  return Math.min(400, Math.ceil(Math.log(durationMs) / Math.log(1.1)) + 1);
}

function jsonPathForKey(key: string) {
  return '$."' + key.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
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
      const columns = new Set(
        this.sql.exec<{ name: string }>(`PRAGMA table_info(${TABLE})`).toArray().map((row) => String(row.name)),
      );
      const additions = [
        ["detail_calls", "INTEGER NOT NULL DEFAULT 0"],
        ["errors", "INTEGER NOT NULL DEFAULT 0"],
        ["operational_errors", "INTEGER NOT NULL DEFAULT 0"],
        ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
        ["request_bytes", "INTEGER NOT NULL DEFAULT 0"],
        ["response_bytes", "INTEGER NOT NULL DEFAULT 0"],
        ["min_duration_ms", "INTEGER NOT NULL DEFAULT 0"],
        ["max_duration_ms", "INTEGER NOT NULL DEFAULT 0"],
        ["histogram_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["tools_json", "TEXT NOT NULL DEFAULT '{}'"],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${definition}`);
      }
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
      if (!event.tool) {
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

      const duration = Math.min(120_000, Math.max(0, Math.round(Number(event.durationMs) || 0)));
      const errors = event.ok === false ? 1 : 0;
      const operationalErrors = operationalFailure(event) ? 1 : 0;
      const requestBytes = Math.max(0, Math.round(Number(event.requestBytes) || 0));
      const responseBytes = Math.max(0, Math.round(Number(event.responseBytes) || 0));
      const binKey = "b" + durationBin(duration);
      const toolKey = String(event.tool).slice(0, 128);
      const histogramPath = jsonPathForKey(binKey);
      const toolPath = jsonPathForKey(toolKey);
      this.sql.exec(
        `INSERT INTO ${TABLE} (
           bucket_key, user_id, agent_id, calls, detail_calls, errors, operational_errors,
           duration_ms, request_bytes, response_bytes, min_duration_ms, max_duration_ms,
           histogram_json, tools_json
         )
         VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_key)
         DO UPDATE SET
           calls = calls + 1,
           detail_calls = detail_calls + 1,
           errors = errors + excluded.errors,
           operational_errors = operational_errors + excluded.operational_errors,
           duration_ms = duration_ms + excluded.duration_ms,
           request_bytes = request_bytes + excluded.request_bytes,
           response_bytes = response_bytes + excluded.response_bytes,
           min_duration_ms = CASE
             WHEN detail_calls = 0 THEN excluded.min_duration_ms
             ELSE MIN(min_duration_ms, excluded.min_duration_ms)
           END,
           max_duration_ms = MAX(max_duration_ms, excluded.max_duration_ms),
           histogram_json = json_set(
             COALESCE(histogram_json, '{}'),
             ?,
             COALESCE(json_extract(histogram_json, ?), 0) + 1
           ),
           tools_json = json_set(
             COALESCE(tools_json, '{}'),
             ?,
             COALESCE(json_extract(tools_json, ?), 0) + 1
           )`,
        bucketKey,
        userId,
        agentId,
        errors,
        operationalErrors,
        duration,
        requestBytes,
        responseBytes,
        duration,
        duration,
        JSON.stringify({ [binKey]: 1 }),
        JSON.stringify({ [toolKey]: 1 }),
        histogramPath,
        histogramPath,
        toolPath,
        toolPath,
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

  private sqlDetails(fromMs: number, toMs: number, filters: UsageFilters) {
    if (!this.sql) return null;

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
    const predicate = where.join(" AND ");

    const metric = this.sql.exec<{
      calls: number | null;
      detail_calls: number | null;
      errors: number | null;
      operational_errors: number | null;
      duration_ms: number | null;
      request_bytes: number | null;
      response_bytes: number | null;
      min_duration_ms: number | null;
      max_duration_ms: number | null;
    }>(
      `SELECT
         SUM(calls) AS calls,
         SUM(detail_calls) AS detail_calls,
         SUM(errors) AS errors,
         SUM(operational_errors) AS operational_errors,
         SUM(duration_ms) AS duration_ms,
         SUM(request_bytes) AS request_bytes,
         SUM(response_bytes) AS response_bytes,
         MIN(CASE WHEN detail_calls > 0 THEN min_duration_ms END) AS min_duration_ms,
         MAX(CASE WHEN detail_calls > 0 THEN max_duration_ms END) AS max_duration_ms
       FROM ${TABLE}
       WHERE ${predicate}`,
      ...bindings,
    ).toArray()[0];

    const histogram = this.sql.exec<{ bin: string; count: number | null }>(
      `SELECT json_each.key AS bin, SUM(CAST(json_each.value AS INTEGER)) AS count
       FROM ${TABLE}, json_each(histogram_json)
       WHERE ${predicate}
       GROUP BY json_each.key`,
      ...bindings,
    ).toArray();

    const detailedCalls = Number(metric?.detail_calls || 0);
    let p95DurationMs: number | null = null;
    if (detailedCalls > 0) {
      let rank = Math.ceil(detailedCalls * 0.95);
      const bins = histogram
        .map((row) => ({
          bin: Math.max(0, Number(String(row.bin || "").replace(/^b/, "")) || 0),
          count: Number(row.count || 0),
        }))
        .sort((a, b) => a.bin - b.bin);
      for (const item of bins) {
        rank -= item.count;
        if (rank <= 0) {
          const estimate = item.bin === 0 ? 0 : Math.ceil(1.1 ** (item.bin - 1));
          p95DurationMs = Math.min(Number(metric?.max_duration_ms || estimate), estimate);
          break;
        }
      }
    }

    const topTools = this.sql.exec<{ tool: string; calls: number | null }>(
      `SELECT json_each.key AS tool, SUM(CAST(json_each.value AS INTEGER)) AS calls
       FROM ${TABLE}, json_each(tools_json)
       WHERE ${predicate}
       GROUP BY json_each.key
       ORDER BY calls DESC, tool ASC
       LIMIT 10`,
      ...bindings,
    ).toArray().map((row) => ({
      tool: String(row.tool || ""),
      calls: Number(row.calls || 0),
    }));

    const byDay = toMs - fromMs > 36 * HOUR;
    const bucketSize = byDay ? DAY : HOUR;
    const bucketExpr = byDay
      ? `(CAST((CAST(substr(bucket_key, 1, 13) AS INTEGER) + ${BKK}) / ${DAY} AS INTEGER) * ${DAY} - ${BKK})`
      : "CAST(substr(bucket_key, 1, 13) AS INTEGER)";
    const bucketRows = this.sql.exec<{
      start_ms: number;
      calls: number | null;
      errors: number | null;
      operational_errors: number | null;
    }>(
      `SELECT
         ${bucketExpr} AS start_ms,
         SUM(calls) AS calls,
         SUM(errors) AS errors,
         SUM(operational_errors) AS operational_errors
       FROM ${TABLE}
       WHERE ${predicate}
       GROUP BY start_ms
       ORDER BY start_ms`,
      ...bindings,
    ).toArray();

    return {
      metric: {
        calls: Number(metric?.calls || 0),
        errors: Number(metric?.errors || 0),
        operationalErrors: Number(metric?.operational_errors || 0),
        durationMs: Number(metric?.duration_ms || 0),
        requestBytes: Number(metric?.request_bytes || 0),
        responseBytes: Number(metric?.response_bytes || 0),
        minDurationMs: detailedCalls ? Number(metric?.min_duration_ms || 0) : null,
        maxDurationMs: detailedCalls ? Number(metric?.max_duration_ms || 0) : null,
        avgDurationMs: detailedCalls ? Number(metric?.duration_ms || 0) / detailedCalls : null,
        errorRate: detailedCalls ? Number(metric?.errors || 0) / detailedCalls : null,
        operationalErrorRate: detailedCalls ? Number(metric?.operational_errors || 0) / detailedCalls : null,
        p95DurationMs,
        p95Approximate: detailedCalls > 0,
      },
      buckets: bucketRows.map((row) => {
        const start = Number(row.start_ms);
        return {
          from: new Date(start).toISOString(),
          to: new Date(start + bucketSize - 1).toISOString(),
          calls: Number(row.calls || 0),
          errors: Number(row.errors || 0),
          operationalErrors: Number(row.operational_errors || 0),
        };
      }),
      topTools,
      detailSampleSize: detailedCalls,
    };
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
    includeDetails = false,
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

    const details = includeDetails ? this.sqlDetails(fromMs, toMs, filters) : null;
    const detailedSampleSize = Number(details?.detailSampleSize || 0);
    return {
      metric: calls
        ? details
          ? { ...details.metric, calls }
          : { calls }
        : null,
      users,
      agents,
      buckets: details?.buckets ?? [],
      topTools: details?.topTools ?? [],
      detailSampleSize: detailedSampleSize,
      sampleSize: calls,
      bounded: Boolean(includeDetails && calls > 0 && detailedSampleSize < calls),
      coverage: legacy.length ? "legacy+sql" : "sql",
    };
  }
}
