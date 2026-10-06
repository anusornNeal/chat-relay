import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";

const bundled = await build({
  stdin: { contents: 'export { Learning } from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{
    name: "host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }",
      }));
    },
  }],
});
const { Learning } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

class Cursor {
  constructor(rows=[]) { this.rows=rows; }
  toArray() { return this.rows.map((r) => structuredClone(r)); }
}

class FakeSql {
  constructor({ legacy = false, rows = [] } = {}) {
    this.columns = new Set([
      "id",
      ...(legacy ? [] : ["memory_key"]),
      "kind",
      "scope",
      "scope_key",
      "content",
      "confidence",
      "positive_feedback",
      "negative_feedback",
      "created_at",
      "updated_at",
    ]);
    this.rows = new Map(rows.map((row) => [row.id, structuredClone(row)]));
    this.activity = [];
    this.mutations = 0;
    this.activityMutations = 0;
  }

  exec(sql, ...args) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (q.startsWith("CREATE TABLE")) return new Cursor();
    if (q.startsWith("CREATE INDEX")) return new Cursor();

    if (q.startsWith("PRAGMA table_info")) {
      return new Cursor([...this.columns].map((name, index) => ({ cid: index, name })));
    }

    if (q.startsWith("ALTER TABLE learning_memory_v1 ADD COLUMN memory_key TEXT")) {
      this.columns.add("memory_key");
      for (const row of this.rows.values()) {
        if (!Object.prototype.hasOwnProperty.call(row, "memory_key")) row.memory_key = null;
      }
      return new Cursor();
    }

    if (q.startsWith("SELECT id FROM learning_memory_v1 WHERE memory_key IS NULL")) {
      return new Cursor([...this.rows.values()].filter((row) => row.memory_key == null).map((row) => ({ id: row.id })));
    }

    if (q.startsWith("UPDATE learning_memory_v1 SET memory_key = ? WHERE id = ?")) {
      const [memoryKey,id]=args;
      const row=this.rows.get(id);
      if (row) { row.memory_key=memoryKey; this.mutations++; }
      return new Cursor();
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE kind = ? AND scope = ? AND scope_key IS NULL AND memory_key = ? LIMIT 1")) {
      const [kind,scope,key]=args;
      const row=[...this.rows.values()].find((r)=>r.kind===kind && r.scope===scope && r.scope_key==null && r.memory_key===key);
      return new Cursor(row ? [row] : []);
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE kind = ? AND scope = ? AND scope_key = ? AND memory_key = ? LIMIT 1")) {
      const [kind,scope,scopeKey,key]=args;
      const row=[...this.rows.values()].find((r)=>r.kind===kind && r.scope===scope && r.scope_key===scopeKey && r.memory_key===key);
      return new Cursor(row ? [row] : []);
    }

    if (q.startsWith("SELECT COUNT(*) AS count FROM learning_memory_v1")) {
      return new Cursor([{ count: this.rows.size }]);
    }

    if (q.startsWith("INSERT INTO learning_memory_v1")) {
      const [id,key,kind,scope,scopeKey,content,confidence,positiveFeedback,negativeFeedback,createdAt,updatedAt]=args;
      const old=this.rows.get(id);
      this.rows.set(id,{
        id,
        memory_key:key,
        kind,
        scope,
        scope_key:scopeKey,
        content,
        confidence,
        positive_feedback:old?.positive_feedback ?? positiveFeedback ?? 0,
        negative_feedback:old?.negative_feedback ?? negativeFeedback ?? 0,
        created_at:old?.created_at ?? createdAt,
        updated_at:updatedAt,
      });
      this.mutations++;
      return new Cursor();
    }

    if (q.startsWith("INSERT INTO learning_activity_v1")) {
      const [eventId,memoryId,changeType,memoryKey,kind,scope,scopeKey,summary,confidence,previousConfidence,createdAt]=args;
      this.activity.push({
        event_id:eventId,
        memory_id:memoryId,
        change_type:changeType,
        memory_key:memoryKey,
        kind,
        scope,
        scope_key:scopeKey,
        summary,
        confidence,
        previous_confidence:previousConfidence,
        created_at:createdAt,
      });
      this.activityMutations++;
      return new Cursor();
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE id = ?")) {
      const row=this.rows.get(args[0]);
      return new Cursor(row ? [row] : []);
    }

