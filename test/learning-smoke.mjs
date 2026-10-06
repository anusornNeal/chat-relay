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
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }" }));
    },
  }],
});
const { Learning } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

class Cursor {
  constructor(rows=[]) { this.rows=rows; }
  toArray() { return this.rows.map((r) => structuredClone(r)); }
}
class FakeSql {
  constructor() { this.rows = new Map(); this.mutations = 0; }
  exec(sql, ...args) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE ")) return new Cursor();
    if (q.startsWith("INSERT INTO learning_memory_v1")) {
      const [id,kind,scope,scopeKey,content,confidence,createdAt,updatedAt]=args;
      const old=this.rows.get(id);
      this.rows.set(id,{ id,kind,scope,scope_key:scopeKey,content,confidence,
        positive_feedback:old?.positive_feedback ?? 0, negative_feedback:old?.negative_feedback ?? 0,
        created_at:old?.created_at ?? createdAt, updated_at:updatedAt });
      this.mutations++; return new Cursor();
    }
    if (q.startsWith("SELECT * FROM learning_memory_v1 WHERE id = ?")) {
      const row=this.rows.get(args[0]); return new Cursor(row ? [row] : []);
    }
    if (q.startsWith("SELECT id FROM learning_memory_v1 WHERE id = ?")) {
      return new Cursor(this.rows.has(args[0]) ? [{id:args[0]}] : []);
    }
    if (q.startsWith("DELETE FROM learning_memory_v1 WHERE id = ?")) {
      if (this.rows.delete(args[0])) this.mutations++; return new Cursor();
    }
    if (q.startsWith("UPDATE learning_memory_v1 SET positive_feedback")) {
      const [updatedAt,id]=args; const row=this.rows.get(id);
      if (row) { row.positive_feedback++; row.updated_at=updatedAt; this.mutations++; }
      return new Cursor();
    }
    if (q.startsWith("UPDATE learning_memory_v1 SET negative_feedback")) {
      const [updatedAt,id]=args; const row=this.rows.get(id);
      if (row) { row.negative_feedback++; row.updated_at=updatedAt; this.mutations++; }
      return new Cursor();
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
function fixture() {
  const sql=new FakeSql();
  const instance=new Learning({storage:{sql}}, {});
  const call=async(path, body)=>{
    const response=await instance.fetch(new Request("https://learning.internal"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));
    return {status:response.status,...await response.json()};
  };
  return {sql,call};
}

const a=fixture();
const b=fixture();

const put=await a.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Prefer concise responses",confidence:95});
assert.equal(put.status,200);
assert.equal(a.sql.mutations,1,"one explicit put should be one logical mutation");
const id=put.item.id;

const aGlobal=await a.call("/get",{scopes:[{scope:"global"}]});
assert.equal(aGlobal.items.length,1);
assert.equal(aGlobal.items[0].content,"Prefer concise responses");
assert.equal(a.sql.mutations,1,"reads must not mutate storage");

const bGuess=await b.call("/feedback",{id,value:"positive"});
assert.equal(bGuess.status,404,"another account instance must not access guessed ids");
assert.equal((await b.call("/get",{scopes:[{scope:"global"}]})).items.length,0);

await a.call("/put",{key:"relay-root",kind:"project_context",scope:"project",scopeKey:"chat-relay",content:"Repository root is the chat-relay worktree"});
await a.call("/put",{key:"desktop",kind:"agent_context",scope:"agent",scopeKey:"desktop-a",content:"Primary Windows agent"});
const combined=await a.call("/get",{scopes:[{scope:"global"},{scope:"project",scopeKey:"chat-relay"}],limit:10});
assert.equal(combined.items.length,2);
assert.ok(combined.items.every((x)=>x.scope==="global" || x.scopeKey==="chat-relay"));

const upsert=await a.call("/put",{key:"concise",kind:"preference",scope:"global",content:"Prefer concise high-level answers",confidence:100});
assert.equal(upsert.item.id,id);
assert.equal((await a.call("/get",{scopes:[{scope:"global"}]})).items[0].content,"Prefer concise high-level answers");

const feedback=await a.call("/feedback",{id,value:"positive"});
assert.equal(feedback.item.positiveFeedback,1);
assert.equal((await a.call("/feedback",{id,value:"negative"})).item.negativeFeedback,1);

assert.equal((await a.call("/put",{key:"bad",kind:"preference",scope:"project",content:"missing scope key"})).status,400);
assert.equal((await a.call("/put",{key:"bad",kind:"unknown",scope:"global",content:"x"})).status,400);
assert.equal((await a.call("/put",{key:"too-large",kind:"preference",scope:"global",content:"x".repeat(4001)})).status,400);

assert.equal((await a.call("/delete",{id})).deleted,true);
assert.equal((await a.call("/delete",{id})).deleted,false);

const worker=fs.readFileSync("src/worker-app.ts","utf8");
assert.match(worker,/env\.LEARNING\.get\(env\.LEARNING\.idFromName\(user\.id\)\)/,"Learning DO must be derived only from authenticated user.id");
for (const path of ["/get","/put","/delete","/feedback"]) assert.match(worker,new RegExp(`learningCall\\(env, user, "${path}"`),"Learn tools must call the account Learning DO directly");
for (const tool of ["learn_get","learn_put","learn_delete","learn_feedback"]) assert.match(worker,new RegExp('"' + tool + '"'));

const wrangler=fs.readFileSync("wrangler.jsonc","utf8");
assert.match(wrangler,/"LEARNING"/);
assert.match(wrangler,/"v6"/);

console.log("learning account isolation and CRUD tests passed");
