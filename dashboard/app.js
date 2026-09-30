let csrf = "";
let currentUser = null;
let activeView = "overview";
let callTab = "active";
let pollTimer = null;
let pendingDeleteUser = null;

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtNum = (v) => new Intl.NumberFormat().format(Number(v || 0));
const fmtMs = (v) => Number(v || 0) >= 1000 ? (Number(v)/1000).toFixed(1)+"s" : Math.round(Number(v||0))+" ms";
const age = (iso) => {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "-";
  if (ms < 60000) return Math.max(0, Math.floor(ms/1000))+"s";
  if (ms < 3600000) return Math.floor(ms/60000)+"m";
  if (ms < 86400000) return Math.floor(ms/3600000)+"h";
  return Math.floor(ms/86400000)+"d";
};
const humanTool = (tool) => ({
  terminal_exec:"Running command", terminal_start:"Command session", terminal_start_shell:"Interactive shell",
  terminal_batch_start:"Terminal batch", read_file:"Read source file", read_multiple_files:"Read source files",
  list_directory:"List directory", write_file:"Write file", edit_block:"Edit file", screenshot:"Capture desktop"
}[tool] || String(tool || "").replaceAll("_"," "));

const detailRecords = new Map();
let detailSeq = 0;
const SAFE_DETAIL_KEYS = ["userId","tool","agentId","activityId","toolCallId","timestamp","startedAt","durationMs","statusCode","exitCode","errorClass","requestBytes","responseBytes","ok"];
function registerDetail(event){
  const safe={};
  for(const key of SAFE_DETAIL_KEYS) if(event?.[key] !== undefined) safe[key]=event[key];
  const id="detail-"+(++detailSeq); detailRecords.set(id,safe); return id;
}
function showDetail(id,title="Safe metadata"){
  const data=detailRecords.get(id); if(!data)return;
  $("detailTitle").textContent=title;
  $("detailBody").innerHTML=Object.entries(data).map(([key,value])=>'<div class="list-row"><span class="secondary-text">'+esc(key)+'</span><strong class="'+((key.endsWith("Id"))?"mono":"")+'">'+esc(value)+'</strong></div>').join("");
  $("detailDialog").showModal();
}
function bindDetailRows(){
  document.querySelectorAll("[data-detail-id]").forEach(row=>{ row.tabIndex=0; row.onclick=()=>showDetail(row.dataset.detailId,row.dataset.detailTitle||"Safe metadata"); row.onkeydown=(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();row.click();}};});
}
function bindTableFilter(inputId){
  const input=$(inputId); if(!input)return;
  input.oninput=()=>{const q=input.value.trim().toLowerCase(); document.querySelectorAll("[data-filter-row]").forEach(row=>{row.hidden=q && !row.textContent.toLowerCase().includes(q);});};
}

