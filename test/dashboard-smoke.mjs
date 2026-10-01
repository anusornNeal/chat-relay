import WebSocket from "ws";
const base=(process.env.TEST_RELAY_URL||"http://127.0.0.1:8802").replace(/\/$/,"");
const adminToken=process.env.TEST_ADMIN_TOKEN||"test-admin";
async function req(path,opt={}){const r=await fetch(base+path,{redirect:"manual",...opt}),text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}return{response:r,text,data}}
async function admin(path,method="GET",body){return req(path,{method,headers:{authorization:"Bearer "+adminToken,...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)})}
const wsUrl=(path)=>base.replace(/^http/,"ws")+path;
async function expectWsStatus(path,headers,status){await new Promise((resolve,reject)=>{const socket=new WebSocket(wsUrl(path),{headers});const timer=setTimeout(()=>{try{socket.terminate()}catch{};reject(Error("websocket status timeout"))},4000);socket.once("unexpected-response",(_req,res)=>{clearTimeout(timer);try{socket.terminate()}catch{};res.statusCode===status?resolve():reject(Error("websocket status "+res.statusCode))});socket.once("open",()=>{clearTimeout(timer);try{socket.close()}catch{};reject(Error("websocket unexpectedly opened"))});socket.once("error",()=>{})})}
async function openWs(headers){return new Promise((resolve,reject)=>{const socket=new WebSocket(wsUrl("/admin/ws"),{headers});const timer=setTimeout(()=>{try{socket.terminate()}catch{};reject(Error("websocket open timeout"))},5000);socket.once("open",()=>{clearTimeout(timer);resolve(socket)});socket.once("error",reject)})}
function nextJson(socket,predicate,timeout=5000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error("websocket message timeout"))},timeout);const onMessage=(raw)=>{let data;try{data=JSON.parse(String(raw))}catch{return}if(!predicate(data))return;cleanup();resolve(data)};const cleanup=()=>{clearTimeout(timer);socket.off("message",onMessage)};socket.on("message",onMessage)})}
for(const path of ["/","/admin","/dashboard"]){const redirect=await req(path);if(redirect.response.status!==302||!String(redirect.response.headers.get("location")).endsWith("/dashboard/"))throw Error(`dashboard redirect failed: ${path}`)}
const page=await req("/dashboard/");if(!page.response.ok||!page.text.includes("Chat Relay")||!page.text.includes("/dashboard/app.js")||!page.text.includes("userDialog")||!page.text.includes("detailDialog")||!page.text.includes("liveStatus")||!page.text.includes("Realtime updates")||page.text.includes("Refreshes every 5 seconds"))throw Error("dashboard html failed");
const js=await req("/dashboard/app.js");if(!js.response.ok||!js.text.includes("/admin/api/overview")||!js.text.includes("/admin/api/tool-calls")||!js.text.includes("/admin/api/errors")||!js.text.includes("bindDetailRows")||js.text.includes("BKK Â· UTC+7")||!js.text.includes("data-chart-from")||!js.text.includes('state: "all"')||!js.text.includes("item.userId === callFilters.userId")||!js.text.includes("/admin/ws")||!js.text.includes("renderContent(liveMarkup, patch)")||!js.text.includes("fallbackPollTimer = setInterval")||!js.text.includes("PAGE_SIZE = 50")||!js.text.includes("data-running-start")||!js.text.includes("paginationMarkup")||!js.text.includes("Tool invocations")||!js.text.includes("failureStage")||!js.text.includes("Relay health")||!js.text.includes("agentQueueWaitMs")||!js.text.includes("applyToolLifecycle")||!js.text.includes('data?.type === "tool_started" || data?.type === "tool_finished"')||js.text.includes("setInterval(() => loadActive(), 5000)")||js.text.includes("recentLimit=1000")||js.text.includes("ADMIN_TOKEN"))throw Error("dashboard app asset invalid");
if(!js.text.includes('view !== "calls"')||!js.text.includes("clearInterval(runningClockTimer)"))throw Error("running timer lifecycle guard missing");
const css=await req("/dashboard/styles.css");if(!css.response.ok||!css.text.includes("@media")||!css.text.includes("LINE Seed Sans TH")||!css.text.includes(".chart-tooltip")||!css.text.includes(".live-pill"))throw Error("dashboard css invalid");
const protectedRead=await req("/admin/api/overview");if(protectedRead.response.status!==401)throw Error("dashboard API exposed without auth");
await expectWsStatus("/admin/ws",{},401);
const bootstrap=await admin("/admin/bootstrap","POST",{userName:"Owner",agentId:"default",agentName:"Primary PC"});if(!bootstrap.response.ok)throw Error("bootstrap failed");
const suffix=Date.now().toString(36),login="dashboard-"+suffix,password="Dashboard-"+suffix+"-Password!";
const creds=await admin("/admin/users/login","POST",{userId:"owner",login,password});if(!creds.response.ok)throw Error("owner login attach failed");
const auth=await req("/admin/session/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login,password})});if(!auth.response.ok||!auth.data.csrfToken)throw Error("dashboard browser login failed");
const cookie=(auth.response.headers.get("set-cookie")||"").split(";")[0],csrf=auth.data.csrfToken;
await expectWsStatus("/admin/ws",{cookie,origin:"https://evil.example"},403);
const overview=await req("/admin/api/overview",{headers:{cookie}});if(!overview.response.ok||typeof overview.data.users?.total!=="number"||overview.data.period?.timezoneLabel!=="BKK Â· UTC+7"||!Array.isArray(overview.data.buckets)||typeof overview.data.agentHealth?.queued!=="number"||typeof overview.data.agentHealth?.reconnectCount!=="number")throw Error("dashboard overview read failed");
const ws1=await openWs({cookie}),ws2=await openWs({cookie});
await new Promise((resolve)=>setTimeout(resolve,100));
const pushed1=nextJson(ws1,(x)=>x.type==="invalidate"&&x.topics?.includes("users"));
const pushed2=nextJson(ws2,(x)=>x.type==="invalidate"&&x.topics?.includes("users"));
const liveSuffix=Date.now().toString(36);
const liveCreate=await req("/admin/api/users",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({name:"Live "+liveSuffix,login:"live-"+liveSuffix,password:"Live-"+liveSuffix+"-Password!",admin:false})});if(!liveCreate.response.ok)throw Error("dashboard websocket trigger mutation failed");
for(const event of await Promise.all([pushed1,pushed2])){const serialized=JSON.stringify(event);if(!event.topics.includes("overview")||serialized.includes("password")||serialized.includes("command")||serialized.includes("payload"))throw Error("unsafe dashboard websocket event")}

