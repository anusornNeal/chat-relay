import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileManager } from "../agent/file-manager.mjs";

const repo=fileURLToPath(new URL("../",import.meta.url));
const codePath=path.join(repo,"src","worker-app.ts");
function contractBlock(text,name) {
  const server=text.indexOf("export function createMcpServer(");
  const start=text.indexOf('"'+name+'",',server);
  assert.ok(start>=0, "missing tool "+name);
  return text.slice(start,start+700);
}
test("MCP descriptions direct independent reads to existing batch tools",async()=>{
 const code=await fs.readFile(codePath,"utf8");
 const read=contractBlock(code,"read_file");
 const many=contractBlock(code,"read_multiple_files");
 const batch=contractBlock(code,"fs_batch");
 const exec=contractBlock(code,"terminal_exec");
 const long=contractBlock(code,"terminal_start");
 assert.match(read,/read_multiple_files or fs_batch/);
 assert.match(many,/one MCP call/);
 assert.match(batch,/one MCP call/);
 assert.match(batch,/Per-item errors isolated/);
 assert.match(exec,/terminal_start \+ terminal_read/);
 assert.match(exec,/20s/);
 assert.match(exec,/executionStatus=unknown/);
 assert.match(long,/>20s/);
});

test("fs_batch returns equal data with isolated errors and bounded exact ordering",async()=>{
 const workspace=path.join(repo,".workspace");
 await fs.mkdir(workspace,{recursive:true});
 const root=await fs.mkdtemp(path.join(workspace,"batch-contract-"));
 try{
  const paths=[];
  for(let i=0;i<8;i++){
   const name=path.join(root,"item-"+i+".kt");
   await fs.writeFile(name,"first\nvalue"+i+"\n");
   paths.push(name);
  }
  const manager=new FileManager(root);
  const originals=await Promise.all(paths.map(p=>manager.read(p,0,4)));
  const batch=await manager.batch(paths.map((p,i)=>({id:String(i),op:"read",path:p,offset:0,length:4})));
  assert.equal(batch.results.length,8);
  assert.equal(batch.nextIndex,null);
  assert.deepEqual(batch.results.map(x=>x.result.content),originals.map(x=>x.content));
  assert.deepEqual(batch.results.map(x=>x.id),paths.map((_,i)=>String(i)));
  const forbidden=await manager.batch([
   {id:"valid",op:"read",path:paths[0],length:4},
   {id:"forbidden",op:"read",path:path.join(root,"..","does-not-exist.txt")},
   {id:"following",op:"stat",path:paths[1]},
  ]);
  assert.equal(forbidden.results.length,3);
  assert.equal(forbidden.results[0].ok,true);
  assert.equal(forbidden.results[1].ok,false);
  assert.equal(forbidden.results[2].ok,true);
  const many=await manager.readMany(paths.map(p=>({path:p,offset:0,length:4})));
  assert.deepEqual(many.files.map(f=>f.content),originals.map(x=>x.content));
  await assert.rejects(manager.batch(Array.from({length:21},()=>({op:"stat",path:paths[0]}))),/invalid_batch/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