async function api(path, options={}) {
  const headers = {...(options.headers || {})};
  if (options.method && options.method !== "GET") {
    headers["content-type"] = "application/json";
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const response = await fetch(path,{...options,headers,credentials:"same-origin"});
  const text = await response.text();
  let data={}; try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if (response.status === 401) { signOutUi("Session expired. Sign in again."); throw new Error("unauthorized"); }
  if (!response.ok) throw new Error(data.error || "HTTP "+response.status);
  return data;
}

function signOutUi(message="") {
  clearInterval(pollTimer); pollTimer=null; csrf=""; currentUser=null;
  $("appView").hidden=true; $("loginView").hidden=false; $("loginError").textContent=message;
}
function setNotice(message="", error=false) {
  const node=$("notice"); node.hidden=!message; node.textContent=message;
  node.style.borderColor=error?"#edcaca":""; node.style.background=error?"#fff2f2":"";
}
function touchFreshness(){ $("freshness").textContent="Updated just now"; }
function isAdmin(){ return currentUser?.admin === true; }

function navItems(){
  return isAdmin()
    ? [["overview","Overview","⌂"],["calls","Tool Calls","⌁"],["users","Users","♙"],["errors","Errors","!"]]
    : [["overview","My Overview","⌂"],["calls","My Tool Calls","⌁"]];
}
function renderNav(){
  $("nav").innerHTML=navItems().map(([id,label,icon]) =>
    '<button class="nav-button '+(activeView===id?"active":"")+'" data-view="'+id+'"><span>'+icon+'</span> <span class="nav-label">'+label+'</span></button>'
  ).join("");
  document.querySelectorAll("[data-view]").forEach((b)=>b.onclick=()=>switchView(b.dataset.view));
}
function setHeader(title,subtitle){
  $("eyebrow").textContent=isAdmin()?"Admin":"User";
  $("pageTitle").textContent=title; $("pageSubtitle").textContent=subtitle;
}
function showLoading(){
  $("content").innerHTML='<div class="panel"><div class="skeleton" style="width:180px"></div><div class="metric-grid" style="margin-top:18px">'+
    Array.from({length:4},()=>'<div class="metric"><div class="skeleton"></div><div class="skeleton" style="height:54px;margin-top:14px"></div></div>').join("")+
    '</div><div class="skeleton" style="height:240px;margin-top:14px"></div></div>';
}
async function switchView(view){
  if (!navItems().some(([id])=>id===view)) view="overview";
  activeView=view; renderNav(); showLoading(); await loadActive();
}
async function loadActive(){
  setNotice("");
  try{
    if(activeView==="overview") await loadOverview();
    else if(activeView==="calls") await loadCalls();
    else if(activeView==="users") await loadUsers();
    else if(activeView==="errors") await loadErrors();
    touchFreshness();
  }catch(e){ if(e.message!=="unauthorized"){setNotice("Dashboard data is temporarily unavailable. Retrying automatically in 5 seconds.",true);} }
}
function metricCard(label,value,meta=""){return '<div class="metric"><div class="metric-label">'+esc(label)+'</div><div class="metric-value">'+esc(value)+'</div><div class="metric-meta">'+esc(meta)+'</div></div>'}

async function loadOverview(){
  setHeader(isAdmin()?"System overview":"My overview", isAdmin()?"Last 24 hours across Chat Relay":"Your usage for the last 24 hours");
  const [data,usage]=await Promise.all([api("/admin/api/overview"),api("/admin/api/usage?recentLimit=1000")]);
  const m=data.usage || {};
  const cards=[
    metricCard(isAdmin()?"Tool calls":"My tool calls",fmtNum(m.calls),"rolling 24 hours"),
    metricCard(isAdmin()?"Active terminals":"My active terminals",fmtNum(data.activeTerminals),"sessions and running batch jobs"),
    metricCard("Avg / p95 latency",fmtMs(m.avgDurationMs)+" / "+fmtMs(m.p95DurationMs),"rolling 24 hours"),
    metricCard(isAdmin()?"Error rate":"My error rate",((m.errorRate||0)*100).toFixed(1)+"%",fmtNum(m.errors)+" failed calls"),
  ];
  if(isAdmin()){
    cards.push(metricCard("Online agents",(data.agents?.online||0)+" / "+(data.agents?.total||0),"connected agents"));
    cards.push(metricCard("Active users",fmtNum(data.activeUsers ?? data.users?.enabled),"enabled users"));
  }
  const recent=Array.isArray(usage.recent)?usage.recent:[];
  const buckets=Array.from({length:24},()=>0), now=Date.now();
  const counts=new Map();
  for(const e of recent){
    const h=Math.floor((now-Date.parse(e.timestamp))/3600000);
    if(h>=0&&h<24)buckets[23-h]++;
    counts.set(e.tool,(counts.get(e.tool)||0)+1);
  }
  const max=Math.max(1,...buckets);
  const chart=buckets.map(v=>'<div class="bar" title="'+v+' calls" style="height:'+Math.max(3,(v/max)*100)+'%"></div>').join("");
  const top=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
  $("content").innerHTML='<div class="toolbar"><div class="tabs"><button class="tab-button active">24h</button></div><span class="soft-pill">'+(isAdmin()?"System-wide metadata only":"Only your activity is visible")+'</span></div>'+
    '<div class="metric-grid">'+cards.join("")+'</div><div class="layout-2"><div class="panel"><div class="panel-title">Usage trend</div><div class="chart">'+chart+'</div></div>'+
    '<div class="panel"><div class="panel-title">Top tools</div><div class="list">'+(top.length?top.map(([tool,count])=>'<div class="list-row"><div><div class="primary-text">'+esc(tool)+'</div><div class="secondary-text">'+esc(humanTool(tool))+'</div></div><strong>'+count+'</strong></div>').join(""):'<p class="secondary-text">No tool calls yet.</p>')+'</div></div></div>';
}

function callToolbar(){
  return '<div class="toolbar"><div class="tabs"><button class="tab-button '+(callTab==="active"?"active":"")+'" data-call-tab="active">Active</button><button class="tab-button '+(callTab==="history"?"active":"")+'" data-call-tab="history">History</button></div><div class="filter-group"><input id="toolSearch" placeholder="Filter tool, agent, activity"><span class="soft-pill">No commands, arguments, payloads, or output stored</span></div></div>';
}
async function loadCalls(){
  setHeader(isAdmin()?"Tool calls":"My tool calls",callTab==="active"?"Live work and terminal activity":"Safe metadata retained for 30 days");
  const data=await api("/admin/api/tool-calls?state="+callTab+"&limit=100");
  let body="";
  if(callTab==="active"){
    const items=Array.isArray(data.items)?data.items:[];
    const terminals=(data.terminals||[]).flatMap((agent)=>
      [...(agent.sessions||[]).map(s=>({...s,agentId:agent.agentId,kind:"session"})),
       ...(agent.batches||[]).map(b=>({...b,agentId:agent.agentId,kind:"batch"}))]
    );
    const groups=new Map();
    for(const item of items){
      const key=item.activityId||"ungrouped";
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(item);
    }
    body=[...groups.entries()].map(([activity,events])=>'<div class="activity-card"><div class="activity-head"><div><div class="primary-text">'+esc(activity==="ungrouped"?"Ungrouped activity":activity)+'</div><div class="secondary-text">'+esc(events[0]?.userId||"")+" · "+events.length+' active call'+(events.length===1?"":"s")+'</div></div><span class="status-pill '+(activity==="ungrouped"?"warn":"ok")+'">'+(activity==="ungrouped"?"Ungrouped":"Active")+'</span></div><div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Tool</th><th>State</th><th>Agent</th><th>Running</th><th>Call ID</th></tr></thead><tbody>'+events.map(e=>{const detailId=registerDetail(e);return '<tr data-filter-row data-detail-id="'+detailId+'" data-detail-title="Active tool call"><td>'+esc(e.tool)+'</td><td>'+esc(humanTool(e.tool))+'</td><td>'+esc(e.agentId||"-")+'</td><td>'+esc(age(e.startedAt))+'</td><td class="mono">'+esc(e.toolCallId||"-")+'</td></tr>'}).join("")+'</tbody></table></div></div>').join("");
    if(terminals.length) body += '<div class="panel"><div class="panel-title">Terminal sessions and batches</div><div class="list">'+terminals.map(t=>'<div class="list-row"><div><div class="primary-text">'+esc(t.kind==="batch"?"Terminal batch":t.type==="shell"?"Interactive shell":"Command session")+'</div><div class="secondary-text">'+esc(t.agentId)+' · '+esc(t.activityId||"Ungrouped")+' · '+esc(t.sessionId||t.batchId)+'</div></div><span class="status-pill '+((t.status==="running"||!t.endedAt)?"ok":"")+'">'+esc(t.status||(!t.endedAt?"Active":"Ended"))+'</span></div>').join("")+'</div></div>';
    if(!body) body='<div class="empty-state"><div><div class="empty-icon">0</div><h2>No active tool calls</h2><p class="subtitle">New activity will appear here on the next 5-second refresh.</p></div></div>';
  }else{
    const items=Array.isArray(data.items)?data.items:[];
    body='<div class="table-wrap"><table><thead><tr><th>Time</th>'+ (isAdmin()?'<th>User</th>':'') +'<th>Activity</th><th>Tool</th><th>Agent</th><th>Duration</th><th>Result</th></tr></thead><tbody>'+
      (items.length?items.map(e=>{const detailId=registerDetail(e);return '<tr data-filter-row data-detail-id="'+detailId+'" data-detail-title="Tool call detail"><td>'+esc(new Date(e.timestamp).toLocaleString())+'</td>'+(isAdmin()?'<td>'+esc(e.userId)+'</td>':'')+'<td>'+esc(e.activityId||"Ungrouped")+'</td><td>'+esc(e.tool)+'</td><td>'+esc(e.agentId||"-")+'</td><td>'+esc(fmtMs(e.durationMs))+'</td><td><span class="status-pill '+(e.ok?"ok":"bad")+'">'+(e.ok?"Success":"Error")+'</span></td></tr>'}).join(""):'<tr><td colspan="7">No tool-call history yet.</td></tr>')+'</tbody></table></div>';
  }
  $("content").innerHTML=callToolbar()+body;
  document.querySelectorAll("[data-call-tab]").forEach(b=>b.onclick=async()=>{callTab=b.dataset.callTab;showLoading();await loadCalls()});
  bindDetailRows(); bindTableFilter("toolSearch");
}

async function loadUsers(){
  if(!isAdmin())return switchView("overview");
  setHeader("Users","Create, soft-delete, and restore access without losing history");
  const data=await api("/admin/api/users?limit=100");
  const rows=(data.items||[]).map(u=>'<tr><td><div class="primary-text">'+esc(u.name)+'</div><div class="secondary-text">'+esc(u.login||u.id)+'</div></td><td>'+esc(u.admin?"Admin":"User")+'</td><td><span class="status-pill '+(u.enabled?"ok":"")+'">'+(u.deletedAt?"Deleted":u.enabled?"Enabled":"Disabled")+'</span></td><td>'+esc(u.createdAt?new Date(u.createdAt).toLocaleDateString():"-")+'</td><td>'+ (u.id===currentUser.id?'<span class="secondary-text">Current user</span>':u.deletedAt?'<button class="button" data-restore="'+esc(u.id)+'">Restore</button>':'<button class="button danger" data-delete="'+esc(u.id)+'" data-name="'+esc(u.name)+'">Soft delete</button>') +'</td></tr>').join("");
  $("content").innerHTML='<div class="toolbar"><input id="userSearch" placeholder="Search users"><button id="addUser" class="button primary">Add user</button></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>'+ (rows||'<tr><td colspan="5">No users.</td></tr>') +'</tbody></table></div>';
  $("addUser").onclick=()=>{$("userForm").reset();$("userFormError").textContent="";$("userDialog").showModal()};
  document.querySelectorAll("[data-delete]").forEach(b=>b.onclick=()=>{pendingDeleteUser=b.dataset.delete;$("confirmCopy").textContent="Delete "+b.dataset.name+"?";$("confirmDialog").showModal()});
  document.querySelectorAll("[data-restore]").forEach(b=>b.onclick=async()=>{await api("/admin/api/users/restore",{method:"POST",body:JSON.stringify({userId:b.dataset.restore})});await loadUsers()});
}

async function loadErrors(){
  if(!isAdmin())return switchView("overview");
  setHeader("Errors","Safe debug metadata only — no commands, arguments, payloads, or output");
  const data=await api("/admin/api/errors?limit=100");
  const items=data.items||[];
  $("content").innerHTML='<div class="toolbar"><input id="errorSearch" placeholder="Filter error, tool, user, agent"><span class="privacy-note">Safe debug metadata only</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Error</th><th>User</th><th>Tool</th><th>Agent</th><th>Duration</th><th>Activity</th><th>Status</th></tr></thead><tbody>'+
    (items.length?items.map(e=>{const detailId=registerDetail(e);return '<tr data-filter-row data-detail-id="'+detailId+'" data-detail-title="Error detail"><td>'+esc(new Date(e.timestamp).toLocaleString())+'</td><td><strong>'+esc(e.errorClass||"tool_error")+'</strong></td><td>'+esc(e.userId)+'</td><td>'+esc(e.tool)+'</td><td>'+esc(e.agentId||"-")+'</td><td>'+esc(fmtMs(e.durationMs))+'</td><td class="mono">'+esc(e.activityId||"Ungrouped")+'</td><td>'+esc(e.statusCode??e.exitCode??"-")+'</td></tr>'}).join(""):'<tr><td colspan="8">No errors in retained history.</td></tr>')+
    '</tbody></table></div>';
  bindDetailRows(); bindTableFilter("errorSearch");
}

$("loginForm").onsubmit=async(e)=>{
  e.preventDefault(); $("loginError").textContent="";
  try{
    const data=await api("/admin/session/login",{method:"POST",body:JSON.stringify({login:$("loginName").value,password:$("password").value})});
    csrf=data.csrfToken; currentUser=data.user; $("password").value="";
    $("loginView").hidden=true; $("appView").hidden=false;
    $("who").textContent=(currentUser.name||currentUser.login)+" · "+(isAdmin()?"Admin":"User"); $("roleBadge").textContent=isAdmin()?"Admin workspace":"User workspace";
    activeView="overview"; renderNav(); await loadActive();
    clearInterval(pollTimer); pollTimer=setInterval(()=>loadActive(),5000);
  }catch(e){$("loginError").textContent=e.message}
};
$("logout").onclick=async()=>{try{await api("/admin/session/logout",{method:"POST",body:"{}"})}catch{}signOutUi()};
$("refresh").onclick=()=>loadActive();
$("userForm").onsubmit=async(e)=>{
  e.preventDefault();
  try{
    await api("/admin/api/users",{method:"POST",body:JSON.stringify({name:$("newName").value,login:$("newLogin").value,password:$("newPassword").value,admin:$("newAdmin").value==="true"})});
    $("userDialog").close(); await loadUsers();
  }catch(err){$("userFormError").textContent=err.message}
};
document.querySelectorAll("[data-close-dialog]").forEach(b=>b.onclick=()=>$("userDialog").close());
$("cancelDelete").onclick=()=>{$("confirmDialog").close();pendingDeleteUser=null};
$("confirmDelete").onclick=async()=>{if(!pendingDeleteUser)return;await api("/admin/api/users/soft-delete",{method:"POST",body:JSON.stringify({userId:pendingDeleteUser})});pendingDeleteUser=null;$("confirmDialog").close();await loadUsers()};
$("closeDetail").onclick=()=>$("detailDialog").close();

(async()=>{
  try{
    const data=await api("/admin/session");
    currentUser=data.user; $("loginView").hidden=true;$("appView").hidden=false;
    $("who").textContent=(currentUser.name||currentUser.login)+" · "+(isAdmin()?"Admin":"User"); $("roleBadge").textContent=isAdmin()?"Admin workspace":"User workspace";
    renderNav(); await loadActive(); pollTimer=setInterval(()=>loadActive(),5000);
  }catch{}
})();