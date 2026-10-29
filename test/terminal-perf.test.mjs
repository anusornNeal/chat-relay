import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TerminalManager } from "../agent/terminal-manager.mjs";

const cwd = fileURLToPath(new URL("../",import.meta.url));
const windows=process.platform==="win32";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function finish(manager,id,timeoutMs=8000){
 const start=Date.now();
 while(Date.now()-start<timeoutMs){
  const result=manager.read(id,0,8192);
  if(result.status!=="running")return result;
  await sleep(50);
 }
 throw new Error("terminal_session_did_not_exit");
}
test("long job uses terminal session and reports output/exit without exec timeout",async()=>{
 const manager=new TerminalManager({fastExec:false});
 try{
  const cmd=windows
   ? "Start-Sleep -Milliseconds 700; Write-Output RELAY_SESSION_JOB_OK"
   : "sleep 0.7; echo RELAY_SESSION_JOB_OK";
  const session=manager.start(cmd,cwd);
  assert.equal(session.status,"running");
  assert.ok(session.sessionId);
  const finished=await finish(manager,session.sessionId);
  assert.equal(finished.status,"exited");
  assert.equal(finished.exitCode,0);
  assert.ok(finished.chunks.some(x=>x.text.includes("RELAY_SESSION_JOB_OK")));
  const after=manager.read(session.sessionId,finished.nextSeq);
  assert.equal(after.chunks.length,0);
 }finally{manager.close()}
});
test("short commands run in bounded exec mode without session allocation",async()=>{
 const manager=new TerminalManager({fastExec:true});
 try{
  for(let i=0;i<2;i++){
   const result=await manager.exec(windows?"Write-Output RELAY_EXEC_OK":"echo RELAY_EXEC_OK",cwd,5000);
   assert.equal(result.ok,true);
   assert.equal(result.exitCode,0);
   assert.match(result.stdout,/RELAY_EXEC_OK/);
  }
  assert.equal(manager.list().length,0);
 }finally{manager.close()}
});
