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
const page=await req("/dashboard/");if(!page.response.ok||!page.text.includes("Chat Relay")||!page.text.includes("/dashboard/app.js")||page.text.includes("detailDialog")||!page.text.includes("liveStatus")||!page.text.includes("Realtime updates")||!page.text.includes("/admin/google/start")||page.text.includes("userDialog")||page.text.includes("Sign in with password")||page.text.includes("Refreshes every 5 seconds"))throw Error("dashboard html failed");
const js=await req("/dashboard/app.js");
if(!js.response.ok||!js.text.includes("/admin/api/summary")||!js.text.includes("/admin/api/overview")||!js.text.includes("/admin/api/learn")||!js.text.includes("My Learn")||!js.text.includes("loadLearn")||!js.text.includes("learn-folder-shell")||!js.text.includes("learn-tree-row")||!js.text.includes('role="radiogroup"')||!js.text.includes("Folder view")||!js.text.includes("Useful")||!js.text.includes("Not useful")||!js.text.includes("Remove memory")||js.text.includes("Recent Learn changes")||!js.text.includes('activeView !== "learn"')||!js.text.includes("System overview")||!js.text.includes("Usage")||!js.text.includes("loadUsage")||!js.text.includes("Tool calls by account and agent")||!js.text.includes("account-agent-grid")||!js.text.includes("agent-usage-count")||js.text.includes("Top tools")||!js.text.includes("Operational error rate")||js.text.includes("/admin/api/errors")||js.text.includes("loadErrors")||js.text.includes("/admin/api/tool-calls")||!js.text.includes("/admin/ws")||!js.text.includes("fallbackPollTimer = setInterval")||js.text.includes("ADMIN_TOKEN"))throw Error("dashboard app asset invalid");
if(!page.text.includes('id="loginError"'))throw Error("dashboard login recovery status missing");
if(!js.text.includes("API_TIMEOUT_MS = 12000")||!js.text.includes("request_timeout")||!js.text.includes("scheduleDataRetry")||!js.text.includes("refreshActiveIncrementally({ initial: true })"))throw Error("dashboard load recovery guards missing");
const liveStartAt=js.text.lastIndexOf("startLiveChannel();"),initialLoadAt=js.text.lastIndexOf("refreshActiveIncrementally({ initial: true });");if(liveStartAt<0||initialLoadAt<0||liveStartAt>initialLoadAt)throw Error("dashboard realtime must start before initial data load");
const css=await req("/dashboard/styles.css");if(!css.response.ok||!css.text.includes("@media")||!css.text.includes("LINE Seed Sans TH")||!css.text.includes(".account-agent-grid")||!css.text.includes(".agent-usage-row")||!css.text.includes(".live-pill")||!css.text.includes(".learn-folder-shell")||!css.text.includes(".learn-folder-tree")||!css.text.includes(".learn-detail-pane")||!css.text.includes(".learn-folder-workspace")||!css.text.includes(".learn-tree-row"))throw Error("dashboard css invalid");
const protectedRead=await req("/admin/api/overview");if(protectedRead.response.status!==401)throw Error("dashboard API exposed without auth");
await expectWsStatus("/admin/ws",{},401);
const bootstrap=await admin("/admin/bootstrap","POST",{userName:"Owner",agentId:"default",agentName:"Primary PC"});if(!bootstrap.response.ok)throw Error("bootstrap failed");
const suffix=Date.now().toString(36),login="dashboard-"+suffix,password="Dashboard-"+suffix+"-Password!";
const creds=await admin("/admin/users/login","POST",{userId:"owner",login,password});if(!creds.response.ok)throw Error("owner login attach failed");
const auth=await req("/admin/session/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login,password})});if(!auth.response.ok||!auth.data.csrfToken)throw Error("dashboard browser login failed");
const cookie=(auth.response.headers.get("set-cookie")||"").split(";")[0],csrf=auth.data.csrfToken;
await expectWsStatus("/admin/ws",{cookie,origin:"https://evil.example"},403);
const summary=await req("/admin/api/summary",{headers:{cookie}});if(!summary.response.ok||summary.data.role!=="admin"||!summary.data.period||!summary.data.users||!summary.data.agents)throw Error("dashboard summary read failed");
const overview=await req("/admin/api/overview",{headers:{cookie}});if(!overview.response.ok||overview.data.period?.timezoneLabel!=="BKK · UTC+7"||!Array.isArray(overview.data.accounts)||!overview.data.accounts.some((account)=>account.userId==="owner"&&Array.isArray(account.agents)&&account.agents.some((agent)=>agent.agentId==="default")))throw Error("dashboard overview read failed");
const learnEmpty=await req("/admin/api/learn",{headers:{cookie}});if(!learnEmpty.response.ok||!Array.isArray(learnEmpty.data.items)||learnEmpty.data.activity!==undefined)throw Error("dashboard Learn profile read failed");
const learnPut=await req("/admin/api/learn/put",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({key:"dashboard-smoke",kind:"work_style",scope:"global",content:"Prefer bounded low-overhead Learn updates",confidence:91})});if(!learnPut.response.ok||learnPut.data.changed!==true)throw Error("dashboard Learn put failed");
const learnProfile=await req("/admin/api/learn",{headers:{cookie}});const learnItem=(learnProfile.data.items||[]).find((item)=>item.key==="dashboard-smoke");if(!learnProfile.response.ok||!learnItem||learnProfile.data.summary?.byKind?.work_style<1||learnProfile.data.activity!==undefined)throw Error("dashboard Learn profile missing stored memory");
const learnPositive=await req("/admin/api/learn/feedback",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({id:learnItem.id,value:"positive"})});if(!learnPositive.response.ok||learnPositive.data.item?.positiveFeedback!==1||learnPositive.data.item?.negativeFeedback!==0)throw Error("dashboard Learn positive radio feedback failed");
const learnNegative=await req("/admin/api/learn/feedback",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({id:learnItem.id,value:"negative"})});if(!learnNegative.response.ok||learnNegative.data.item?.positiveFeedback!==0||learnNegative.data.item?.negativeFeedback!==1)throw Error("dashboard Learn negative radio feedback failed");
const learnNegativeAgain=await req("/admin/api/learn/feedback",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({id:learnItem.id,value:"negative"})});if(!learnNegativeAgain.response.ok||learnNegativeAgain.data.changed!==false)throw Error("dashboard Learn radio feedback must be idempotent");
const learnDelete=await req("/admin/api/learn/delete",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({id:learnItem.id})});if(!learnDelete.response.ok||learnDelete.data.deleted!==true)throw Error("dashboard Learn delete failed");
const users=await req("/admin/api/users?limit=100",{headers:{cookie}});const ownerRow=(users.data.items||[]).find((item)=>item.id==="owner");if(!users.response.ok||!ownerRow||!Array.isArray(ownerRow.assignedAgents)||!ownerRow.assignedAgents.some((agent)=>agent.id==="default"&&agent.name))throw Error("dashboard assigned agents missing");
const ws1=await openWs({cookie}),ws2=await openWs({cookie});
await new Promise((resolve)=>setTimeout(resolve,100));
const pushed1=nextJson(ws1,(x)=>x.type==="invalidate"&&x.topics?.includes("users"));
const pushed2=nextJson(ws2,(x)=>x.type==="invalidate"&&x.topics?.includes("users"));
const liveSuffix=Date.now().toString(36);
const liveCreate=await admin("/admin/users","POST",{name:"Live "+liveSuffix});if(!liveCreate.response.ok)throw Error("dashboard websocket trigger mutation failed");
for(const event of await Promise.all([pushed1,pushed2])){const serialized=JSON.stringify(event);if(!event.topics.includes("overview")||serialized.includes("password")||serialized.includes("command")||serialized.includes("payload"))throw Error("unsafe dashboard websocket event")}