    if (q.startsWith("SELECT id FROM learning_memory_v1 WHERE id = ?")) {
      return new Cursor(this.rows.has(args[0]) ? [{id:args[0]}] : []);
    }

    if (q.startsWith("DELETE FROM learning_memory_v1 WHERE id = ?")) {
      if (this.rows.delete(args[0])) this.mutations++;
      return new Cursor();
    }

    if (q.startsWith("UPDATE learning_memory_v1 SET positive_feedback")) {
      const [updatedAt,id]=args;
      const row=this.rows.get(id);
      if (row) { row.positive_feedback++; row.updated_at=updatedAt; this.mutations++; }
      return new Cursor();
    }

    if (q.startsWith("UPDATE learning_memory_v1 SET negative_feedback")) {
      const [updatedAt,id]=args;
      const row=this.rows.get(id);
      if (row) { row.negative_feedback++; row.updated_at=updatedAt; this.mutations++; }
      return new Cursor();
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE scope = ? AND scope_key IS NULL AND kind = ? ORDER BY confidence DESC")) {
      const [scope,kind,limitRaw]=args;
      const limit=Number(limitRaw);
      return new Cursor([...this.rows.values()]
        .filter((r)=>r.scope===scope && r.scope_key==null && r.kind===kind)
        .sort((a,b)=> b.confidence-a.confidence || b.positive_feedback-a.positive_feedback || a.negative_feedback-b.negative_feedback || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
        .slice(0,limit));
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE scope = ? AND scope_key = ? AND kind = ? ORDER BY confidence DESC")) {
      const [scope,scopeKey,kind,limitRaw]=args;
      const limit=Number(limitRaw);
      return new Cursor([...this.rows.values()]
        .filter((r)=>r.scope===scope && r.scope_key===scopeKey && r.kind===kind)
        .sort((a,b)=> b.confidence-a.confidence || b.positive_feedback-a.positive_feedback || a.negative_feedback-b.negative_feedback || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
        .slice(0,limit));
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 ORDER BY updated_at DESC, id ASC LIMIT ?")) {
      const limit=Number(args[0]);
      return new Cursor([...this.rows.values()]
        .sort((a,b)=> b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
        .slice(0,limit));
    }

    if (q.startsWith("SELECT * FROM learning_activity_v1 ORDER BY created_at DESC, event_id ASC LIMIT ?")) {
      const limit=Number(args[0]);
      return new Cursor([...this.activity]
        .sort((a,b)=> b.created_at.localeCompare(a.created_at) || a.event_id.localeCompare(b.event_id))
        .slice(0,limit));
    }

    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE (")) {
      const hasKind=q.includes(" AND kind = ?");
      const limit=Number(args.at(-1));
      const kind=hasKind ? String(args.at(-2)) : null;
      const scopeArgs=args.slice(0, hasKind ? -2 : -1);
      let i=0;
      const wanted=[];
      const clauses=(q.match(/\(scope = \? AND scope_key (?:IS NULL|= \?)\)/g) ?? []);
      for (const clause of clauses) {
        const scope=String(scopeArgs[i++]);
        const scopeKey=clause.includes("IS NULL") ? null : String(scopeArgs[i++]);
        wanted.push({scope,scopeKey});
      }
      const rows=[...this.rows.values()]
        .filter((r)=>wanted.some((w)=>r.scope===w.scope && (w.scopeKey===null ? r.scope_key===null : r.scope_key===w.scopeKey)))
        .filter((r)=>!kind || r.kind===kind)
        .sort((a,b)=> b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
        .slice(0,limit);
      return new Cursor(rows);
    }

    throw new Error("Unhandled SQL: "+q);
  }
}

function fixture(options) {
  const sql=new FakeSql(options);
  const instance=new Learning({storage:{sql}}, {});
  const call=async(path, body)=>{
    const response=await instance.fetch(new Request("https://learning.internal"+path,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(body),
    }));
    return {status:response.status,...await response.json()};
  };
  return {sql,call};
}

const a=fixture();
const b=fixture();

const put=await a.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Prefer concise responses",confidence:95});
assert.equal(put.status,200);
assert.equal(put.item.key,"concise");
assert.match(put.item.id,/^mem_[a-f0-9]{64}$/);
assert.equal(a.sql.mutations,1,"one changed put should write one memory row");
assert.equal(a.sql.activityMutations,0,"Learn mutations must not persist activity rows");
const id=put.item.id;

const duplicate=await a.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Prefer concise responses",confidence:95});
assert.equal(duplicate.changed,false,"identical automatic learning must be a no-op");
assert.equal(a.sql.mutations,1,"duplicate learn must not write memory");
assert.equal(a.sql.activityMutations,0,"duplicate learn must not append activity");

const profile=await a.call("/profile",{limit:100});
assert.equal(profile.summary.total,1);
assert.equal(profile.activity,undefined,"profile should not read or expose activity history");

const aGlobal=await a.call("/get",{scopes:[{scope:"global"}]});
assert.equal(aGlobal.items.length,1);
assert.equal(aGlobal.items[0].content,"Prefer concise responses");
assert.equal(a.sql.mutations,1,"reads must not mutate memory storage");
assert.equal(a.sql.activityMutations,0,"reads must not mutate activity storage");

const bGuess=await b.call("/feedback",{id,value:"positive"});
assert.equal(bGuess.status,404,"another account instance must not access guessed ids");
assert.equal((await b.call("/get",{scopes:[{scope:"global"}]})).items.length,0);

await a.call("/put",{key:"relay-root",kind:"project_context",scope:"project",scopeKey:"chat-relay",content:"Repository root is the chat-relay worktree"});
await a.call("/put",{key:"desktop",kind:"agent_context",scope:"agent",scopeKey:"desktop-a",content:"Primary Windows agent"});
const combined=await a.call("/get",{scopes:[{scope:"global"},{scope:"project",scopeKey:"chat-relay"}],limit:10});
assert.equal(combined.items.length,2);
assert.ok(combined.items.every((x)=>x.scope==="global" || x.scopeKey==="chat-relay"));

await a.call("/put",{key:"workflow-a",kind:"workflow",scope:"project",scopeKey:"chat-relay",content:"Implement then test",confidence:90});
await a.call("/put",{key:"workflow-b",kind:"workflow",scope:"project",scopeKey:"chat-relay",content:"Review before merge",confidence:99});
await a.call("/put",{key:"coding-a",kind:"coding_style",scope:"project",scopeKey:"chat-relay",content:"Prefer small focused patches",confidence:95});
await a.call("/put",{key:"coding-b",kind:"coding_style",scope:"project",scopeKey:"chat-relay",content:"Keep functions bounded",confidence:80});
const balanced=await a.call("/get",{scopes:[{scope:"project",scopeKey:"chat-relay"}],perKind:1,limit:10});
assert.equal(balanced.strategy,"balanced-kind");
assert.equal(balanced.perKind,1);
assert.equal(balanced.items.filter((x)=>x.kind==="workflow").length,1);
assert.equal(balanced.items.find((x)=>x.kind==="workflow")?.key,"workflow-b");
assert.equal(balanced.items.filter((x)=>x.kind==="coding_style").length,1);
assert.equal(balanced.items.find((x)=>x.kind==="coding_style")?.key,"coding-a");

const upsert=await a.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Prefer concise high-level answers",confidence:100});
assert.equal(upsert.item.id,id);
assert.equal((await a.call("/get",{scopes:[{scope:"global"}]})).items[0].content,"Prefer concise high-level answers");

const longScope="โ".repeat(200);
const longA=await a.call("/put",{key:"ก".repeat(159)+"a",kind:"preference",scope:"project",scopeKey:longScope,content:"A"});
const longB=await a.call("/put",{key:"ก".repeat(159)+"b",kind:"preference",scope:"project",scopeKey:longScope,content:"B"});
assert.notEqual(longA.item.id,longB.item.id,"long/unicode memory keys must not collide");
assert.equal(longA.item.id.length,68);
assert.equal(longB.item.id.length,68);

const legacyId="preference|global||concise";
const legacy=fixture({
  legacy:true,
  rows:[{
    id:legacyId,
    kind:"preference",
    scope:"global",
    scope_key:null,
    content:"Legacy concise preference",
    confidence:90,
    positive_feedback:0,
    negative_feedback:0,
    created_at:"2026-10-01T00:00:00.000Z",
    updated_at:"2026-10-01T00:00:00.000Z",
  }],
});
assert.ok(legacy.sql.columns.has("memory_key"),"legacy schema must add memory_key");
assert.equal(legacy.sql.rows.get(legacyId).memory_key,"concise","legacy id must backfill the original key");
const legacyUpdate=await legacy.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Updated after migration",confidence:100});
assert.equal(legacyUpdate.item.id,legacyId,"migration must preserve legacy id when updating the same memory");
assert.equal(legacy.sql.rows.size,1,"migration update must not duplicate an existing memory");
assert.equal((await legacy.call("/get",{scopes:[{scope:"global"}]})).items[0].key,"concise");

const cappedRows=Array.from({length:512},(_,index)=>({
  id:"mem-seed-"+index,
  memory_key:"seed-"+index,
  kind:"preference",
  scope:"global",
  scope_key:null,
  content:"seed",
  confidence:100,
  positive_feedback:0,
  negative_feedback:0,
  created_at:"2026-10-01T00:00:00.000Z",
  updated_at:"2026-10-01T00:00:00.000Z",
}));
const capped=fixture({rows:cappedRows});
const cappedNew=await capped.call("/put",{key:"new-key",kind:"preference",scope:"global",content:"should reject"});
assert.equal(cappedNew.status,409,"new memories must stop at the per-account cap");
const cappedUpdate=await capped.call("/put",{key:"seed-0",kind:"preference",scope:"global",content:"updated existing"});
assert.equal(cappedUpdate.status,200,"existing memories must remain updatable at the cap");
assert.equal(capped.sql.rows.size,512);

const feedback=await a.call("/feedback",{id,value:"positive"});
assert.equal(feedback.item.positiveFeedback,1);
assert.equal((await a.call("/feedback",{id,value:"negative"})).item.negativeFeedback,1);

assert.equal((await a.call("/put",{key:"bad",kind:"preference",scope:"project",content:"missing scope key"})).status,400);
assert.equal((await a.call("/put",{key:"bad",kind:"unknown",scope:"global",content:"x"})).status,400);
assert.equal((await a.call("/put",{key:"too-large",kind:"preference",scope:"global",content:"x".repeat(4001)})).status,400);

assert.equal((await a.call("/delete",{id})).deleted,true);
assert.equal((await a.call("/delete",{id})).deleted,false);

const learningSource=fs.readFileSync("src/learning.ts","utf8");
assert.doesNotMatch(learningSource,/learning_activity_v1/,"Learn activity history must not be persisted");

const worker=fs.readFileSync("src/worker-app.ts","utf8");
assert.match(worker,/env\.LEARNING\.get\(env\.LEARNING\.idFromName\(user\.id\)\)/,"Learning DO must be derived only from authenticated user.id");
assert.ok(worker.includes('learningCall(env, user, "/get"'),"Learn reads must call the account Learning DO directly");
for (const path of ["/put","/delete","/feedback"]) {
  assert.ok(worker.includes(`learningMutationCall(env, user, "${path}"`),"Learn mutations must use the mutation wrapper");
}
assert.match(worker,/LEARN_BASELINE_CONTEXT/,"automatic Learn baseline must be surfaced to every Relay app");
assert.match(worker,/applyLearningMutation/,"changed Learn mutations must update warm context and TUI activity");
for (const tool of ["learn_get","learn_put","learn_delete","learn_feedback"]) {
  assert.match(worker,new RegExp('"' + tool + '"'));
}

const wrangler=fs.readFileSync("wrangler.jsonc","utf8");
assert.match(wrangler,/"LEARNING"/);
assert.match(wrangler,/"v6"/);

console.log("learning account isolation, migration, and CRUD tests passed");
