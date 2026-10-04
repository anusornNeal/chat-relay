import type { UsageEvent } from "./usage";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BKK = 7 * HOUR;
const MAX_ROW_BYTES = 96000;
type Store = DurableObjectStorage | DurableObjectTransaction;
export type RichMetric = {
  calls: number;
  errors: number;
  operationalErrors: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  minDurationMs: number;
  maxDurationMs: number;
  histogram: Record<string, number>;
};
type Group = {
  userId: string;
  tool: string;
  agentId: string;
  metric: RichMetric;
};
export type RichBucket = {
  version: 1;
  start: number;
  size: number;
  minTimestamp: number;
  maxTimestamp: number;
  groups: Record<string, Group>;
  overflow: boolean;
  incomplete: boolean;
  rawPruned?: boolean;
};
export const emptyRichMetric = (): RichMetric => ({
  calls: 0,
  errors: 0,
  operationalErrors: 0,
  durationMs: 0,
  requestBytes: 0,
  responseBytes: 0,
  minDurationMs: Number.MAX_SAFE_INTEGER,
  maxDurationMs: 0,
  histogram: {},
});
export function addRichEvent(
  bucket: RichBucket,
  event: UsageEvent,
  operational: boolean,
) {
  const time = Date.parse(event.timestamp);
  bucket.minTimestamp = Math.min(bucket.minTimestamp, time);
  bucket.maxTimestamp = Math.max(bucket.maxTimestamp, time);
  if (bucket.overflow) return;
  const id = JSON.stringify([event.userId, event.tool, event.agentId || ""]);
  const newGroup = !bucket.groups[id];
  const group = (bucket.groups[id] ||= {
    userId: event.userId,
    tool: event.tool,
    agentId: event.agentId || "",
    metric: emptyRichMetric(),
  });
  const metric = group.metric;
  const duration = Math.max(0, Math.round(event.durationMs));
  metric.calls++;
  metric.errors += event.ok ? 0 : 1;
  metric.operationalErrors += operational ? 1 : 0;
  metric.durationMs += duration;
  metric.requestBytes += Math.max(0, Math.round(event.requestBytes));
  metric.responseBytes += Math.max(0, Math.round(event.responseBytes));
  metric.minDurationMs = Math.min(metric.minDurationMs, duration);
  metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
  // 10% exponential bins, sparse and bounded to finite nonnegative durations.
  const bin =
    duration === 0
      ? 0
      : Math.min(400, Math.ceil(Math.log(duration) / Math.log(1.1)) + 1);
  metric.histogram[bin] = (metric.histogram[bin] || 0) + 1;
  if (newGroup) boundRichBucket(bucket);
}
export function boundRichBucket(bucket: RichBucket) {
  if (new TextEncoder().encode(JSON.stringify(bucket)).length > MAX_ROW_BYTES) {
    bucket.overflow = true;
    bucket.groups = {};
  }
  return bucket;
}
export function mergeRichMetric(target: RichMetric, source: RichMetric) {
  for (const key of [
    "calls",
    "errors",
    "operationalErrors",
    "durationMs",
    "requestBytes",
    "responseBytes",
  ] as const)
    target[key] += source[key];
  target.minDurationMs = Math.min(target.minDurationMs, source.minDurationMs);
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
  for (const [bin, count] of Object.entries(source.histogram))
    target.histogram[bin] = (target.histogram[bin] || 0) + count;
}
export function publicRichMetric(metric: RichMetric) {
  if (!metric.calls) return null;
  let rank = Math.ceil(metric.calls * 0.95),
    p95 = 0;
  for (const bin of Object.keys(metric.histogram)
    .map(Number)
    .sort((a, b) => a - b)) {
    rank -= metric.histogram[bin];
    if (rank <= 0) {
      p95 =
        bin === 0
          ? 0
          : Math.min(metric.maxDurationMs, Math.ceil(1.1 ** (bin - 1)));
      break;
    }
  }
  const { histogram, ...counts } = metric;
  return {
    ...counts,
    avgDurationMs: metric.durationMs / metric.calls,
    errorRate: metric.errors / metric.calls,
    operationalErrorRate: metric.operationalErrors / metric.calls,
    p95DurationMs: p95,
    p95Approximate: true,
  };
}
export function bucketSpecs(time: number) {
  return [
    { start: Math.floor(time / MINUTE) * MINUTE, size: MINUTE },
    { start: Math.floor(time / HOUR) * HOUR, size: HOUR },
    { start: Math.floor((time + BKK) / DAY) * DAY - BKK, size: DAY },
  ];
}
function bucketKey(start: number, size: number) {
  const unit = size === DAY ? "day" : size === HOUR ? "hour" : "minute";
  return `agg:v1:${unit}:${new Date(start).toISOString()}`;
}
function emptyBucket(start: number, size: number): RichBucket {
  return {
    version: 1,
    start,
    size,
    minTimestamp: Number.MAX_SAFE_INTEGER,
    maxTimestamp: 0,
    groups: {},
    overflow: false,
    incomplete: false,
  };
}
export class UsageAggregates {
  private cache = new Map<string, { expires: number; bucket: RichBucket }>();
  private revision = 0;
  private rawCache = new Map<
    number,
    { expires: number; events: UsageEvent[] }
  >();
  constructor(
    private storage: DurableObjectStorage,
    private operational: (event: UsageEvent) => boolean,
  ) {}
  invalidate(event?: UsageEvent) {
    this.revision++;
    if (!event) {
      this.cache.clear();
      this.rawCache.clear();
      return;
    }
    for (const spec of bucketSpecs(Date.parse(event.timestamp)))
      this.cache.delete(bucketKey(spec.start, spec.size));
    this.rawCache.delete(Math.floor(Date.parse(event.timestamp) / HOUR) * HOUR);
  }
  private remember(key: string, bucket: RichBucket) {
    if (this.cache.size >= 256)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      expires: Date.now() + 60000,
      bucket: structuredClone(bucket),
    });
  }
  async raw(
    store: Store,
    from: number,
    to: number,
    consume: (event: UsageEvent) => void,
  ) {
    let startAfter: string | undefined;
    for (;;) {
      const page = await store.list<UsageEvent>({
        prefix: "event:",
        ...(startAfter
          ? { startAfter }
          : { start: "event:" + new Date(from).toISOString() }),
        end: "event:" + new Date(to).toISOString() + ":\uffff",
        limit: 1000,
      });
      for (const event of page.values()) {
        const time = Date.parse(event.timestamp);
        if (time >= from && time <= to) consume(event);
      }
      if (page.size < 1000) break;
      startAfter = [...page.keys()].at(-1)!;
    }
  }
  async ensure(store: Store, start: number, size: number): Promise<RichBucket> {
    const key = bucketKey(start, size);
    const found = await store.get<RichBucket>(key);
    if (found) return found;
    const bucket = emptyBucket(start, size);
    await this.raw(store, start, start + size - 1, (event) =>
      addRichEvent(bucket, event, this.operational(event)),
    );
    if (size !== MINUTE) {
      // A UTC legacy day whose total exceeds retained raw proves lost rich history.
      // Inspect entire intersecting UTC days only during migration; never invent missing dimensions.
      for (
        let day = Math.floor(start / DAY) * DAY;
        day <= start + size - 1;
        day += DAY
      ) {
        const coverageKey = `agg:v1:coverage:${day}`;
        let coverage = await store.get<{ incomplete: boolean }>(coverageKey);
        if (!coverage) {
          const legacy = await store.get<{ calls: number }>(
            `day:${new Date(day).toISOString().slice(0, 10)}:total`,
          );
          let retained = 0;
          if (legacy?.calls)
            await this.raw(store, day, day + DAY - 1, () => retained++);
          coverage = { incomplete: retained < (legacy?.calls || 0) };
          await store.put(coverageKey, coverage);
        }
        bucket.incomplete ||= coverage.incomplete;
      }
    }
    boundRichBucket(bucket);
    await store.put(key, bucket);
    return bucket;
  }
  async record(store: Store, event: UsageEvent) {
    for (const spec of bucketSpecs(Date.parse(event.timestamp))) {
      const key = bucketKey(spec.start, spec.size);
      const bucket = await store.get<RichBucket>(key) ?? emptyBucket(spec.start, spec.size);
      addRichEvent(bucket, event, this.operational(event));
      await store.put(key, boundRichBucket(bucket));
    }
  }
  async preserve(store: Store, event: UsageEvent) {
    for (const spec of bucketSpecs(Date.parse(event.timestamp))) {
      const bucket = await this.ensure(store, spec.start, spec.size);
      if (bucket.overflow && spec.size === HOUR) return false;
    }
    // Mark only after all necessary hourly representations are safe to preserve.
    for (const spec of bucketSpecs(Date.parse(event.timestamp))) {
      const bucket = await this.ensure(store, spec.start, spec.size);
      bucket.rawPruned = true;
      await store.put(bucketKey(spec.start, spec.size), bucket);
    }
    return true;
  }
  private async read(start: number, size: number) {
    const key = bucketKey(start, size),
      cached = this.cache.get(key);
    if (cached && cached.expires > Date.now())
      return structuredClone(cached.bucket);
    const revision = this.revision;
    const bucket = await this.storage.transaction((txn) =>
      this.ensure(txn, start, size),
    );
    if (revision === this.revision) this.remember(key, bucket);
    return bucket;
  }
  private async boundary(
    start: number,
    from: number,
    to: number,
    consume: (event: UsageEvent) => void,
  ) {
    const cached = this.rawCache.get(start);
    if (cached && cached.expires > Date.now()) {
      for (const event of cached.events) {
        const time = Date.parse(event.timestamp);
        if (time >= from && time <= to) consume(event);
      }
      return;
    }
    const revision = this.revision,
      events: UsageEvent[] = [];
    let cacheable = true;
    await this.raw(this.storage, start, start + HOUR - 1, (event) => {
      if (events.length < 8000) events.push(event);
      else cacheable = false;
      const time = Date.parse(event.timestamp);
      if (time >= from && time <= to) consume(event);
    });
    if (cacheable && revision === this.revision) {
      if (this.rawCache.size >= 4)
        this.rawCache.delete(this.rawCache.keys().next().value!);
      this.rawCache.set(start, { expires: Date.now() + 10000, events });
    }
  }
  async window(
    from: number,
    to: number,
    filters: {
      userId?: string | null;
      tool?: string | null;
      agentId?: string | null;
    },
    includeBuckets = true,
  ) {
    const total = emptyRichMetric(),
      tools = new Map<string, number>(),
      users = new Map<string, { calls: number; errors: number; operationalErrors: number }>();
    const daily = to - from + 1 > 48 * HOUR,
      chartSize = daily ? DAY : HOUR;
    const origin = from;
    const buckets = Array.from(
      { length: Math.ceil((to - origin + 1) / chartSize) },
      (_, i) => ({
        from: new Date(Math.max(from, origin + i * chartSize)).toISOString(),
        to: new Date(
          Math.min(to, origin + (i + 1) * chartSize - 1),
        ).toISOString(),
        calls: 0,
        errors: 0,
        operationalErrors: 0,
      }),
    );
    let incomplete = false,
      overflow = false;
    const matches = (group: {
      userId: string;
      tool: string;
      agentId?: string;
    }) =>
      (!filters.userId || filters.userId === group.userId) &&
      (!filters.tool || filters.tool === group.tool) &&
      (!filters.agentId || filters.agentId === group.agentId);
    const consume = (metric: RichMetric, tool: string, userId: string, time: number) => {
      mergeRichMetric(total, metric);
      tools.set(tool, (tools.get(tool) || 0) + metric.calls);
      const user = users.get(userId) || { calls: 0, errors: 0, operationalErrors: 0 };
      user.calls += metric.calls;
      user.errors += metric.errors;
      user.operationalErrors += metric.operationalErrors;
      users.set(userId, user);
      if (!includeBuckets) return;
      const chart = buckets[Math.floor((time - origin) / chartSize)];
      chart.calls += metric.calls;
      chart.errors += metric.errors;
      chart.operationalErrors += metric.operationalErrors;
    };
    for (let cursor = from; cursor <= to; ) {
      const dayStart = Math.floor((cursor + BKK) / DAY) * DAY - BKK;
      const chartEnd = includeBuckets
        ? Math.min(
            to,
            origin +
              (Math.floor((cursor - origin) / chartSize) + 1) * chartSize -
              1,
          )
        : to;
      let size =
        daily && cursor === dayStart && cursor + DAY - 1 <= chartEnd
          ? DAY
          : HOUR;
      let start = size === DAY ? dayStart : Math.floor(cursor / HOUR) * HOUR;
      let bucket = await this.read(start, size);
      overflow ||= bucket.overflow;
      if (size === DAY && bucket.overflow) {
        size = HOUR;
        start = Math.floor(cursor / HOUR) * HOUR;
        bucket = await this.read(start, size);
      }
      let end = Math.min(chartEnd, start + size - 1);
      if (
        size === HOUR &&
        !bucket.overflow &&
        (bucket.minTimestamp < cursor || bucket.maxTimestamp > end)
      ) {
        size = MINUTE;
        start = Math.floor(cursor / MINUTE) * MINUTE;
        bucket = await this.read(start, size);
        end = Math.min(chartEnd, start + size - 1);
      }
      incomplete ||= bucket.incomplete;
      overflow ||= bucket.overflow;
      if (
        bucket.overflow ||
        bucket.minTimestamp < cursor ||
        bucket.maxTimestamp > end
      ) {
        incomplete ||= bucket.rawPruned === true;
        const consumeRaw = (event: UsageEvent) => {
          if (!matches(event)) return;
          const single = emptyBucket(start, size);
          addRichEvent(single, event, this.operational(event));
          consume(
            Object.values(single.groups)[0].metric,
            event.tool,
            event.userId,
            Date.parse(event.timestamp),
          );
        };
        if (size === HOUR) await this.boundary(start, cursor, end, consumeRaw);
        else await this.raw(this.storage, cursor, end, consumeRaw);
      } else
        for (const group of Object.values(bucket.groups))
          if (matches(group)) consume(group.metric, group.tool, group.userId, cursor);
      cursor = end + 1;
    }
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      metric: publicRichMetric(total),
      buckets: includeBuckets ? buckets : [],
      topTools: [...tools]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([tool, calls]) => ({ tool, calls })),
      users: [...users]
        .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
        .slice(0, 100)
        .map(([userId, metric]) => ({ userId, ...metric })),
      sampleSize: total.calls,
      bounded: incomplete,
      coverage: incomplete ? "retained-history" : "complete",
      aggregateOverflow: overflow,
      p95Approximate: true,
    };
  }
}
