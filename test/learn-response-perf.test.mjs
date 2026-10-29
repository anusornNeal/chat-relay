// Repeatable local MCP/DO contract and payload benchmark. Does not access real accounts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const samples = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] || 30);
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 100);
const bundled = await build({
  stdin: { contents: 'export {createMcpServer} from "./src/worker-app";export {Learning} from "./src/learning";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", packages: "external", format: "esm",
  plugins: [{ name: "cloudflare-stub", setup(esbuild) {
    esbuild.onResolve({filter: /^cloudflare:workers$/}, () => ({path: "stub", namespace: "stub"}));
    esbuild.onLoad({filter: /.*/, namespace: "stub"}, () => ({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}"}));
  }}],
});
const tmp = await mkdtemp(join(process.cwd(), ".workspace", "relay-learn-perf-"));
let serverModule;
try {
  const bundlePath = join(tmp, "bundle.mjs");
  await writeFile(bundlePath, bundled.outputFiles[0].text);
  serverModule = await import(pathToFileURL(bundlePath).href);
} finally { await rm(tmp, {recursive:true, force:true}); }
const { createMcpServer, Learning } = serverModule;
const dbs = new Map(), stores = new Map(), paths = new Map();
const makeLearning = (name) => {
  const db = new DatabaseSync(":memory:");
  dbs.set(name, db);
  const sql = { exec(query,...args) {
    const stmt=db.prepare(query);
    const rows=stmt.columns().length ? stmt.all(...args) : (stmt.run(...args),[]);
    return {toArray: () => rows};
  }};
  return new Learning({ storage: {sql, transactionSync(fn) {
    db.exec("BEGIN");
    try {const result=fn();db.exec("COMMIT");return result;} catch(err){db.exec("ROLLBACK");throw err;}
  }}},{});
};
for (const userId of ["user-perf-alpha", "user-perf-bravo"]) stores.set(userId, makeLearning(userId));
const env = {
  LEARNING: { idFromName: (name) => name, get: (name) => ({ fetch: (request) => {
    const path = new URL(request.url).pathname;
    paths.set(name + path, (paths.get(name + path) || 0) + 1);
    if (name === "shared-learn-groups:v1") return Response.json({items:[]});
    return stores.get(name)?.fetch(request) ?? Response.json({items:[]});
  }})},
  USAGE_RECORD_DAILY_BUDGET: 0,
};
async function post(user, url, body) {
  const resp=await stores.get(user).fetch(new Request("https://learning.internal"+url, {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
  }));
  assert.equal(resp.status,200,url);
  return resp.json();
}
for (const user of ["user-perf-alpha","user-perf-bravo"]) {
  const unique = user.endsWith("alpha") ? "ALPHA" : "BRAVO";
  await post(user,"/put",{key:"flowly-implementation-workflow",scope:"project",scopeKey:"chat-relay",kind:"workflow",
    content:"Required rule "+unique+": review evidence before release, preserve account isolation and scoped routing."});
  await post(user,"/put",{key:"global-code-standards",scope:"global",kind:"coding_style",
    content:unique+" coding style: check branches, null, cancellation and concurrency, then run actual tests. ".repeat(8)});
  for(let n=0;n<15;n++)await post(user,"/put",{
    key:"optional-"+n,scope:n%2?"global":"project",scopeKey:n%2?undefined:"chat-relay",
    kind:n%3===0?"workflow":"tool_pattern",
    content:unique+" useful but optional "+n+": "+("Prefer bounded tools, evidence driven testing and project scoped data. ".repeat(10)),
  });
}
function parseResult(data) {
  assert.ok(!data.isError,JSON.stringify(data).slice(0,300));
  const content=data.content.find((entry)=>entry.type==="text")?.text;
  assert.ok(content);
  return JSON.parse(content);
}
const sessions = [];
async function makeClient(id) {
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createMcpServer(env,{id,email:id+"@example.test",admin:false});
  const client=new Client({name:"relay-perf-"+id,version:"1.0"});
  await server.connect(serverTransport);await client.connect(clientTransport);
  sessions.push({client,server});
  return client;
}
const percentile=(arr,ratio) => {
  const sorted=[...arr].sort((a,b)=>a-b);
  return Number(sorted[Math.max(0,Math.ceil(sorted.length*ratio)-1)].toFixed(3));
};
const clients={alpha:await makeClient("user-perf-alpha"),bravo:await makeClient("user-perf-bravo"),empty:await makeClient("user-perf-empty")};
const catalog=await clients.alpha.listTools();
const tools=catalog.tools;
const toolNames=tools.map(t=>t.name).sort();
const descBytes=tools.reduce((n,t)=>n+Buffer.byteLength(t.description||""),0);
const catalogBytes=Buffer.byteLength(JSON.stringify(catalog));
const snapshot=Object.fromEntries(tools.map(t=>[t.name,{
  inputSchema:t.inputSchema,annotations:t.annotations,outputSchema:t.outputSchema,
}]));
assert.equal(tools.length,65,"MCP catalog must not silently lose tools");
assert.equal(JSON.stringify(snapshot).length,33400,"MCP input schemas and annotations must remain unchanged");
assert.ok(descBytes<=17326,"MCP description bytes should improve at least 20% over 21658 baseline");
const prepareDescription=tools.find(t=>t.name==="learn_prepare")?.description||"";
const putDescription=tools.find(t=>t.name==="learn_put")?.description||"";
assert.match(prepareDescription,/Simulated \/ Not Executed/);
assert.match(prepareDescription,/learn_usage_report/);
assert.match(putDescription,/scannable Markdown/);
assert.match(putDescription,/Never write memory merely because an ordinary MCP tool ran/);
assert.match(putDescription,/Shared Learn requires group proposal and approval/);
const metrics={};
const query={query:"Review Flowly chat-relay performance and coding requirements",projectKey:"chat-relay",phase:"plan"};
try {
  for (const [name,client] of Object.entries(clients)) {
    const wall=[],bytes=[],counts=[],coverage=[],received=[];
    for(let i=0;i<samples+3;i++) {
      const start=performance.now();
      const p=parseResult(await client.callTool({name:"learn_prepare",arguments:query}));
      const elapsed=performance.now()-start;
      assert.ok(p.preparedContext);
      assert.ok(p.preparedContext.coverage);
      const context=p.preparedContext;
      assert.ok(!JSON.stringify(p).includes("SECRET_SAMPLE_DO_NOT_EMIT"));
      if(name==="empty") assert.equal(context.items.length,0);
      else {
        assert.equal(context.coverage.status,"complete",JSON.stringify(context.coverage));
        assert.ok(context.items.some(v=>v.key==="flowly-implementation-workflow"));
        assert.ok(context.items.every(v=>v.content.includes(name==="alpha"?"ALPHA":"BRAVO")));
        assert.ok(p.usageReceiptId);
        assert.ok(context.items.every(v => v.key !== "flowly-implementation-workflow" || !v.contentTruncated), "required rules must not truncate");
        assert.ok(context.items.every(v => v.kind !== "coding_style" || !v.contentTruncated), "coding style must be complete");
      }
      if(i>=3) {
        wall.push(elapsed);bytes.push(Buffer.byteLength(JSON.stringify(p)));
        counts.push(context.items.length);coverage.push(context.coverage.status);received.push(p.usageReceiptId!=null);
      }
    }
    metrics[name]={samples,p50Ms:percentile(wall,.5),p95Ms:percentile(wall,.95),
      p50Bytes:percentile(bytes,.5),p95Bytes:percentile(bytes,.95),
      itemCount:counts[0],coverage:coverage[0],receipt:received[0],
    };
  }
  const compactImplement=parseResult(await clients.alpha.callTool({name:"learn_prepare",arguments:{...query,phase:"implement"}}));
  const compactCoding=compactImplement.preparedContext.items.find(v=>v.kind==="coding_style");
  assert.ok(compactCoding && compactCoding.content.length>420 && !compactCoding.contentTruncated,"default implement must keep full coding standards");
  assert.equal(compactImplement.preparedContext.coverage.status,"complete");
  const p=parseResult(await clients.alpha.callTool({name:"learn_prepare",arguments:{...query,phase:"implement",limit:14}}));
  assert.ok(p.preparedContext.items.some(v=>v.kind==="coding_style"));
  assert.ok(p.preparedContext.items.some(v=>v.key.startsWith("optional-") && v.content.length>420 && !v.contentTruncated),"explicit limit must retain full optional content");
  assert.equal(p.preparedContext.coverage.status,"complete");
  const loaded=p.preparedContext.items.map(x=>x.id);
  const next=parseResult(await clients.alpha.callTool({name:"learn_prepare",arguments:{...query,phase:"test",loadedMemoryIds:loaded}}));
  assert.ok(next.preparedContext.items.every(v=>!loaded.includes(v.id)));
  assert.equal(next.preparedContext.coverage.status,"complete");
  console.log(JSON.stringify({kind:"multiuser-lean-learn-benchmark",version:1,tools:tools.length,
    catalogDescriptionBytes:descBytes,catalogJsonBytes:catalogBytes,
    learnPrepareDescriptionBytes:Buffer.byteLength(tools.find(t=>t.name==="learn_prepare")?.description||""),
    learnPutDescriptionBytes:Buffer.byteLength(tools.find(t=>t.name==="learn_put")?.description||""),
    schemaInventory:toolNames.join(","),schemaFingerprint:JSON.stringify(snapshot).length,
    metrics,phaseSwitch:"pass",distinctUsers:"isolated",usagePrepareCalls:paths.get("user-perf-alpha/usage/prepare")||0,
    excludes:["production Cloudflare network/CPU", "ChatGPT reasoning/connector"]},null,2));
} finally {
  for(const s of sessions){await s.client.close();await s.server.close();}
  for(const db of dbs.values())db.close();
}