// A user-scoped tool event must reach that user and admins, but not another user dashboard.
async function createScopedUser(label){
  const id="ws-scope-"+label+"-"+Date.now().toString(36);
  const created=await admin("/admin/users","POST",{name:"WS Scope "+label,id});
  if(!created.response.ok||!created.data.token)throw Error("scoped user create failed");
  const login="scope-"+label.toLowerCase()+"-"+Date.now().toString(36);
  const password="Scope-"+label+"-"+Date.now().toString(36)+"-Password!";
  const credentials=await admin("/admin/users/login","POST",{userId:id,login,password});
  if(!credentials.response.ok)throw Error("scoped user credentials failed");
  const grant=await admin("/admin/grants","POST",{userId:id,agentId:"default",scopes:["*"]});
  if(!grant.response.ok)throw Error("scoped user grant failed");
  const browser=await req("/admin/session/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login,password})});
  if(!browser.response.ok)throw Error("scoped browser login failed");
  return {id,token:created.data.token,cookie:(browser.response.headers.get("set-cookie")||"").split(";")[0]};
}
const scopeA=await createScopedUser("A");
const scopeB=await createScopedUser("B");
const userWsA=await openWs({cookie:scopeA.cookie});
const userWsB=await openWs({cookie:scopeB.cookie});
await new Promise((resolve)=>setTimeout(resolve,100));
let leakedToOtherUser=false;
const onOtherUserMessage=(raw)=>{try{const data=JSON.parse(String(raw));if(data?.type==="tool_started"||data?.type==="tool_finished")leakedToOtherUser=true}catch{}};
userWsB.on("message",onOtherUserMessage);
const userScopedStart=nextJson(userWsA,(x)=>x.type==="tool_started"&&x.tool==="whoami");
const adminScopedStart=nextJson(ws1,(x)=>x.type==="tool_started"&&x.tool==="whoami");
const userScopedFinish=nextJson(userWsA,(x)=>x.type==="tool_finished"&&x.tool==="whoami");
const adminScopedFinish=nextJson(ws1,(x)=>x.type==="tool_finished"&&x.tool==="whoami");
const scopedRpc=await req("/mcp?key="+encodeURIComponent(scopeA.token),{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","mcp-session-id":"dashboard-ws-scope"},body:JSON.stringify({jsonrpc:"2.0",id:991,method:"tools/call",params:{name:"whoami",arguments:{secret:"PRIVATE_SCOPE_ARG"}}})});
if(!scopedRpc.response.ok)throw Error("scoped tool call failed");
const [userStart,adminStart,userFinish,adminFinish]=await Promise.all([userScopedStart,adminScopedStart,userScopedFinish,adminScopedFinish]);
if(userStart.toolCallId!==userFinish.toolCallId||adminStart.toolCallId!==adminFinish.toolCallId||userFinish.status!=="success")throw Error("scoped lifecycle transition mismatch");
for(const event of [userStart,adminStart,userFinish,adminFinish]){
  const serialized=JSON.stringify(event);
  if(serialized.includes("PRIVATE_SCOPE_ARG")||serialized.includes("secret")||serialized.includes("arguments")||serialized.includes("payload")||serialized.includes("stdout"))throw Error("unsafe lifecycle websocket event");
}
await new Promise((resolve)=>setTimeout(resolve,250));
userWsB.off("message",onOtherUserMessage);
if(leakedToOtherUser)throw Error("user-scoped websocket lifecycle leaked to another user");
userWsA.terminate();userWsB.terminate();
ws1.terminate();ws2.terminate();
const mutation=await req("/admin/api/sessions/revoke",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({userId:"owner"})});if(!mutation.response.ok)throw Error("dashboard mutation failed");
const oauthMeta=await req("/.well-known/oauth-authorization-server");if(!oauthMeta.response.ok||!oauthMeta.data.authorization_endpoint)throw Error("dashboard assets shadowed oauth");
const mcp=await req("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});if(mcp.response.status!==401)throw Error("dashboard assets shadowed MCP auth");
console.log("dashboard smoke test passed");
