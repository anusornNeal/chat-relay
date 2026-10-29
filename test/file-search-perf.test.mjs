import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { FileManager as Candidate } from "../agent/file-manager.mjs";
const repo=fileURLToPath(new URL("../",import.meta.url));
const workspace=fileURLToPath(new URL("../.workspace/",import.meta.url));
const original=execFileSync("git",["show","v1.4.0:agent/file-manager.mjs"],{cwd:repo,encoding:"utf8"});
const {FileManager:Baseline}=await import("data:text/javascript;base64,"+Buffer.from(original).toString("base64"));
await fs.mkdir(workspace,{recursive:true});
const dir=await fs.mkdtemp(path.join(workspace,"search-perf-"));
const samples=Math.min(60,Math.max(3,Number(process.argv.find(x=>x.startsWith("--samples="))?.split("=")[1]||30)));
const pct=(v,q)=>{const s=[...v].sort((a,b)=>a-b);return Number(s[Math.ceil(s.length*q)-1].toFixed(3))};
const results={baseline:[],candidate:[]};
try{
  for(let folder=0;folder<16;folder++){
    const sub=path.join(dir,"module-"+String(folder).padStart(2,"0"));
    await fs.mkdir(sub);
    for(let file=0;file<100;file++){
      await fs.writeFile(path.join(sub,"source-"+String(file).padStart(3,"0")+".kt"),
        "package perf\nfun value() = "+file+"\n// source code line marker "+folder+"\n");
    }
  }
  const before=new Baseline(dir),after=new Candidate(dir);
  const noHit="PERF_NON_MATCHING_EXACT_MARKER_20261029";
  const run=async(manager)=>manager.startSearch(dir,noHit,"content",500);
  const warm=3;
  for(let i=0;i<samples+warm;i++){
    const sequence=(i%2===0)?[["baseline",before],["candidate",after]]:[["candidate",after],["baseline",before]];
    const compare=[];
    for(const [name,manager] of sequence){
      const start=performance.now();
      const found=await run(manager);
      if(i>=warm)results[name].push(performance.now()-start);
      assert.equal(found.totalResults,0);
      assert.equal(found.incomplete,false);
      assert.equal(found.scanned,1616);
      compare.push([found.status,found.totalResults,found.scanned,found.incomplete,found.stopReason]);
    }
    assert.deepEqual(compare[0],compare[1]);
  }
  const beforeP50=pct(results.baseline,.5),afterP50=pct(results.candidate,.5);
  console.log(JSON.stringify({
    fixtureFiles:1600, scanned:1616, samples, warmups:warm, matcher:"full-miss-content",
    baselineTag:"v1.4.0", baseline:{p50Ms:beforeP50,p95Ms:pct(results.baseline,.95)},
    candidate:{p50Ms:afterP50,p95Ms:pct(results.candidate,.95)},
    improvementPct:Number((100*(1-afterP50/beforeP50)).toFixed(2)),
    parity:true, scope:"identical fixture", platform:process.platform,
  },null,2));
}finally{await fs.rm(dir,{recursive:true,force:true})}
