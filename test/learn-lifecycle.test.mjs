import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
const bundle = await build({
  stdin: { contents: 'export { Learning } from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{ name: "cloudflare-host", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }",
    }));
  }}],
});
const { Learning } = await import("data:text/javascript;base64," +
  Buffer.from(bundle.outputFiles[0].text).toString("base64"));
function account() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query,...args) {
    const stmt = db.prepare(query);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args),[]);
    return { toArray: () => rows };
  }};
  const storage = { sql, transactionSync(fn) {
    db.exec("BEGIN");
    try { const out=fn();db.exec("COMMIT");return out; }
    catch (error) { db.exec("ROLLBACK");throw error; }
  }};
  const learning=new Learning({storage},{});
  return { db,sql,async call(path,body={}) {
    const response=await learning.fetch(new Request("https://learning.internal"+path,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }));
    return {status:response.status,...await response.json()};
  }};
}
const own=account(),other=account();
const created=await own.call("/put",{
  key:"required-stale-endpoint",scope:"project",scopeKey:"chat-relay",
  kind:"workflow",content:"Endpoint path is /old",confidence:100,
});
const id=created.item.id;
assert.equal((await own.call("/lifecycle",{id})).current.status,"valid");
assert.equal((await other.call("/lifecycle",{id})).status,404,"cross-account isolation");
assert.equal((await own.call("/lifecycle/status",{id,status:"needs-review"})).status,400,
  "no marking source stale without evidence");
const flagged=await own.call("/lifecycle/status",{
  id,status:"needs-review",reason:"Source endpoint no longer matches reference",
  evidenceRef:"test/source-endpoint-v2",sourceFingerprint:"revision-b",
});
assert.equal(flagged.current?.status,undefined);
assert.equal(flagged.state.status,"needs-review");
assert.equal(flagged.state.source_fingerprint,"revision-b");
// Read-but-unused telemetry cannot change factual validity.
const receipt=await own.call("/usage/prepare",{memoryIds:[id]});
assert.equal((await own.call("/usage/report",{
  receiptId:receipt.receiptId,appliedMemoryIds:[],verified:[],
})).status,200);
assert.equal((await own.call("/lifecycle",{id})).current.status,"needs-review");
await own.call("/put",{
  key:"required-stale-endpoint",scope:"project",scopeKey:"chat-relay",
  kind:"workflow",content:"Endpoint path is /new",confidence:100,
});
const revisioned=await own.call("/lifecycle",{id});
assert.equal(revisioned.current.revision,2);
assert.equal(revisioned.current.status,"needs-review",
  "explicit content edit does not silently certify stale Learn");
assert.equal(revisioned.revisions[0].content,"Endpoint path is /old");
const candidate=await own.call("/candidates",{
  scopes:[{scope:"project",scopeKey:"chat-relay"}],phase:"plan",
});
assert.equal(candidate.items[0].validity.status,"needs-review");
const restored=await own.call("/lifecycle/restore",{
  id,revision:1,reason:"Rollback to last verified historical reference",
  evidenceRef:"test/rollback-review",
});
assert.equal(restored.status,200);
assert.equal(restored.state.status,"valid");
assert.equal(restored.state.revision,3);
assert.equal((await own.call("/read-one",{id})).item.content,"Endpoint path is /old");
const history=await own.call("/lifecycle",{id});
assert.ok(history.revisions.some(r=>r.content==="Endpoint path is /new"));
assert.ok(history.events.some(e=>e.event_type==="restore"));
await own.call("/lifecycle/status",{id,status:"deprecated",
  reason:"Reference retired by documented migration",evidenceRef:"test/deprecation-2026"});
assert.equal((await own.call("/lifecycle",{id})).current.status,"deprecated");
const deleted=await own.call("/delete",{id});
assert.equal(deleted.deleted,true);
assert.equal((await own.call("/lifecycle",{id})).status,404);
console.log("PASS evidence-gated lifecycle, stale proof, reversible revisions, usage/validity isolation, ACL and delete");
