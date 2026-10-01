const base=(process.env.TEST_RELAY_URL||"http://127.0.0.1:8802").replace(/\/$/,"");
const adminToken=process.env.TEST_ADMIN_TOKEN||"test-admin";
async function req(path,opt={}){const r=await fetch(base+path,{redirect:"manual",...opt}),text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}return{response:r,text,data}}
async function admin(path,method="GET",body){return req(path,{method,headers:{authorization:"Bearer "+adminToken,...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)})}
for(const path of ["/","/admin","/dashboard"]){const redirect=await req(path);if(redirect.response.status!==302||!String(redirect.response.headers.get("location")).endsWith("/dashboard/"))throw Error(`dashboard redirect failed: ${path}`)}
const page=await req("/dashboard/");if(!page.response.ok||!page.text.includes("Chat Relay")||!page.text.includes("/dashboard/app.js")||!page.text.includes("userDialog")||!page.text.includes("detailDialog"))throw Error("dashboard html failed");
const js=await req("/dashboard/app.js");if(!js.response.ok||!js.text.includes("/admin/api/overview")||!js.text.includes("/admin/api/tool-calls")||!js.text.includes("/admin/api/errors")||!js.text.includes("bindDetailRows")||!js.text.includes("BKK · UTC+7")||!js.text.includes("data-chart-from")||!js.text.includes('state: "all"')||js.text.includes("recentLimit=1000")||!js.text.includes("5000")||js.text.includes("ADMIN_TOKEN"))throw Error("dashboard app asset invalid");
const css=await req("/dashboard/styles.css");if(!css.response.ok||!css.text.includes("@media")||!css.text.includes("LINE Seed Sans TH")||!css.text.includes(".chart-tooltip"))throw Error("dashboard css invalid");
const protectedRead=await req("/admin/api/overview");if(protectedRead.response.status!==401)throw Error("dashboard API exposed without auth");
const bootstrap=await admin("/admin/bootstrap","POST",{userName:"Owner",agentId:"default",agentName:"Primary PC"});if(!bootstrap.response.ok)throw Error("bootstrap failed");
const suffix=Date.now().toString(36),login="dashboard-"+suffix,password="Dashboard-"+suffix+"-Password!";
const creds=await admin("/admin/users/login","POST",{userId:"owner",login,password});if(!creds.response.ok)throw Error("owner login attach failed");
const auth=await req("/admin/session/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login,password})});if(!auth.response.ok||!auth.data.csrfToken)throw Error("dashboard browser login failed");
const cookie=(auth.response.headers.get("set-cookie")||"").split(";")[0],csrf=auth.data.csrfToken;
const overview=await req("/admin/api/overview",{headers:{cookie}});if(!overview.response.ok||typeof overview.data.users?.total!=="number"||overview.data.period?.timezoneLabel!=="BKK · UTC+7"||!Array.isArray(overview.data.buckets))throw Error("dashboard overview read failed");
const mutation=await req("/admin/api/sessions/revoke",{method:"POST",headers:{cookie,"x-csrf-token":csrf,origin:base,"content-type":"application/json"},body:JSON.stringify({userId:"owner"})});if(!mutation.response.ok)throw Error("dashboard mutation failed");
const oauthMeta=await req("/.well-known/oauth-authorization-server");if(!oauthMeta.response.ok||!oauthMeta.data.authorization_endpoint)throw Error("dashboard assets shadowed oauth");
const mcp=await req("/mcp",{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})});if(mcp.response.status!==401)throw Error("dashboard assets shadowed MCP auth");
console.log("dashboard smoke test passed");
