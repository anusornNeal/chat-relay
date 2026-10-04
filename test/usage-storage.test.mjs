import assert from "node:assert/strict";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const bundled = await build({
  stdin: {
    contents:
      'export { Usage } from "./src/usage"; export { Registry } from "./src/registry"; export { DashboardHub } from "./src/dashboard-hub"; export { handleAdmin } from "./src/admin"; export { Relay } from "./src/index";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  plugins: [
    {
      name: "host",
      setup(b) {
        b.onResolve({filter:/^\.\/worker-app$/},()=>({path:"app",namespace:"app"}));
        b.onLoad({filter:/.*/,namespace:"app"},()=>({contents:"export default {}; export async function publishDashboard() {}"}));
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "host",
          namespace: "host",
        }));
        b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
          contents:
            "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
        }));
      },
    },
  ],
});
const { Usage, Registry, DashboardHub, handleAdmin, Relay } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
function fixture(Class = Usage) {
  const records = new Map();
  const stats = { gets: 0, rows: 0, lists: [], puts: 0 };
  let queue = Promise.resolve();
  const storage = {
    async get(key) {
      stats.gets++;
      if (Array.isArray(key))
        return new Map(
          key
            .filter((k) => records.has(k))
            .map((k) => [k, structuredClone(records.get(k))]),
        );
      return structuredClone(records.get(key));
    },
    async put(key, value) {
      stats.puts++;
      for (const [k, v] of typeof key === "object"
        ? Object.entries(key)
        : [[key, value]])
        records.set(k, structuredClone(v));
    },
    async delete(keys) {
      assert.ok(
        !Array.isArray(keys) || keys.length <= 128,
        "Cloudflare delete batch <=128",
      );
      for (const k of Array.isArray(keys) ? keys : [keys]) records.delete(k);
    },
    async list({
      prefix = "",
      limit = Infinity,
      startAfter,
      start,
      end,
      reverse = false,
    } = {}) {
      const items = [...records]
        .filter(
          ([k]) =>
            k.startsWith(prefix) &&
            (!startAfter || k > startAfter) &&
            (!start || k >= start) &&
            (!end || k < end),
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (reverse) items.reverse();
      const page = items.slice(0, limit);
      stats.rows += page.length;
      stats.lists.push({ prefix, rows: page.length });
      return new Map(page.map(([k, v]) => [k, structuredClone(v)]));
    },
    transaction(callback) {
      const execute = async () => {
        const snapshot = structuredClone(records);
        try {
          return await callback(storage);
        } catch (error) {
          records.clear();
          for (const [k, v] of snapshot) records.set(k, v);
          throw error;
        }
      };
      const result = queue.then(execute);
      queue = result.catch(() => {});
      return result;
    },
  };
  const env = {
    DASHBOARD: {
      idFromName: (x) => x,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  };
  let instance = new Class({ storage }, env);
  const call = async (path, body) => {
    const response = await instance.fetch(
      new Request("https://internal" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const data = await response.json();
    return { status: response.status, ...data };
  };
  return {
    records,
    storage,
    stats,
    call,
    reset() {
      stats.gets = stats.rows = stats.puts = 0;
      stats.lists = [];
    },
    evict() {
      instance = new Class({ storage }, env);
    },
  };
}
const event = (timestamp, overrides = {}) => ({
  userId: "alice",
  tool: "terminal",
  agentId: "laptop",
  timestamp,
  durationMs: 100,
  ok: true,
  requestBytes: 2,
  responseBytes: 3,
  ...overrides,
});
const window = (from, to, filter = {}) =>
  "/window?" + new URLSearchParams({ from, to, ...filter });
{
  const f = fixture();
  const from = "2026-09-01T17:00:00.000Z",
    to = "2026-10-01T16:59:59.999Z";
  // >20k legacy records are migrated without safety truncation; all filter intersections survive.
  for (let i = 0; i < 21001; i++)
    f.records.set(
      `event:2026-09-02T00:00:00.000Z:${String(i).padStart(6, "0")}`,
      event("2026-09-02T00:00:00.000Z", {
        userId: i % 2 ? "alice" : "bob",
        ok: i % 3 !== 0,
        errorCode: "agent_offline",
      }),
    );
  f.records.set("day:2026-09-02:total", { calls: 21001 });
  const migrated = await f.call(window(from, to));
  assert.equal(migrated.metric.calls, 21001);
  assert.equal(migrated.metric.operationalErrors, 7001);
  assert.equal(migrated.bounded, false);
  f.evict();
  f.reset();
  const cold = await f.call(window(from, to));
  assert.equal(cold.metric.calls, 21001);
  assert.equal(f.stats.rows, 0);
  assert.ok(f.stats.gets <= 31, JSON.stringify(f.stats));
  f.reset();
  const filtered = await f.call(
    window(from, to, { userId: "alice", tool: "terminal", agentId: "laptop" }),
  );
  assert.equal(filtered.metric.calls, 10500);
  assert.equal(f.stats.gets, 0);
  assert.equal(f.stats.rows, 0);
  assert.equal(
    (await f.call(window(from, to, { userId: "alice", agentId: "other" })))
      .metric,
    null,
  );
  const writes = await f.call(
    "/record",
    event("2026-09-02T07:00:00+07:00", { userId: "alice", durationMs: 120 }),
  );
  assert.equal(writes.status, 200);
  f.reset();
  const late = await f.call(window(from, to));
  assert.equal(late.metric.calls, 21002);
  assert.equal(f.stats.gets, 1);
  assert.equal(f.stats.rows, 0);
  assert.equal((await f.call("/record", event("garbage"))).status, 400);
  const before = late.metric.calls;
  await f.call("/cleanup", { retentionDays: 0, limit: 1000 });
  f.evict();
  assert.equal((await f.call(window(from, to))).metric.calls, before);
  console.log(
    "PASS 21k legacy exact migration, 30 daily cold rows, hot zero reads, intersections, late invalidation, canonical timestamp, cleanup",
  );
}
{
  const f = fixture();
  await f.call("/record", event("2026-10-02T16:59:59.000Z"));
  await f.call("/record", event("2026-10-02T17:00:00.000Z"));
  assert.equal(
    (await f.call(window("2026-10-02T17:00:00Z", "2026-10-03T16:59:59.999Z")))
      .metric.calls,
    1,
  );
  await f.call("/record", event("2026-10-03T01:00:00.000Z"));
  await f.call("/record", event("2026-10-03T01:30:00.000Z"));
  await f.call("/record", event("2026-10-03T01:59:59.999Z"));
  const path = window("2026-10-03T01:10:00.000Z", "2026-10-03T01:30:00.000Z");
  assert.equal((await f.call(path)).metric.calls, 1);
  f.reset();
  assert.equal((await f.call(path)).metric.calls, 1);
  assert.equal(f.stats.rows, 0);
  assert.equal(
    (
      await f.call(
        window("2026-10-03T01:59:59.999Z", "2026-10-03T01:59:59.999Z"),
      )
    ).metric.calls,
    1,
  );
  const now = new Date().toISOString();
  await f.call("/activity/start", {
    userId: "alice",
    tool: "terminal",
    toolCallId: "active1",
    startedAt: now,
  });
  f.evict();
  const summary = await f.call("/summary");
  assert.equal(summary.activeCalls, 1);
  f.reset();
  assert.equal((await f.call("/summary")).activeCalls, 1);
  assert.equal(f.stats.rows, 0);
  await f.call("/record", event(now, { toolCallId: "active1" }));
  assert.equal((await f.call("/summary")).activeCalls, 0);
  // Atomic handlers remain correct under simultaneous record calls.
  await Promise.all(
    Array.from({ length: 10 }, () =>
      f.call("/record", event("2026-10-03T02:00:00Z")),
    ),
  );
  assert.equal(
    (await f.call(window("2026-10-03T02:00:00Z", "2026-10-03T02:59:59.999Z")))
      .metric.calls,
    10,
  );
  console.log(
    "PASS BKK midnight, inclusive partial boundaries and hot cache, active eviction, concurrent records",
  );
}
{
  const f = fixture();
  f.records.set("day:2026-09-01:total", { calls: 10 });
  f.records.set(
    "event:2026-09-01T20:00:00.000Z:x",
    event("2026-09-01T20:00:00.000Z"),
  );
  const path = window("2026-09-01T17:00:00.000Z", "2026-09-04T16:59:59.999Z");
  const data = await f.call(path);
  assert.equal(data.metric.calls, 1);
  assert.equal(data.bounded, true);
  assert.equal(data.coverage, "retained-history");
  f.reset();
  await f.call(path);
  assert.equal(f.stats.rows, 0);
  assert.equal(f.stats.gets, 0);
  console.log("PASS legacy history loss disclosure and persisted empty rows");
}
{
  const f = fixture(Registry);
  const future = new Date(Date.now() + 3600000).toISOString();
  f.records.set("oauth-client:c", {
    clientId: "c",
    redirectUris: ["https://client/callback"],
    clientName: "client",
  });
  const token = {
    tokenHash: "t",
    userId: "u",
    clientId: "c",
    resource: "https://relay/mcp",
    scope: ["mcp"],
    createdAt: new Date().toISOString(),
    expiresAt: future,
  };
  f.records.set("oauth-refresh:t", token);
  const query = {
    userId: "u",
    clientId: "c",
    resource: "https://relay/mcp",
    scope: ["mcp"],
  };
  assert.equal(
    (await f.call("/oauth/client/authorized", query)).authorized,
    true,
  );
  f.reset();
  assert.equal(
    (await f.call("/oauth/client/authorized", query)).authorized,
    true,
  );
  assert.equal(f.stats.lists.length, 0);
  assert.equal(
    (
      await f.call("/oauth/client/authorized", {
        ...query,
        scope: ["offline_access"],
      })
    ).authorized,
    false,
  );
  assert.equal(
    (await f.call("/oauth/client/authorized", { ...query, resource: "wrong" }))
      .authorized,
    false,
  );
  token.expiresAt = "2020-01-01T00:00:00Z";
  f.records.set("oauth-refresh:t", token);
  assert.equal(
    (await f.call("/oauth/client/authorized", query)).authorized,
    false,
  );
  f.records.delete("oauth-refresh:t");
  assert.equal(
    (await f.call("/oauth/client/authorized", query)).authorized,
    false,
  );
  f.evict();
  f.reset();
  await f.call("/oauth/client/authorized", query);
  assert.equal(f.stats.lists.length, 0);
  f.records.set("at:agent-token", "a");
  f.records.set("agent:a", { id: "a", name: "Agent", enabled: true });
  f.reset();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.call("/auth/agent", { agentId: "a", tokenHash: "agent-token" }))
        .status,
      200,
    );
  assert.equal(f.stats.puts, 1);
  f.records.set("agent:a", { ...f.records.get("agent:a"), enabled: false });
  assert.equal(
    (await f.call("/auth/agent", { agentId: "a", tokenHash: "agent-token" }))
      .status,
    401,
  );
  f.records.delete("at:agent-token");
  assert.equal(
    (await f.call("/auth/agent", { agentId: "a", tokenHash: "agent-token" }))
      .status,
    401,
  );
  console.log(
    "PASS OAuth direct index, scope/resource/expiry/revocation/eviction and agent throttle without auth cache",
  );
}
{
  const f = fixture();
  await f.call("/record", event("2026-09-02T01:00:00Z"));
  await f.call("/record", event("2026-09-02T01:30:00Z"));
  await f.call("/record", event("2026-09-02T01:59:00Z"));
  await f.call("/cleanup", { retentionDays: 0, limit: 1000 });
  f.evict();
  const partial = await f.call(
    window("2026-09-02T01:10:00Z", "2026-09-02T01:40:00Z"),
  );
  assert.equal(partial.bounded, true);
  assert.equal(partial.coverage, "retained-history");
  const full = await f.call(
    window("2026-09-02T01:00:00Z", "2026-09-02T01:59:59.999Z"),
  );
  assert.equal(full.metric.calls, 3);
  assert.equal(full.bounded, false);
  console.log(
    "PASS raw-pruned partial-hour disclosure with exact complete-hour counts",
  );
}
{
  const f = fixture();
  // Large dimension cardinality over one day exceeds a single row, but hours remain safe.
  for (let hour = 0; hour < 24; hour++)
    for (let i = 0; i < 30; i++) {
      const timestamp = new Date(
        Date.parse("2026-09-01T17:00:00Z") + hour * 3600000 + 1000,
      ).toISOString();
      f.records.set(
        `event:${timestamp}:${i}`,
        event(timestamp, { userId: `user-${hour}-${i}` }),
      );
    }
  const path = window("2026-09-01T17:00:00Z", "2026-09-04T16:59:59.999Z");
  const result = await f.call(path);
  assert.equal(result.metric.calls, 720);
  assert.equal(result.aggregateOverflow, true);
  assert.equal(result.bounded, false);
  const cleanup = await f.call("/cleanup", { retentionDays: 0, limit: 1000 });
  assert.equal(cleanup.deleted, 720);
  f.evict();
  assert.equal((await f.call(path)).metric.calls, 720);
  console.log(
    "PASS bounded daily overflow decomposes to exact hourly rows and survives cleanup",
  );
}
{
  const f = fixture(Registry);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  f.records.set("user:u", { id: "u", name: "User", enabled: true });
  f.records.set("oauth-client:c", {
    clientId: "c",
    redirectUris: ["https://client/callback"],
    clientName: "client",
  });
  const request = {
    clientId: "c",
    resource: "https://relay/mcp",
    redirectUri: "https://client/callback",
    codeChallenge: "challenge",
  };
  for (const [hash, scope] of [
    ["one", ["mcp"]],
    ["two", ["mcp", "offline_access"]],
  ]) {
    f.records.set("oauth-code:" + hash, {
      ...request,
      codeHash: hash,
      userId: "u",
      scope,
      expiresAt,
    });
  }
  const issued = await Promise.all(
    ["one", "two"].map((codeHash) =>
      f.call("/oauth/code/exchange", { ...request, codeHash }),
    ),
  );
  assert.equal(issued[0].status, 200);
  assert.equal(issued[1].status, 200);
  // Directly seeded code exchange has no consent, so this exercises the generated token index.
  assert.equal(
    (
      await f.call("/oauth/client/authorized", {
        userId: "u",
        clientId: "c",
        resource: request.resource,
        scope: ["offline_access"],
      })
    ).authorized,
    true,
  );
  const refreshHash = [...f.records.keys()]
    .find((key) => key.startsWith("oauth-refresh:"))
    .slice("oauth-refresh:".length);
  assert.equal(
    (
      await f.call("/oauth/refresh/exchange", {
        refreshTokenHash: refreshHash,
        clientId: "c",
        resource: request.resource,
      })
    ).status,
    200,
  );
  f.reset();
  assert.equal(
    (
      await f.call("/oauth/client/authorized", {
        userId: "u",
        clientId: "c",
        resource: request.resource,
        scope: ["offline_access"],
      })
    ).authorized,
    true,
  );
  assert.equal(f.stats.lists.length, 0);
  const indexes = [...f.records].filter(([key]) =>
    key.startsWith("oauth-authorized:["),
  );
  assert.equal(Object.keys(indexes[0][1]).length, 3);
  console.log(
    "PASS concurrent OAuth issuance retains scope variants and refresh updates direct index",
  );
}

{
  const f = fixture();
  for (let i = 0; i < 150; i++)
    f.records.set("active:" + i, {
      userId: "u",
      tool: "terminal",
      toolCallId: String(i),
      startedAt: "2020-01-01T00:00:00Z",
    });
  assert.equal((await f.call("/summary")).activeCalls, 0);
  assert.equal(
    [...f.records.keys()].filter((key) => key.startsWith("active:")).length,
    0,
  );
  console.log(
    "PASS abandoned active-call pruning uses host-safe delete batches",
  );
}

{
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    await f.call(
      "/record",
      event(i < 50 ? "2026-09-02T00:00:00Z" : "2026-09-03T00:00:00Z", {
        userId: i < 95 ? "alice" : "bob",
        durationMs: i < 95 ? 100 : 200,
        ok: i < 95,
        errorCode: i < 95 ? undefined : "agent_timeout",
      }),
    );
  }
  const from = "2026-09-01T17:00:00Z",
    to = "2026-09-04T16:59:59.999Z";
  const data = await f.call(window(from, to));
  const metric = data.metric;
  assert.equal(metric.calls, 100);
  assert.equal(metric.errors, 5);
  assert.equal(metric.operationalErrors, 5);
  assert.equal(metric.durationMs, 10500);
  assert.equal(metric.avgDurationMs, 105);
  assert.equal(metric.minDurationMs, 100);
  assert.equal(metric.maxDurationMs, 200);
  assert.equal(metric.requestBytes, 200);
  assert.equal(metric.responseBytes, 300);
  assert.equal(metric.p95Approximate, true);
  assert.ok(metric.p95DurationMs >= 100 && metric.p95DurationMs <= 110);
  const alice = await f.call(
    window(from, to, { userId: "alice", tool: "terminal", agentId: "laptop" }),
  );
  assert.equal(alice.metric.calls, 95);
  assert.equal(alice.metric.errors, 0);
  assert.equal(alice.metric.avgDurationMs, 100);
  assert.equal(alice.metric.p95DurationMs, 100);
  assert.equal(alice.metric.requestBytes, 190);
  console.log(
    "PASS merged daily exact latency/count/byte metrics and bounded approximate p95 across filter intersections",
  );
}
{
  const f = fixture();
  const originalNow = Date.now;
  let now = Date.parse("2026-10-03T12:34:56.789Z");
  Date.now = () => now;
  try {
    await f.call("/summary?hours=720");
    f.evict();
    f.reset();
    const cold = await f.call("/summary?hours=720");
    assert.equal(cold.bounded, false);
    assert.ok(f.stats.gets <= 78, JSON.stringify(f.stats));
    assert.equal(f.stats.rows, 0);
    f.reset();
    now += 1000;
    await f.call("/summary?hours=720");
    assert.equal(f.stats.gets, 0);
    assert.equal(f.stats.rows, 0);
    f.reset();
    now += 61000;
    await f.call("/summary?hours=720");
    assert.ok(f.stats.gets > 0 && f.stats.gets <= 78);
    assert.equal(f.stats.rows, 0);
    console.log(
      "PASS rolling 30-day summary daily-middle/hour-boundary read bound, moving-to hot cache and TTL expiry",
    );
  } finally {
    Date.now = originalNow;
  }
}

{
  const f = fixture();
  const timestamp = "2026-10-04T12:00:00.000Z";
  for (let i = 0; i < 1201; i++) f.records.set(`event:${timestamp}:${String(i).padStart(6,"0")}`,
    event(timestamp, { toolCallId: `tc_${i}`, ok: i !== 0, startedAt: "2026-10-03T00:00:00.000Z" }));
  const ids = new Set();
  let cursor = "";
  do {
    f.reset();
    const page = await f.call("/activity/query?state=history&limit=100&from=2026-10-02T00:00:00Z&to=2026-10-03T01:00:00Z&cursor="+cursor);
    assert.equal(page.status,200);
    assert.ok(f.stats.rows <= 500);
    for (const row of page.items) { assert.ok(!ids.has(row.toolCallId)); ids.add(row.toolCallId); }
    cursor = page.nextCursor || "";
  } while (cursor);
  assert.equal(ids.size,1201,"same completion timestamps and startedAt filters do not skip rows");
  cursor = ""; let empty = 0; let failures = [];
  do {
    f.reset();
    const page = await f.call("/errors/query?cursor="+cursor);
    assert.ok(f.stats.rows <= 500);
    failures.push(...page.items);
    if (!page.items.length && page.nextCursor) empty++;
    cursor = page.nextCursor || "";
  } while (cursor);
  assert.equal(empty,2); assert.equal(failures.length,1); assert.equal(failures[0].toolCallId,"tc_0");
  const legacy = Buffer.from(JSON.stringify({ timestamp, id:"tc_5" })).toString("base64url");
  cursor = legacy; const legacyIds = new Set();
  do {
    f.reset();
    const page = await f.call("/activity/query?state=history&cursor="+cursor);
    assert.ok(f.stats.rows <=500);
    for (const row of page.items) { assert.ok(row.toolCallId.localeCompare("tc_5")<0); assert.ok(!legacyIds.has(row.toolCallId)); legacyIds.add(row.toolCallId); }
    cursor = page.nextCursor || "";
  } while(cursor);
  assert.equal(legacyIds.size,[...f.records.values()].filter(row => row.toolCallId.localeCompare("tc_5")<0).length);
  const invalid = Buffer.from(JSON.stringify({v:2,before:"event:2026-99-99T12:00:00.000Z:x"})).toString("base64url");
  assert.equal((await f.call("/errors/query?cursor="+invalid)).status,400);
  assert.equal((await f.call("/errors/query?tool=missing")).items.length,0);
  assert.equal((await f.call("/errors/query?operational=true")).items.length,0);
  console.log("PASS bounded raw paging, sparse empty continuation, same timestamp ties, startedAt filters and legacy cursor");
}
{
  const f=fixture(); const timestamp=new Date().toISOString();
  for(let i=0;i<501;i++) f.records.set(`event:${timestamp}:${String(i).padStart(6,"0")}`,event(timestamp,{toolCallId:`history_${i}`}));
  f.records.set("active:active_a",{userId:"alice",tool:"terminal",agentId:"laptop",toolCallId:"active_a",startedAt:timestamp});
  f.records.set("active:active_b",{userId:"alice",tool:"terminal",agentId:"laptop",toolCallId:"active_b",startedAt:new Date(Date.now()-1000).toISOString()});
  let cursor=""; const ids=new Set();
  do { const page=await f.call("/activity/query?limit=1&cursor="+cursor);
    for(const row of page.items) { assert.ok(!ids.has(row.toolCallId));ids.add(row.toolCallId); }
    cursor=page.nextCursor||"";
  }while(cursor);
  assert.equal(ids.size,503);
  console.log("PASS active/history merging including ties and active rows beyond history scan frontier");
}
{
  let reads=0; let sockets=[];
  const hub=new DashboardHub({ getWebSockets:()=>sockets },{REGISTRY:{ idFromName:x=>x,get:()=>({fetch:async()=>{reads++; return Response.json({agents:[{id:"a",name:"Agent"}]});}})}});
  const publish=()=>hub.fetch(new Request("https://internal/publish",{method:"POST",body:JSON.stringify({topics:["calls"],event:{type:"tool_started",userId:"alice",tool:"terminal",toolCallId:"t",agentId:"a",startedAt:new Date().toISOString()}})}));
  await publish();assert.equal(reads,0);
  sockets=[{deserializeAttachment:()=>({userId:"bob",admin:false}),send:()=>assert.fail("wrong audience")}];
  await publish();assert.equal(reads,0);
  const messages=[];sockets.push({deserializeAttachment:()=>({userId:"owner",admin:true}),send:x=>messages.push(JSON.parse(x))});
  await publish();assert.equal(reads,1);assert.equal(messages[0].agentName,"Agent");
  await publish();assert.equal(reads,1);
  console.log("PASS hub registry reads only for eligible subscribers with name cache");
}
{
  const calls=[];
  const state={agents:[{id:"offline",name:"Offline",enabled:true},{id:"online",name:"Online",enabled:true}],users:[],grants:[]};
  const env={ADMIN_TOKEN:"test",REGISTRY:{idFromName:x=>x,get:()=>({fetch:async request=>{const path=new URL(typeof request==="string"?request:request.url).pathname;calls.push("registry"+path);return Response.json(state);}})},
    RELAY:{idFromName:x=>x,get:id=>({fetch:async request=>{const path=new URL(typeof request==="string"?request:request.url).pathname;calls.push(id+path);return Response.json(path==="/status"?{online:id==="online"}:{payload:{ok:true,sessions:[],batches:[]}});}})},
    USAGE:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({metric:{},items:[]})})}};
  const call=path=>handleAdmin(new Request("https://internal"+path,{headers:{authorization:"Bearer test"}}),env);
  assert.equal((await call("/admin/api/overview")).status,200);
  assert.equal(calls.filter(x=>x==="registry/state").length,1);
  assert.ok(!calls.includes("offline/relay"));assert.ok(calls.includes("online/relay"));
  calls.length=0;assert.equal((await call("/admin/api/tool-calls")).status,200);
  assert.equal(calls.filter(x=>x==="registry/state").length,1);
  console.log("PASS admin overview and tool-call state reuse and offline probe suppression");
}

