import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
const bundle=await build({
  stdin:{contents:'export { Learning } from "./src/learning"; export { buildLearnRelevanceContext,buildRelevantLearnEnvelope,withRequiredLearnCoverage } from "./src/learning-relevance"; export { requiresFlowlyPlanningCheckpoint } from "./src/learn-phase";',resolveDir:process.cwd()},
  bundle:true,write:false,format:"esm",platform:"neutral",
  plugins:[{name:"cloudflare-stub",setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"stub",namespace:"stub"}));
    b.onLoad({filter:/.*/,namespace:"stub"},()=>({contents:"export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }"}));
  }}],
});
const {Learning,buildLearnRelevanceContext,buildRelevantLearnEnvelope,withRequiredLearnCoverage,requiresFlowlyPlanningCheckpoint} =
  await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
function account(){
  const db=new DatabaseSync(":memory:");
  const sql={exec(query,...args){
    const stmt=db.prepare(query);
    const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>rows};
  }};
  const storage={sql,transactionSync(fn){
    db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}
    catch(e){db.exec("ROLLBACK");throw e;}
  }};
  const learning=new Learning({storage},{});
  return {sql,async call(path,body={}){
    const res=await learning.fetch(new Request("https://learning.internal"+path,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }));
    return {status:res.status,...await res.json()};
  }};
}
function prepare(reads,phase,loadedIds=[],limit=10,query="Flowly REL-16 planning"){
  const records=reads.flatMap(r=>r.items),entries=reads.flatMap(r=>r.entries);
  const context=buildLearnRelevanceContext("learn_prepare",{phase},"chat-relay",null,query);
  const remaining=records.filter(r=>!loadedIds.includes(r.id));
  const envelope=buildRelevantLearnEnvelope(remaining,
    [{scope:"global"},{scope:"project",scopeKey:"chat-relay"}],context,limit);
  return withRequiredLearnCoverage(envelope,entries,remaining,
    [{scope:"global"},{scope:"project",scopeKey:"chat-relay"}],context,
    loadedIds,["flowly-implementation-workflow"]);
}
assert.equal(requiresFlowlyPlanningCheckpoint("Plan medium size code change","plan"),true);
assert.equal(requiresFlowlyPlanningCheckpoint("Plan small style edit","plan"),false);
assert.equal(requiresFlowlyPlanningCheckpoint("Read REL-16 card","read"),false);
const a=account();
await a.call("/put",{key:"flowly-implementation-workflow",kind:"workflow",
  scope:"project",scopeKey:"chat-relay",content:"Flowly decision report must precede implementation",confidence:0});
await a.call("/put",{key:"coding-style-precise-maintainable",kind:"coding_style",
  scope:"global",content:"Read current architecture. Follow clean code and actual tests.",confidence:0});
for(let i=0;i<120;i++){
  a.sql.exec("INSERT INTO learning_memory_v1 (id,memory_key,kind,scope,scope_key,content,confidence,positive_feedback,negative_feedback,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "mem_"+(i+5000).toString().padStart(64,"0"),
    "unrelated-high-score-"+i,"workflow","project","chat-relay",
    "Unrelated project note priority "+i,100,0,0,
    "2026-10-21T00:00:00Z","2026-10-28T00:00:00Z");
}
const scopes=[{scope:"global"},{scope:"project",scopeKey:"chat-relay"}];
async function load(phase){
  return Promise.all(scopes.map(scope=>a.call("/candidates",{
    scopes:[scope],phase,query:"Flowly REL-16 planning",candidateLimit:48,
  })));
}
const planned=load("plan").then(reads=>prepare(reads,"plan"));
const readPhase=load("read").then(reads=>prepare(reads,"read"));
const [plan,read]=await Promise.all([planned,readPhase]);
assert.equal(plan.coverage.status,"complete");
assert.ok(plan.items.some(r=>r.key==="flowly-implementation-workflow"),
  "low-confidence workflow survives >100 higher-confidence competitors");
assert.ok(read.items.every(r=>r.kind!=="coding_style"),"coding phase loads lazily");
const reads=await load("implement");
const codingCtx=buildLearnRelevanceContext("learn_prepare",{phase:"implement"},
  "chat-relay",null,"implement REL-16 Flowly changes");
const rec=reads.flatMap(r=>r.items),idx=reads.flatMap(r=>r.entries);
const coding=withRequiredLearnCoverage(
  buildRelevantLearnEnvelope(rec,scopes,codingCtx,10),idx,rec,scopes,codingCtx);
assert.ok(coding.items.some(item=>item.kind==="coding_style"),"coding standards are reserved");
assert.equal(coding.coverage.status,"complete");
const already=prepare(await load("plan"),"plan",
  plan.items.filter(item=>item.key==="flowly-implementation-workflow").map(item=>item.id));
assert.equal(already.coverage.status,"complete");
assert.equal(already.coverage.previouslyLoadedIds.length,1,"incremental phase remembers required rules");
const compulsory=a;
for(let i=0;i<13;i++){
  await compulsory.call("/put",{key:"required-many-"+i,kind:"workflow",scope:"project",
    scopeKey:"chat-relay",content:"Mandatory requirement "+i+" "+("x".repeat(1300)),confidence:0});
}
const over=prepare(await load("plan"),"plan",[],10);
assert.equal(over.coverage.status,"incomplete","required rule count beyond budget must be reported");
assert.ok(over.coverage.missingKeys.length>0);
assert.ok(over.items.every(r=>!r.key.startsWith("required-")||!r.contentTruncated),
  "required content must not be silently truncated");
const staleId=plan.items.find(r=>r.key==="flowly-implementation-workflow").id;
await a.call("/lifecycle/status",{id:staleId,status:"needs-review",
  reason:"Current source changed and requires verification",evidenceRef:"test/stale-flowly-rule"});
const reviewed=prepare(await load("plan"),"plan",[],10);
assert.ok(reviewed.coverage.needsReviewKeys.includes("flowly-implementation-workflow"));
await a.call("/lifecycle/status",{id:staleId,status:"deprecated",
  reason:"Retired after verified migration of workflow",evidenceRef:"test/deprecate-flowly"});
const retired=prepare(await load("plan"),"plan",[],10);
assert.equal(retired.coverage.status,"incomplete","deprecated mandatory rule must block coverage");
assert.ok(retired.coverage.missingKeys.includes("flowly-implementation-workflow"));
const other=account();
const missingReads=await Promise.all(scopes.map(scope=>other.call("/candidates",{scopes:[scope],phase:"plan"})));
const missing=prepare(missingReads,"plan");
assert.equal(missing.coverage.status,"incomplete","explicit Flowly checkpoint absent");
assert.ok(missing.coverage.missingKeys.includes("flowly-implementation-workflow"));
assert.equal((await a.call("/candidates",{scopes:[{scope:"project",scopeKey:"unrelated-project"}]})).candidateTotal,0);
console.log("PASS 122-record phase retrieval, mandatory coverage, coding, loaded IDs, budget, stale/deprecated, missing checkpoint and ACL");
