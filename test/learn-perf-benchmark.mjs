import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
const bundle=await build({
  stdin:{contents:'export { Learning } from "./src/learning"; export { buildLearnRelevanceContext,buildRelevantLearnEnvelope,withRequiredLearnCoverage } from "./src/learning-relevance";',resolveDir:process.cwd()},
  bundle:true,write:false,format:"esm",platform:"neutral",
  plugins:[{name:"stub",setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"stub",namespace:"stub"}));
    b.onLoad({filter:/.*/,namespace:"stub"},()=>({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}],
});
const {Learning,buildLearnRelevanceContext,buildRelevantLearnEnvelope,withRequiredLearnCoverage} =
  await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const db=new DatabaseSync(":memory:");
const sql={exec(query,...args){
  const stmt=db.prepare(query);
  const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);
  return {toArray:()=>rows};
}};
const learning=new Learning({storage:{sql,transactionSync(fn){
  db.exec("BEGIN");try{const result=fn();db.exec("COMMIT");return result;}
  catch(e){db.exec("ROLLBACK");throw e;}
}}},{});
const call=async(path,body)=>{
  const res=await learning.fetch(new Request("https://learning.internal"+path,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
  }));
  if(!res.ok)throw Error(path+" returned "+res.status);
  return res.json();
};
const scopes=[{scope:"global"},{scope:"project",scopeKey:"chat-relay"},{scope:"agent",scopeKey:"desktop-5iqpssc-003f1899"}];
const kinds=["workflow","coding_style","preference","response_style","work_style",
  "tool_pattern","problem_solving","project_context","correction","agent_context"];
for(let i=0;i<150;i++){
  const scope=scopes[i%3];
  sql.exec("INSERT INTO learning_memory_v1 (id,memory_key,kind,scope,scope_key,content,confidence,positive_feedback,negative_feedback,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "mem_"+(i+7000).toString().padStart(64,"0"),"generic-record-"+i,
    kinds[i%kinds.length],scope.scope,scope.scopeKey??null,
    "Reference note #"+i+": "+("Details about unrelated contexts and work conventions. ".repeat(9)),
    90+(i%10),0,0,"2026-10-01T00:00:00Z","2026-10-20T00:00:00Z");
}
const required=await call("/put",{key:"flowly-implementation-workflow",kind:"workflow",
  scope:"project",scopeKey:"chat-relay",content:"Flowly planning decision gate is required",confidence:0});
assert.equal(required.ok,true);
const context=buildLearnRelevanceContext("learn_prepare",{phase:"plan"},
  "chat-relay","desktop-5iqpssc-003f1899","medium Flowly REL-16 plan");
async function measure(mode){
  const start=performance.now(),cpuBefore=process.cpuUsage();
  const results=[];
  let bytes=0;
  const queryScopes = mode==="old" ? scopes.map(scope=>[scope]) : [scopes];
  for(const queryScope of queryScopes){
    const data=await call(mode==="old"?"/get":"/candidates",mode==="old"
      ?{scopes:queryScope,limit:64,perKind:4,routingReserve:24}
       :{scopes:queryScope,phase:"plan",query:"medium Flowly REL-16 plan",candidateLimit:Number(process.env.CANDIDATE_LIMIT || 64)});
    results.push(data);
    bytes+=Buffer.byteLength(JSON.stringify(data));
  }
  const elapsed=performance.now()-start,cpu=process.cpuUsage(cpuBefore);
  const records=results.flatMap(r=>r.items);
  const envelope=buildRelevantLearnEnvelope(records,scopes,context,10);
  const withCoverage=mode==="old"?envelope:withRequiredLearnCoverage(envelope,
    results.flatMap(r=>r.entries),records,scopes,context,[],["flowly-implementation-workflow"]);
  return {elapsed,cpuUs:cpu.user+cpu.system,bytes,hydrated:records.length,
    discovered:results.reduce((sum,r)=>sum+(r.entries?.length??r.items.length),0),
    requiredIncluded:Boolean(withCoverage?.items.some(r=>r.key==="flowly-implementation-workflow")),
    contextChars:withCoverage?.items.reduce((sum,r)=>sum+r.content.length,0)??0,
    coverage:withCoverage?.coverage?.status??"legacy-unchecked",
    scopedLearningDOCalls:queryScopes.length};
}
const trials=60;
const old=[],next=[];
for(let i=0;i<trials;i++){
  old.push(await measure("old"));
  next.push(await measure("new"));
}
const median=(arr)=>{const s=[...arr].sort((a,b)=>a-b);return +s[Math.floor(s.length/2)].toFixed(3);};
const p95=(arr)=>{const s=[...arr].sort((a,b)=>a-b);return +s[Math.floor(s.length*.95)].toFixed(3);};
const summarize=(values)=>({
  medianMs:median(values.map(v=>v.elapsed)),
  p95Ms:p95(values.map(v=>v.elapsed)),
  medianNodeCpuUs:median(values.map(v=>v.cpuUs)),
  medianInternalResponseBytes:median(values.map(v=>v.bytes)),
  medianHydrated:median(values.map(v=>v.hydrated)),
  discovered:values[0].discovered,
  requiredIncluded:values[0].requiredIncluded,
  contextChars:values[0].contextChars,
  estimatedContextTokens:Math.round(values[0].contextChars/4),
  coverage:values[0].coverage,
  scopedLearningDOCalls:values[0].scopedLearningDOCalls,
  estimatedUsageReceiptCalls:1,
});
assert.equal(next[0].requiredIncluded,true);
assert.equal(next[0].coverage,"complete");
console.log(JSON.stringify({
  environment:"Node.js "+process.version+" local in-memory SQLite, no network; Cloudflare CPU/unmeasured",
  entries:151,iterations:trials,
  old:summarize(old),indexed:summarize(next),
},null,2));