{
  const records=new Map();let writes=0;let fail=false;let pending=[];
  let attachment={connectionGeneration:1};const socket={deserializeAttachment:()=>structuredClone(attachment),serializeAttachment:x=>{attachment=structuredClone(x);},send:()=>{}};
  const ctx={getWebSockets:()=>[socket],waitUntil:p=>pending.push(p),storage:{get:async key=>structuredClone(records.get(key)),put:async(key,value)=>{if(fail)throw Error("write failed");writes++;records.set(key,structuredClone(value));}}};
  let relay=new Relay(ctx,{});
  const health={processStartedAt:"2026-10-04T00:00:00.000Z",reconnectCount:0};
  const beat=async(extra={})=>{relay.webSocketMessage(socket,JSON.stringify({control:"agent_heartbeat",processId:42,heartbeatMs:15000,health:{...health,...extra}}));await Promise.all(pending);pending=[];};
  await beat();assert.equal(writes,1);
  await beat({queues:{terminal:{active:1,queued:1}}});assert.equal(writes,1);
  relay=new Relay(ctx,{});await beat();assert.equal(writes,1,"hibernation retains persisted signature");
  await beat({reconnectCount:1,lastDisconnectedAt:"2026-10-04T01:00:00.000Z",lastCloseCode:1006});assert.equal(writes,2);
  fail=true;await beat({processStartedAt:"2026-10-04T02:00:00.000Z"});assert.equal(writes,2);
  fail=false;await beat({processStartedAt:"2026-10-04T02:00:00.000Z"});assert.equal(writes,3,"failed writes retry next heartbeat");
  assert.equal(records.get("agent:diagnostics").processEpochs.length,2);
  console.log("PASS real Relay heartbeat write suppression, diagnostic changes, eviction and failed-write retry");
}
{
  const f=fixture();const now=new Date();const startedAt=now.toISOString().replace(/\.\d{3}Z$/,"Z");
  const callIds = ["noncanonical_!'()*_0", "noncanonical_!'()*_1", "日".repeat(96), "日".repeat(95) + "本"];
  for (const [i, toolCallId] of callIds.entries()) f.records.set("active:"+i,{userId:"alice",tool:"terminal",toolCallId,startedAt});
  let cursor="";const ids=[];
  do{const page=await f.call("/activity/query?state=active&limit=1&cursor="+cursor);assert.equal(page.status,200);ids.push(...page.items.map(x=>x.toolCallId));cursor=page.nextCursor||"";}while(cursor);
  assert.equal(new Set(ids).size,4);
  assert.equal((await f.call("/errors/query?from=2026-10-05&to=2026-10-04")).status,400);
  console.log("PASS active-only noncanonical timestamp and punctuation ID continuation and reversed window validation");
}
