import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export { UsageAggregates } from "./src/usage-aggregates";', resolveDir: process.cwd() },
  bundle: true, format: "esm", platform: "neutral", write: false,
});
const { UsageAggregates } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

test("7d four-hour average comes from recorded hourly counts, retains daily totals, and uses no extra SQL query", async () => {
  const db = new DatabaseSync(":memory:");
  let sqlCount = 0;
  const storage = {
    sql: { exec(query, ...params) {
      sqlCount++;
      const statement = db.prepare(query);
      let rows = [];
      if (statement.columns().length) rows = statement.all(...params);
      else statement.run(...params);
      return { toArray: () => rows };
    } },
    async get(keys) { return Array.isArray(keys) ? new Map() : undefined; },
  };
  try {
    const agg = new UsageAggregates(storage);
    const HOUR = 3600000, DAY = 24 * HOUR;
    // Bangkok midnight on Nov 6, 2026 (previous day 17:00 UTC).
    const from = Date.parse("2026-11-05T17:00:00.000Z");
    const to = from + 7 * DAY - 1;
    const events = [];
    for (let day = 0; day < 7; day++) {
      for (let slot = 0; slot < 6; slot++) {
        const timestamp = new Date(from + day * DAY + (slot * 4 + 1) * HOUR).toISOString();
        events.push({userId:"alice",agentId:"agent-a",timestamp,tool:"terminal.exec",ok:true,durationMs:15});
      }
    }
    // 8 additional calls in the 08:00-12:00 Bangkok window (first day).
    for (let i = 0; i < 8; i++) {
      events.push({userId:"alice",agentId:"agent-a",timestamp:new Date(from+9*HOUR+i*1000).toISOString(),
        tool:"terminal.exec",ok:true,durationMs:15});
    }
    // Another user's activity in the same hour must never leak into Alice's chart.
    for (let i = 0; i < 3; i++) {
      events.push({userId:"bob",agentId:"agent-b",timestamp:new Date(from+9*HOUR+i*1000).toISOString(),
        tool:"terminal.exec",ok:true,durationMs:15});
    }
    await agg.recordBatch(events);
    sqlCount = 0;
    const regular = await agg.window(from,to,{userId:"alice"},true,false);
    const standardQueries = sqlCount;
    sqlCount = 0;
    const profiled = await agg.window(from,to,{userId:"alice"},true,true);
    const profileQueries = sqlCount;
    assert.equal(profileQueries,standardQueries, "four-hour profile must reuse the existing SQL aggregation scan");
    assert.equal(regular.metric.calls, 50);
    assert.equal(profiled.metric.calls, 50);
    assert.deepEqual(profiled.buckets.map(bucket=>bucket.calls),[14,6,6,6,6,6,6]);
    assert.deepEqual(profiled.buckets.map(bucket=>bucket.calls),regular.buckets.map(bucket=>bucket.calls));
    assert.equal(profiled.hourlyAverage.days,7);
    assert.equal(profiled.hourlyAverage.intervalHours,4);
    assert.deepEqual(profiled.hourlyAverage.buckets.map(bucket=>bucket.totalCalls),[7,7,15,7,7,7]);
    assert.equal(profiled.hourlyAverage.buckets.reduce((total,bucket)=>total+bucket.totalCalls,0),50);
    assert.equal(profiled.hourlyAverage.buckets[2].totalCalls/7,15/7);
    assert.equal(regular.hourlyAverage,null, "Overview must not request this per-user profile");
    const bob = await agg.window(from,to,{userId:"bob"},true,true);
    assert.equal(bob.metric.calls,3);
    assert.deepEqual(bob.hourlyAverage.buckets.map(bucket=>bucket.totalCalls),[0,0,3,0,0,0]);
  } finally {
    db.close();
  }
});
