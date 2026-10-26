import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: 'export * from "./src/learn-usage"; export * from "./src/learn-usage-store";',
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", write: false, platform: "node",
});
const { LearnUsageStore, calculateLearnUsage, usageRoutingAdjustment } =
  await import("data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64"));

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE learning_memory_v1 (
    id TEXT PRIMARY KEY, memory_key TEXT NOT NULL, kind TEXT NOT NULL,
    scope TEXT NOT NULL, scope_key TEXT, content TEXT NOT NULL,
    confidence INTEGER NOT NULL DEFAULT 100,
    positive_feedback INTEGER NOT NULL DEFAULT 0,
    negative_feedback INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) WITHOUT ROWID`);
  let writes = 0;
  const sql = {
    exec(query, ...params) {
      const statement = db.prepare(query);
      let rows = [];
      if (statement.columns().length) rows = statement.all(...params);
      else {
        statement.run(...params);
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) writes++;
      }
      return { toArray: () => rows };
    },
  };
  const store = new LearnUsageStore(sql);
  store.initialize();
  store.initialize(); // repeated cold start may not reset counters
  const a = "mem_" + "a".repeat(64);
  const b = "mem_" + "b".repeat(64);
  const missing = "mem_" + "c".repeat(64);
  for (const id of [a, b]) sql.exec(
    "INSERT INTO learning_memory_v1 (id, memory_key, kind, scope, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    id, id, "workflow", "global", "Sample", new Date().toISOString(), new Date().toISOString(),
  );
  const get = (id) => sql.exec("SELECT * FROM learning_memory_v1 WHERE id=?", id).toArray()[0];
  return { store, db, get, ids: { a, b, missing }, writes: () => writes };
}

const f = fixture();
const { a, b, missing } = f.ids;
const initial = calculateLearnUsage({
  retrieved: 0, evaluated: 0, applied: 0, verified: 0,
  lastRetrievedAt: null, lastAppliedAt: null, lastVerifiedAt: null,
});
assert.equal(initial.status, "new");
assert.equal(initial.score, null);
assert.equal(usageRoutingAdjustment(initial), 0);

const now = Date.parse("2026-10-26T00:00:00Z");
const before = f.writes();
const created = f.store.createReceipt([a, b, missing], now);
assert.ok(created.receiptId);
assert.equal(created.tracked, 2);
assert.ok(f.writes() - before <= 3, "one bounded write batch per prepare, not one per memory");
assert.equal(f.get(a).usage_retrieved, 1);
assert.equal(f.get(a).usage_evaluated, 0);
assert.equal(f.get(b).usage_retrieved, 1);

assert.equal(f.store.report(created.receiptId, [missing], [], now + 1).error, "memory_not_in_prepared_context");
assert.equal(f.store.report(created.receiptId, [a], [{ memoryId: b, evidenceRef: "test:case-42" }], now + 1).error, "invalid_verification_evidence");
assert.equal(f.store.report(created.receiptId, [a], [{ memoryId: a, evidenceRef: "short" }], now + 1).error, "invalid_verification_evidence");
assert.equal(f.store.report(created.receiptId, [a, a], [], now + 1).error, "invalid_usage_report");
assert.equal(f.get(a).usage_evaluated, 0, "invalid reports must not mutate counters");

const reportingWrites = f.writes();
const reported = f.store.report(created.receiptId, [a], [
  { memoryId: a, evidenceRef: "test:case-42" },
], now + 10);
assert.deepEqual({ changed: reported.changed, evaluated: reported.evaluated,
  applied: reported.applied, verified: reported.verified },
{ changed: true, evaluated: 2, applied: 1, verified: 1 });
assert.ok(f.writes() - reportingWrites <= 4, "report must aggregate updates by category");
assert.equal(f.get(a).usage_evaluated, 1);
assert.equal(f.get(a).usage_applied, 1);
assert.equal(f.get(a).usage_verified, 1);
assert.equal(f.get(b).usage_evaluated, 1);
assert.equal(f.get(b).usage_applied, 0);

assert.equal(f.store.report(created.receiptId, [a], [], now + 20).changed, false,
  "retries must not double count");
assert.equal(f.get(a).usage_applied, 1);

const score = calculateLearnUsage({
  retrieved: 1, evaluated: 1, applied: 1, verified: 1,
  lastRetrievedAt: f.get(a).usage_last_retrieved,
  lastAppliedAt: f.get(a).usage_last_applied,
  lastVerifiedAt: f.get(a).usage_last_verified,
}, now + 10);
assert.equal(score.status, "rated");
assert.equal(score.score, 66, "Bayesian smoothing prevents one success = 100");
assert.equal(usageRoutingAdjustment(score), 0, "one sample has minimal routing influence");
assert.equal(calculateLearnUsage({
  retrieved: 1, evaluated: 0, applied: 0, verified: 0,
  lastRetrievedAt: null, lastAppliedAt: null, lastVerifiedAt: null,
}).status, "unrated");
assert.equal(calculateLearnUsage({
  retrieved: 2, evaluated: 1, applied: 0, verified: 0,
  lastRetrievedAt: null, lastAppliedAt: null, lastVerifiedAt: null,
}).score, 24, "reported-but-unused is distinct from unrated");

const stale = f.store.createReceipt([a], now);
assert.equal(f.store.report(stale.receiptId, [], [], now + 24 * 3600 * 1000 + 1).status, 410);
const another = fixture();
assert.equal(another.store.report(created.receiptId, [a], [], now + 10).status, 404,
  "receipts are account isolated");
assert.deepEqual(f.store.createReceipt([missing], now + 20), { receiptId: null, tracked: 0 });

const ui = readFileSync("dashboard/app.js", "utf8");
assert.match(ui, /data-learn-sort="usage">Usage Score/);
assert.match(ui, /Retrieved<\/span>/);
assert.match(ui, /Applied<\/span>/);
assert.match(ui, /Verified<\/span>/);
assert.doesNotMatch(ui, /data-learn-sort="confidence"/);

// The usage sort must rank rated scores first, then Unrated, then New.
const sortFunction = ui.slice(ui.indexOf('function learnUsageSortValue('), ui.indexOf('function learnTreeKindRows('));
const sortVisible = new Function('items', 'learnScopeFilter', 'learnScopeKeyFilter', 'learnKindFilter', 'learnSearchQuery', 'learnSortMode',
  'const learnItemsForScope = (items) => items;\n' + sortFunction + '\nreturn learnVisibleItems(items);');
const sorted = sortVisible([
  { key: 'new', usage: { status: 'new', score: null } },
  { key: 'low', usage: { status: 'rated', score: 0 } },
  { key: 'unrated', usage: { status: 'unrated', score: null } },
  { key: 'high', usage: { status: 'rated', score: 90 } },
  { key: 'mid', usage: { status: 'rated', score: 45 } },
], 'all', '', 'all', '', 'usage');
assert.deepEqual(sorted.map((item) => item.key), ['high', 'mid', 'low', 'unrated', 'new']);

f.db.close();
another.db.close();
console.log("PASS Learn usage receipts, score, isolation, idempotence and UI contract");