// A user-scoped aggregate invalidation must reach that user and admins, but not another user dashboard.
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
let leakedAggregate=false;
const onOtherUserMessage=(raw)=>{try{const data=JSON.parse(String(raw));if(data?.type==="invalidate"&&data.topics?.includes("overview"))leakedAggregate=true}catch{}};
userWsB.on("message",onOtherUserMessage);
const userAggregate=nextJson(userWsA,(x)=>x.type==="invalidate"&&x.topics?.includes("overview"));
const adminAggregate=nextJson(ws1,(x)=>x.type==="invalidate"&&x.topics?.includes("overview"));
const scopedRpc=await req("/mcp?key="+encodeURIComponent(scopeA.token),{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","mcp-session-id":"dashboard-ws-scope"},body:JSON.stringify({jsonrpc:"2.0",id:991,method:"tools/call",params:{name:"ping_agent",arguments:{agentId:"default",secret:"PRIVATE_SCOPE_ARG"}}})});
if(!scopedRpc.response.ok)throw Error("scoped tool call failed");
const summaryAfterTool=await admin("/admin/api/summary");
if(!summaryAfterTool.response.ok||!summaryAfterTool.data.topTools?.some((item)=>item.tool==="ping_agent"&&item.calls>=1)||!summaryAfterTool.data.buckets?.length||summaryAfterTool.data.detailSampleSize<1)throw Error("dashboard rich overview aggregates missing");
await Promise.all([userAggregate,adminAggregate]);
await new Promise((resolve)=>setTimeout(resolve,250));
userWsB.off("message",onOtherUserMessage);
if(leakedAggregate)throw Error("user-scoped aggregate invalidation leaked to another user");
userWsA.terminate();userWsB.terminate();
ws1.terminate();ws2.terminate();
const mutation=await req("/admin/api/sessions/revoke",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({userId:"owner"})});if(!mutation.response.ok)throw Error("dashboard mutation failed");
const oauthMeta=await req("/.well-known/oauth-authorization-server");if(!oauthMeta.response.ok||!oauthMeta.data.authorization_endpoint)throw Error("dashboard assets shadowed oauth");
const mcp=await req("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});if(mcp.response.status!==401)throw Error("dashboard assets shadowed MCP auth");
console.log("dashboard smoke test passed");
