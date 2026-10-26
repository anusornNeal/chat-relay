import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export { Learning } from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, format: "esm", write: false, platform: "neutral",
  plugins: [{
    name: "cloudflare-host",
    setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ },
        () => ({ path: "stub", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" },
        () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }" }));
    },
  }],
});
const temporary = mkdtempSync(join(tmpdir(), "relay-learning-test-"));
let Learning;
try {
  const entrypoint = join(temporary, "bundle.mjs");
  writeFileSync(entrypoint, bundle.outputFiles[0].text);
  ({ Learning } = await import(pathToFileURL(entrypoint).href));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function createAccount() {
  const db = new DatabaseSync(":memory:");
  let failNextAppliedUpdate = false;
  const sql = {
    exec(query, ...params) {
      if (failNextAppliedUpdate && /SET usage_applied = usage_applied \+ 1/.test(query)) {
        failNextAppliedUpdate = false;
        throw new Error("simulated_sql_failure");
      }
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params)
        : (statement.run(...params), []);
      return { toArray: () => rows };
    },
  };
  const instance = new Learning({
    storage: {
      sql,
      transactionSync(callback) {
        db.exec("BEGIN TRANSACTION");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  }, {});
  const call = async (path, body) => {
    const response = await instance.fetch(new Request("https://learning.internal" + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: response.status, ...await response.json() };
  };
  return { db, call, sql, failOnApply() { failNextAppliedUpdate = true; } };
}

const first = createAccount();
const second = createAccount();
const item = (await first.call("/put", {
  key: "environment", kind: "agent_context", scope: "global", content: "Verified local paths",
})).item;
const start = (await first.call("/profile", { limit: 10 })).items[0];
assert.equal(start.usage.status, "new");
assert.equal(start.usage.score, null);
assert.equal(start.usage.retrieved, 0);

const prepare = await first.call("/usage/prepare", { memoryIds: [item.id] });
assert.equal(prepare.status, 200);
assert.equal(prepare.tracked, 1);
const delivered = (await first.call("/get", { scopes: [{ scope: "global" }] })).items[0];
assert.equal(delivered.usage.retrieved, 1);
assert.equal(delivered.usage.evaluated, 0);
assert.equal(delivered.usage.status, "unrated");

const denied = await second.call("/usage/report", {
  receiptId: prepare.receiptId, appliedMemoryIds: [item.id],
});
assert.equal(denied.status, 404, "cross-account receipt must fail");

const bad = await first.call("/usage/report", {
  receiptId: prepare.receiptId, appliedMemoryIds: [item.id],
  verified: [{ memoryId: item.id, evidenceRef: "bad" }],
});
assert.equal(bad.status, 400);
const applied = await first.call("/usage/report", {
  receiptId: prepare.receiptId, appliedMemoryIds: [item.id],
  verified: [{ memoryId: item.id, evidenceRef: "test:local-build-pass" }],
});
assert.equal(applied.status, 200);
assert.equal(applied.changed, true);
const retry = await first.call("/usage/report", {
  receiptId: prepare.receiptId, appliedMemoryIds: [item.id],
});
assert.equal(retry.changed, false);

const updated = (await first.call("/profile", { limit: 10 })).items[0];
assert.equal(updated.id, item.id);
assert.equal(updated.usage.retrieved, 1);
assert.equal(updated.usage.evaluated, 1);
assert.equal(updated.usage.applied, 1);
assert.equal(updated.usage.verified, 1);
assert.equal(updated.usage.status, "rated");
assert.equal(updated.usage.score, 66);
assert.equal(updated.confidence, 100, "underlying confidence remains for internal use");
assert.equal((await second.call("/profile", { limit: 10 })).summary.total, 0);

const aborted = createAccount();
const abortedItem = (await aborted.call("/put", {
  key: "rollback-check", kind: "workflow", scope: "global", content: "Check atomic writes",
})).item;
const abortedReceipt = (await aborted.call("/usage/prepare", {
  memoryIds: [abortedItem.id],
})).receiptId;
aborted.failOnApply();
await assert.rejects(
  aborted.call("/usage/report", { receiptId: abortedReceipt, appliedMemoryIds: [abortedItem.id] }),
  /simulated_sql_failure/,
);
let reverted = (await aborted.call("/profile", { limit: 10 })).items[0];
assert.equal(reverted.usage.evaluated, 0, "failed transaction must roll back evaluated count");
assert.equal(reverted.usage.applied, 0, "failed transaction must roll back applied count");
const retryAfterRollback = await aborted.call("/usage/report", {
  receiptId: abortedReceipt, appliedMemoryIds: [abortedItem.id],
});
assert.equal(retryAfterRollback.changed, true, "aborted report receipt must remain reusable");
reverted = (await aborted.call("/profile", { limit: 10 })).items[0];
assert.equal(reverted.usage.evaluated, 1);
assert.equal(reverted.usage.applied, 1);

first.db.close();
second.db.close();
aborted.db.close();
console.log("PASS Learn DO usage profile, receipt persistence, account isolation and retry");
