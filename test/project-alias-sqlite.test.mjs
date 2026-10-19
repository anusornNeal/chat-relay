import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

const bundled = await build({
  stdin: { contents: 'export { Learning } from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{
    name: "host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents:
        "export class DurableObject { constructor(ctx,env) {this.ctx=ctx;this.env=env;} }" }));
    },
  }],
});
const { Learning } = await import("data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64"));

function makeDO() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...args) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const storage = { sql, transactionSync(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  const learn = new Learning({ storage }, {});
  const call = async (route, data) => {
    const res = await learn.fetch(new Request("https://learning.internal" + route, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    }));
    return { status: res.status, ...(await res.json()) };
  };
  const seed = (id, key, kind, scopeKey, content, confidence = 90, positive = 0, negative = 0) => {
    sql.exec(`INSERT INTO learning_memory_v1
      (id,memory_key,kind,scope,scope_key,content,confidence,positive_feedback,negative_feedback,created_at,updated_at)
      VALUES (?,?,?,'project',?,?,?,?,?,'2026-10-12','2026-10-16')`,
      id, key, kind, scopeKey, content, confidence, positive, negative);
  };
  return { call, seed, db };
}
const a = makeDO();
a.seed("dest-a", "existing-rule", "workflow", "buddy2", "Original", 80, 1, 0);
a.seed("alias-1", "new-rule", "workflow", "buddy-android", "Rule A", 98, 0, 1);
a.seed("alias-2", "conflicting", "coding_style", "buddy-android", "Keep distinct text", 92, 1);
a.seed("dest-b", "conflicting", "coding_style", "buddy2", "Different text", 77, 0, 1);
a.seed("alias-3", "existing-rule", "workflow", "buddy-android", "Original", 95, 0, 1);
const merge = await a.call("/project-merge", { from: "buddy-android", to: "buddy2" });
assert.deepEqual([merge.status, merge.moved, merge.renamed, merge.deduplicated], [200, 2, 1, 1]);
const profile = await a.call("/profile", { limit: 100 });
assert.equal(profile.items.filter((m) => m.scopeKey === "buddy-android").length, 0);
assert.equal(profile.items.filter((m) => m.scopeKey === "buddy2").length, 4);
assert.ok(profile.items.some((m) => m.id === "alias-1" && m.negativeFeedback === 1 && m.confidence === 98));
assert.ok(profile.items.some((m) => m.id === "alias-2" && m.key.startsWith("conflicting-merged-")));
assert.ok(profile.items.some((m) => m.id === "dest-a" && m.negativeFeedback === 1 && m.positiveFeedback === 1 && m.confidence === 95));
assert.equal(profile.aliases.find((x) => x.alias === "buddy-android").projectKey, "buddy2");
const mapped = await a.call("/project-resolve", { projectKey: "buddy-android" });
assert.equal(mapped.projectKey, "buddy2");
assert.equal((await a.call("/project-resolve", { projectKey: "C:/Users/mixed/buddy-v2/buddy-android" })).projectKey, "buddy2");
assert.equal((await a.call("/project-resolve", { projectKey: "C:/Users/mixed/unrelated" })).projectKey, "C:/Users/mixed/unrelated");
const fetched = await a.call("/get", { scopes: [{ scope: "project", scopeKey: "buddy-android" }] });
assert.ok(fetched.items.length === 4 && fetched.items.every((m) => m.scopeKey === "buddy2"));
const ranked = await a.call("/get", { scopes: [{ scope: "project", scopeKey: "buddy-android" }], perKind: 1, limit: 10 });
assert.equal(ranked.resolvedProjectKey, "buddy2");
assert.ok(ranked.items.length > 0 && ranked.items.every((m) => m.scopeKey === "buddy2"));
const put = await a.call("/put", { key: "future-rule", kind: "workflow", scope: "project", scopeKey: "buddy-android", content: "One project across agents" });
assert.equal(put.item.scopeKey, "buddy2");
assert.equal((await a.call("/project-merge", { from: "buddy-android", to: "flowly" })).status, 409);
const second = makeDO();
assert.equal((await second.call("/project-resolve", { projectKey: "buddy-android" })).projectKey, "buddy-android");
assert.equal((await a.call("/project-merge", { from: "buddy-android", to: "buddy2" })).moved, 0);
console.log("PASS project merge: collision preservation, idempotency, aliases, per-account isolation, future reads/writes");
a.db.close();
second.db.close();
