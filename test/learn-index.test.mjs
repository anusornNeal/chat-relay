import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export { Learning } from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{
    name: "cloudflare-host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }",
      }));
    },
  }],
});
const { Learning } = await import("data:text/javascript;base64," +
  Buffer.from(bundle.outputFiles[0].text).toString("base64"));

function account() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...args) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const storage = {
    sql,
    transactionSync(fn) {
      db.exec("BEGIN");
      try { const result = fn(); db.exec("COMMIT"); return result; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  const learning = new Learning({ storage }, {});
  const call = async (path, body = {}) => {
    const response = await learning.fetch(new Request("https://learning.internal" + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: response.status, ...await response.json() };
  };
  return { db, sql, call };
}
const first = account();
const second = account();
const scopes = [{ scope: "global" }, { scope: "project", scopeKey: "chat-relay" }];
const required = await first.call("/put", {
  key: "flowly-implementation-workflow", kind: "workflow", scope: "project",
  scopeKey: "chat-relay", content: "Plan in Flowly before implementation", confidence: 1,
});
assert.equal(required.status, 200);
let entries = await first.call("/index", { scopes });
assert.equal(entries.status, 200);
assert.equal(entries.count, 1);
assert.equal(entries.entries[0].required_rule, 1);
assert.equal(entries.entries[0].memory_key, "flowly-implementation-workflow");
assert.equal(entries.entries[0].content_length, 36);
assert.equal((await second.call("/index", { scopes })).count, 0, "account isolation");

const updated = await first.call("/put", {
  key: "flowly-implementation-workflow", kind: "workflow", scope: "project",
  scopeKey: "chat-relay", content: "Plan, decision gate, review and verify", confidence: 2,
});
assert.equal(updated.status, 200);
entries = await first.call("/index", { scopes });
assert.equal(entries.entries[0].content_length, updated.item.content.length);

const other = await first.call("/put", {
  key: "required-read-first", kind: "coding_style", scope: "global",
  content: "Read first", confidence: 0,
});
entries = await first.call("/index", { scopes });
assert.equal(entries.count, 2);
assert.ok(entries.entries.every(e => e.required_rule === 1));

const privateRecord = await first.call("/put", {
  key: "private", kind: "preference", scope: "project",
  scopeKey: "another-project", content: "Secret-free but isolated",
});
assert.equal(privateRecord.status, 200);
assert.equal((await first.call("/index", { scopes })).count, 2, "project scope isolation");

const deleted = await first.call("/delete", { id: other.item.id });
assert.equal(deleted.status, 200);
assert.equal((await first.call("/index", { scopes })).count, 1);

first.sql.exec("DELETE FROM learning_metadata_index_v1 WHERE id=?", required.item.id);
assert.equal((await first.call("/index", { scopes })).count, 0, "corrupt index is detectable");
const rebuilt = await first.call("/index-rebuild");
assert.equal(rebuilt.status, 200);
assert.equal(rebuilt.indexed, 2);
assert.equal((await first.call("/index", { scopes })).count, 1);
assert.equal((await first.call("/index", { scopes: [{ scope: "project", scopeKey: "another-project" }] })).count, 1);

// Trigger stays synchronized for SQL migrations and project merges, not only /put.
first.sql.exec("UPDATE learning_memory_v1 SET scope_key='renamed-project' WHERE id=?", privateRecord.item.id);
assert.equal((await first.call("/index", { scopes: [{ scope: "project", scopeKey: "another-project" }] })).count, 0);
assert.equal((await first.call("/index", { scopes: [{ scope: "project", scopeKey: "renamed-project" }] })).count, 1);


// More than the former per-kind top-four and 64 candidate caps must remain discoverable.
const crowded = account();
await crowded.call("/put", { key: "flowly-implementation-workflow", kind: "workflow",
  scope: "project", scopeKey: "chat-relay", content: "Flowly planning checkpoint is mandatory", confidence: 0 });
for (let i = 0; i < 110; i++) {
  crowded.sql.exec("INSERT INTO learning_memory_v1 (id,memory_key,kind,scope,scope_key,content,confidence,positive_feedback,negative_feedback,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "mem_" + String(i).padStart(64, "0"), "unrelated-" + i, "workflow", "project",
    "chat-relay", "Unrelated high-priority workflow candidate " + i, 100, 0, 0,
    "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
}
const candidates = await crowded.call("/candidates", {
  scopes: [{ scope: "project", scopeKey: "chat-relay" }], phase: "plan",
  query: "read requirements and plan Flowly", candidateLimit: 8,
});
assert.equal(candidates.status, 200);
assert.equal(candidates.candidateTotal, 111);
assert.equal(candidates.entries.length, 111);
assert.equal(candidates.items.length, 8);
assert.ok(candidates.items.some(item => item.key === "flowly-implementation-workflow"),
  "required low-confidence workflow survives even 110 competitors");
assert.ok(candidates.entries.every(entry => entry.phase_mask === 31));
assert.equal((await second.call("/candidates", {
  scopes: [{ scope: "project", scopeKey: "chat-relay" }]
})).candidateTotal, 0, "account candidate isolation");
assert.equal((await crowded.call("/index-rebuild")).indexed, 111);
assert.equal((await crowded.call("/index", {
  scopes: [{ scope: "project", scopeKey: "chat-relay" }]
})).count, 111);
console.log("PASS indexed 111-record candidate discovery, mandatory workflow priority, explicit limit and account isolation");

console.log("PASS Learn Index CRUD, low-confidence required rules, account/project isolation, SQL mutation and rebuild");
