import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { provisionOperatorFixture } from "./operator-fixture.mjs";

const base=(process.env.TEST_RELAY_URL||"").replace(/\/$/,"");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
 throw new Error("Preflight integration requires TEST_RELAY_URL on 127.0.0.1, not production");
}
const unique=randomUUID().slice(0,8);
const creds=await provisionOperatorFixture(base,{userId:"preflight-"+unique,name:"Preflight Test",agentId:"preflight-"+unique,agentName:"Preflight Test Agent"});
const endpoint=base+"/mcp?key="+encodeURIComponent(creds.userToken);
const sessionId="preflight-live-"+unique;
let nextId=0;
async function call(name,args){
 const response=await fetch(endpoint,{
  method:"POST",
  headers:{"content-type":"application/json","accept":"application/json, text/event-stream"},
  body:JSON.stringify({jsonrpc:"2.0",id:++nextId,method:"tools/call",params:{
   name,arguments:args,_meta:{"openai/session":sessionId}
  }}),
 });
 const body=await response.text();
 if(!response.ok)throw new Error("MCP HTTP error "+response.status);
 const line=body.split(/\r?\n/).find(x=>x.startsWith("data: "));
 const json=JSON.parse(line?line.slice(6):body);
 assert.ok(json.result,"MCP result required: "+name);
 const content=json.result.content?.find(x=>x.type==="text");
 assert.ok(content,"text tool content required: "+name);
 return JSON.parse(content.text);
}
const agent=creds.agent.id;
const request={agentId:agent};
for(let i=0;i<3;i++){
 const blocked=await call("get_config",request);
 assert.equal(blocked.error,"learn_prepare_required","Unprepared repeated calls must never bypass gate");
 assert.equal(blocked.scope,"global");
}
const prepared=await call("learn_prepare",{query:"inspect chat-relay local agent",phase:"read",projectKey:"chat-relay",agentId:agent,cwd:"C:\\Users\\tatar\\Projects\\chat-relay"});
assert.equal(prepared.mode!==undefined,true);
const after=await call("get_config",request);
assert.notEqual(after.error,"learn_prepare_required","Valid global preparation must unblock");
const switched=await call("stat_path",{agentId:agent,path:"C:\\Users\\tatar\\Projects\\flowly\\README.md"});
assert.equal(switched.error,"learn_prepare_required","Switching project must require new scoped preparation");
assert.equal(switched.scope,"project:flowly");
const newPrepared=await call("learn_prepare",{query:"inspect Flowly source via same agent",phase:"read",projectKey:"flowly",agentId:agent,cwd:"C:\\Users\\tatar\\Projects\\flowly"});
assert.ok(newPrepared.preparedContext);
const afterSwitch=await call("stat_path",{agentId:agent,path:"C:\\Users\\tatar\\Projects\\flowly\\README.md"});
assert.notEqual(afterSwitch.error,"learn_prepare_required");
console.log(JSON.stringify({kind:"learn-preflight-local-integration",blockedCalls:3,allBlocked:true,globalPrepared:true,scopeSwitchBlocked:true,scopePrepared:true,agentConnected:false},null,2));
