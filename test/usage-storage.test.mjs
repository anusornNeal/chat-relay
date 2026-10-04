import assert from "node:assert/strict";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const bundled = await build({
  stdin: {
    contents: 'export { Usage } from "./src/usage"; export { Registry } from "./src/registry";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  plugins: [{
    name: "host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      }));
    },
  }],
});

const { Usage, Registry } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64")
);

function fixture(Class = Usage) {
  const records = new Map();
  const stats = { gets: 0, puts: 0, lists: 0, rows: 0 };
  let queue = Promise.resolve();
  const storage = {
    async get(key) {
      stats.gets++;
      if (Array.isArray(key)) {
        return new Map(key.filter((item) => records.has(item)).map((item) => [item, structuredClone(records.get(item))]));
      }
      return structuredClone(records.get(key));
    },
    async put(key, value) {
      stats.puts++;
      if (typeof key === "object") {
        for (const [entryKey, entryValue] of Object.entries(key)) records.set(entryKey, structuredClone(entryValue));
      } else {
        records.set(key, structuredClone(value));
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key);
    },
    async list({ prefix = "", start, end, limit = Infinity } = {}) {
      stats.lists++;
      const items = [...records.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!start || key >= start) && (!end || key < end))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit);
      stats.rows += items.length;
      return new Map(items.map(([key, value]) => [key, structuredClone(value)]));
    },
    transaction(callback) {
      const run = async () => callback(storage);
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
  };
  const env = {
    DASHBOARD: {
      idFromName: (value) => value,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  };
  const instance = new Class({ storage }, env);
  const call = async (path, body) => {
    const response = await instance.fetch(new Request("https://internal" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const data = await response.json();
    return { status: response.status, ...data };
  };
  return {
    records,
    stats,
    storage,
    call,
    reset() {
      stats.gets = 0;
      stats.puts = 0;
      stats.lists = 0;
      stats.rows = 0;
    },
  };
}

const event = (timestamp, overrides = {}) => ({
  userId: "alice",
  agentId: "agent-a",
  timestamp,
  ...overrides,
});

{
  const f = fixture();
  const disabled = await f.call("/quota/check", {
    userId: "alice",
    defaultPolicy: { rateLimit: 0, rateWindowSeconds: 60, dailyCallQuota: 0 },
  });
  assert.equal(disabled.allowed, true);
  assert.equal(f.stats.puts, 0);
  console.log("PASS disabled quota is read-only");
}

{
  const f = fixture();
  f.reset();
  assert.equal((await f.call("/record", event("2026-10-04T08:01:00Z"))).status, 200);
  assert.equal(f.stats.puts, 1, "one tool call must produce one usage row write in fallback storage");
  assert.equal([...f.records.keys()].filter((key) => key.startsWith("usage:v2:")).length, 1);

  f.reset();
  await f.call("/record", event("2026-10-04T08:20:00Z"));
  assert.equal(f.stats.puts, 1);
  assert.equal([...f.records.keys()].filter((key) => key.startsWith("usage:v2:")).length, 1, "same hour/user/agent must update one counter row");

  await f.call("/record", event("2026-10-04T09:00:00Z", { agentId: "agent-b" }));
  await f.call("/record", event("2026-10-04T09:05:00Z", { userId: "bob", agentId: "agent-a" }));
  const all = await f.call("/window?from=2026-10-04T08:00:00Z&to=2026-10-04T10:00:00Z");
  assert.equal(all.metric.calls, 4);
  assert.equal(all.agents.find((row) => row.userId === "alice" && row.agentId === "agent-a")?.calls, 2);
  assert.equal(all.agents.find((row) => row.userId === "alice" && row.agentId === "agent-b")?.calls, 1);
  assert.equal(all.agents.find((row) => row.userId === "bob" && row.agentId === "agent-a")?.calls, 1);

  const alice = await f.call("/window?from=2026-10-04T08:00:00Z&to=2026-10-04T10:00:00Z&userId=alice");
  assert.equal(alice.metric.calls, 3);
  assert.ok(alice.agents.every((row) => row.userId === "alice"));

  const agentA = await f.call("/window?from=2026-10-04T08:00:00Z&to=2026-10-04T10:00:00Z&agentId=agent-a");
  assert.equal(agentA.metric.calls, 3);
  assert.ok(agentA.agents.every((row) => row.agentId === "agent-a"));

  const hourNine = await f.call("/window?from=2026-10-04T09:00:00Z&to=2026-10-04T09:59:59Z");
  assert.equal(hourNine.metric.calls, 2);
  console.log("PASS one-row counters and server-side time/user/agent filtering");
}

{
  const f = fixture();
  f.reset();
  await f.call("/record", event("2026-10-04T08:00:00Z", { ok: false, errorCode: "synthetic" }));
  assert.equal(f.stats.puts, 1);
  assert.equal([...f.records.keys()].some((key) => key.startsWith("event:")), false);
  console.log("PASS failed calls do not create raw history rows");
}

{
  const f = fixture();
  const dayStart = Date.parse("2026-10-03T17:00:00.000Z");
  f.records.set("agg:v1:day:" + new Date(dayStart).toISOString(), {
    groups: {
      legacy: { userId: "alice", agentId: "agent-a", metric: { calls: 7 } },
    },
    overflow: false,
  });
  await f.call("/record", event("2026-10-04T08:00:00Z"));
  f.reset();
  const merged = await f.call("/window?from=2026-10-03T17:00:00Z&to=2026-10-04T16:59:59Z&userId=alice&agentId=agent-a");
  assert.equal(merged.metric.calls, 8);
  assert.ok(f.stats.gets <= 1, JSON.stringify(f.stats));
  assert.equal(f.stats.puts, 0, "queries must not backfill or migrate storage");
  console.log("PASS legacy day compatibility uses one batched read and zero query writes");
}

{
  const f = fixture();
  for (const path of ["/summary", "/query", "/cleanup", "/errors/query", "/activity/query"]) {
    assert.equal((await f.call(path)).status, 404);
  }
  console.log("PASS obsolete multi-query/history endpoints removed");
}

{
  const f = fixture(Registry);
  f.records.set("user:u", { id: "u", name: "User", enabled: true, admin: false, createdAt: "2026-10-01T00:00:00Z" });
  f.records.set("agent:a", { id: "a", name: "Agent", tokenHash: "hash", ownerUserId: "u", enabled: true, createdAt: "2026-10-01T00:00:00Z" });
  f.records.set("grant:u:a", { userId: "u", agentId: "a", scopes: ["*"], createdAt: "2026-10-01T00:00:00Z" });

  f.reset();
  assert.equal((await f.call("/state")).status, 200);
  assert.equal(f.stats.lists, 3);
  assert.equal((await f.call("/state")).status, 200);
  assert.equal(f.stats.lists, 3, "hot Registry state must not relist storage");

  await f.call("/users/set-enabled", { userId: "u", enabled: false });
  assert.equal((await f.call("/state")).status, 200);
  assert.equal(f.stats.lists, 6, "relevant mutations must invalidate Registry state cache");
  console.log("PASS Registry state hot-cache collapses repeated dashboard metadata reads");
}

console.log("usage storage/query optimization tests passed");
