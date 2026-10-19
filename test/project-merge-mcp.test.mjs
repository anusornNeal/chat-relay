import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
const bundle=await build({
  stdin:{contents:'export { Learning } from "./src/learning";',resolveDir:process.cwd()},
  bundle:true,write:false,format:"esm",platform:"neutral",
  plugins:[{name:"host",setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"host",namespace:"host"}));
    b.onLoad({filter:/.*/,namespace:"host"},()=>({contents:"export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"}));
  }}]
});
const {Learning}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
function account(){
  const db=new DatabaseSync(":memory:");
  const sql={exec(query,...args){
    const st=db.prepare(query);
    const rows=st.columns().length?st.all(...args):(st.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const storage={sql,transactionSync(fn){
    db.exec("BEGIN IMMEDIATE");
    try{const res=fn();db.exec("COMMIT");return res}
    catch(e){db.exec("ROLLBACK");throw e}
  }};
  const learn=new Learning({storage},{});
  return {db,sql,async call(route,payload){
    const res=await learn.fetch(new Request("https://learning.internal"+route,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)
    }));
    return {status:res.status,...(await res.json())};
  },seed(id,key,kind,scopeKey,content,confidence=90,positive=0,negative=0){
    sql.exec("INSERT INTO learning_memory_v1 (id,memory_key,kind,scope,scope_key,content,confidence,positive_feedback,negative_feedback,created_at,updated_at) VALUES (?,?,?,'project',?,?,?,?,?,'2026-10-12','2026-10-16')",
      id,key,kind,scopeKey,content,confidence,positive,negative);
  }};
}
const a=account();
a.seed("from-1","unique","workflow","source","Keep unique",95,1,0);
a.seed("from-2","same","workflow","source","Same content",88,0,1);
a.seed("from-3","conflict","correction","source","Different content",90,0,1);
a.seed("to-1","same","workflow","target","Same content",70,1,0);
a.seed("to-2","conflict","correction","target","Keep both",80);
const preview=await a.call("/project-merge-preview",{from:"source",to:"target"});
assert.equal(preview.status,200);
assert.equal(preview.sourceCount,3);
assert.equal(preview.targetCount,2);
assert.equal(preview.willMove,2);
assert.equal(preview.willDeduplicate,1);
assert.equal(preview.willRename,1);
assert.equal(preview.conflicts[0].key,"conflict");
assert.equal(preview.resultingCount,4);
assert.match(preview.confirmationToken,/^[0-9a-f-]{36}$/);
const args={from:"source",to:"target",confirmationToken:preview.confirmationToken};
assert.equal((await a.call("/project-merge-confirm",{...args,confirmed:false})).status,403);
assert.equal((await a.call("/project-merge-confirm",{...args,confirmed:true,to:"other"})).status,409);
const b=account();
assert.equal((await b.call("/project-merge-confirm",{...args,confirmed:true})).status,409);
const result=await a.call("/project-merge-confirm",{...args,confirmed:true});
assert.deepEqual([result.status,result.moved,result.deduplicated,result.renamed],[200,2,1,1]);
assert.equal((await a.call("/project-merge-confirm",{...args,confirmed:true})).status,409);
const profile=await a.call("/profile",{limit:100});
assert.equal(profile.items.filter(x=>x.scopeKey==="source").length,0);
assert.equal(profile.items.filter(x=>x.scopeKey==="target").length,4);
assert.ok(profile.items.some(x=>x.id==="from-1"&&x.positiveFeedback===1));
assert.ok(profile.items.some(x=>x.id==="to-1"&&x.confidence===88&&x.negativeFeedback===1));
assert.equal((await a.call("/project-merge-preview",{from:"source",to:"target"})).alreadyMerged,true);

const c=account();
c.seed("c-a","first","workflow","a","A");
const check=await c.call("/project-merge-preview",{from:"a",to:"b"});
assert.equal((await c.call("/put",{key:"second",kind:"workflow",scope:"project",scopeKey:"a",content:"New memory"})).status,200);
const stale=await c.call("/project-merge-confirm",{from:"a",to:"b",confirmed:true,confirmationToken:check.confirmationToken});
assert.deepEqual([stale.status,stale.error],[409,"merge_preview_stale"]);
assert.equal((await c.call("/project-resolve",{projectKey:"a"})).projectKey,"a");
const retry=await c.call("/project-merge-preview",{from:"a",to:"b"});
c.sql.exec("UPDATE learning_project_merge_preview_v1 SET expires_at=? WHERE token=?",Date.now()-1,retry.confirmationToken);
const expired=await c.call("/project-merge-confirm",{from:"a",to:"b",confirmed:true,confirmationToken:retry.confirmationToken});
assert.deepEqual([expired.status,expired.error],[409,"merge_preview_expired"]);
assert.equal((await c.call("/project-resolve",{projectKey:"a"})).projectKey,"a");
a.db.close();b.db.close();c.db.close();
console.log("PASS MCP merge preview/commit, expiry, stale guard, token replay and account isolation");
