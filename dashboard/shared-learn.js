import { renderLearnMarkdown } from "./learn-markdown.js";

export function createSharedLearnUI({api,renderContent,setHeader,setNotice,escape,showPersonal}) {
  let groups = [], selectedGroupId = null, detail = null, tab = "approved", selectedItemId = null;
  const icon = (name) => ({group:"◉",folder:"▣",plus:"+",back:"←"})[name] || "";
  const esc = escape;
  const groupUrl = (id) => "/admin/api/learn/groups/" + encodeURIComponent(id);
  const write = (url, body, method="POST") => api(url, {method,body:JSON.stringify(body)});
  const roleLabel = (role) => ({owner:"Owner",editor:"Editor",member:"Member",viewer:"Viewer"})[role] || role;
  const canReview = () => ["owner","editor"].includes(detail?.group?.role);
  const isOwner = () => detail?.group?.role === "owner";

  async function refresh() {
    const result = await api("/admin/api/learn/groups");
    groups = result.items || [];
    if (!groups.some((group) => group.id === selectedGroupId)) selectedGroupId = groups[0]?.id || null;
    detail = selectedGroupId ? await api(groupUrl(selectedGroupId)) : null;
  }
  const getRows = () => tab === "approved" ? (detail?.memories || [])
    : (detail?.proposals || []).filter((x) => tab === "pending" ? x.status === "pending" : x.status !== "pending");
  const tabButton = (value,label) => '<button class="learn-shared-tab' + (tab === value ? ' active' : '') +
    '" type="button" data-shared-tab="' + value + '">' + esc(label) + '</button>';
  function render() {
    const group = detail?.group;
    const rows = getRows();
    if (!rows.some(r => r.id === selectedItemId)) selectedItemId = rows[0]?.id || null;
    const selected = rows.find(r => r.id === selectedItemId);
    const sidebar = groups.length ? groups.map(g =>
      '<button type="button" class="learn-shared-group' + (selectedGroupId === g.id ? ' selected' : '') +
      '" data-shared-group="' + esc(g.id) + '"><strong>' + esc(g.name) + '</strong><small>' + esc(g.projectKey) +
      ' · ' + esc(roleLabel(g.role)) + '</small></button>').join("")
      : '<p class="learn-shared-muted">No shared groups yet. Create one to collaborate.</p>';
    const list = rows.length ? rows.map(m =>
      '<button type="button" class="learn-folder-row' + (m.id === selectedItemId ? ' active' : '') +
      '" data-shared-memory="' + esc(m.id) + '"><span class="learn-folder-file">▤</span><span class="learn-folder-copy">' +
      '<strong>' + esc(m.key) + '</strong><small>' + esc(m.kind) + '</small></span>' +
      '<span class="learn-folder-confidence">' + esc(m.status || m.revision || '') + '</span></button>').join('')
      : '<div class="learn-detail-empty"><strong>' + (tab === "pending" ? "No proposals waiting" : tab === "history" ?
        "No review history" : "No approved memories") + '</strong><span>' +
        (tab === "approved" ? "Share a project memory from My Learn, then approve it here." : "Nothing to review.") +
        '</span></div>';
    const info = selected ? '<div class="learn-detail-scroll"><div class="learn-detail-top"><span class="learn-type-pill">' +
      esc(selected.kind) + '</span><span class="learn-shared-muted">' + esc(selected.status || "Approved") + '</span></div>' +
      '<h3>' + esc(selected.key) + '</h3><div class="learn-detail-rule"></div>' +
      '<div class="learn-detail-section"><label>Memory</label><div class="learn-markdown">' +
      renderLearnMarkdown(selected.content) + '</div></div>' +
      '<div class="learn-detail-rule"></div><div class="learn-detail-section"><label>Details</label>' +
      '<p class="learn-shared-meta">Proposed by ' + esc(selected.sourceUserId || "Unknown") + '</p>' +
      (selected.approvedBy ? '<p class="learn-shared-meta">Approved by ' + esc(selected.approvedBy) + '</p>' : '') +
      (selected.revision ? '<p class="learn-shared-meta">Revision ' + esc(selected.revision) + '</p>' : '') +
      '</div></div>' +
      (tab === "pending" && canReview() ?
        '<div class="learn-detail-footer learn-shared-review-actions">' +
        '<button class="button small" data-shared-review="approve">Approve</button>' +
        '<button class="button small danger" data-shared-review="reject">Reject</button></div>' : '')
      : '<div class="learn-detail-empty"><strong>Select a memory</strong><span>Choose a row to inspect details.</span></div>';
    setHeader("Shared Learn","Approved knowledge shared across project accounts");
    renderContent('<section class="learn-folder-shell learn-shared-shell">' +
      '<aside class="learn-folder-tree"><div class="learn-tree-section">Shared project groups</div>' +
      '<div class="learn-shared-group-list">' + sidebar + '</div>' +
      '<button type="button" class="button small learn-shared-create" id="sharedCreate">+ Create group</button></aside>' +
      '<div class="learn-folder-main">' +
      '<div class="learn-folder-heading"><div><div class="learn-folder-breadcrumbs"><span>Learn</span><b>/</b><strong>Shared</strong></div>' +
      '<h2>' + esc(group?.name || "Shared Learn") + '</h2><p>' + esc(group?.projectKey || "Choose a group to begin") +
      (group ? " · " + esc(roleLabel(group.role)) : "") + '</p></div>' +
      '<div class="learn-folder-heading-actions"><button class="button small" id="sharedBack">My Learn</button>' +
      (group ? '<button class="button small" id="sharedMembers">Members (' + (detail?.members?.length || 0) + ')</button>' +
        '<button class="button small" id="sharedAliases">Project aliases</button>' : '') +
      '</div></div>' +
      '<div class="learn-folder-list-toolbar learn-shared-toolbar">' +
      (group ? tabButton("approved","Approved") + tabButton("pending","Pending") +
      tabButton("history","History") : '<span>Create a group to start sharing project rules</span>') + '</div>' +
      '<div class="learn-folder-workspace"><div class="learn-folder-list"><div class="learn-folder-list-head learn-shared-list-head">' +
      '<span>Name</span><span>Version / Status</span></div><div class="learn-folder-list-scroll">' + list +
      '</div></div><aside class="learn-detail-pane">' + info + '</aside></div></div></section>');
    document.getElementById("sharedBack").onclick = showPersonal;
    document.getElementById("sharedCreate").onclick = createGroup;
    document.getElementById("sharedMembers")?.addEventListener("click", manageMembers);
    document.getElementById("sharedAliases")?.addEventListener("click", manageAliases);
    document.querySelectorAll("[data-shared-group]").forEach(el => el.onclick = async () => {
      selectedGroupId = el.dataset.sharedGroup;
      selectedItemId = null;
      try { detail = await api(groupUrl(selectedGroupId));render(); }
      catch(e) {setNotice(e.message,true);}
    });
    document.querySelectorAll("[data-shared-tab]").forEach(el => el.onclick = () => {tab=el.dataset.sharedTab;selectedItemId=null;render();});
    document.querySelectorAll("[data-shared-memory]").forEach(el => el.onclick = () => {selectedItemId=el.dataset.sharedMemory;render();});
    document.querySelectorAll("[data-shared-review]").forEach(el => el.onclick = async () => {
      if (!selected || !canReview()) return;
      const decision=el.dataset.sharedReview;
      if (!window.confirm(decision === "approve" ? "Approve this rule for all group members?" :
        "Reject this proposal?")) return;
      try {
        try {
          await write(groupUrl(selectedGroupId) + "/review",{proposalId:selected.id,decision});
        } catch(err) {
          if (err.message !== "shared_memory_conflict" || decision !== "approve" ||
              !window.confirm("A different approved rule uses this key. Replace the existing shared rule?")) throw err;
          await write(groupUrl(selectedGroupId) + "/review",{proposalId:selected.id,decision,replace:true});
        }
        selectedItemId=null; await show();setNotice("Proposal " + (decision === "approve" ? "approved" : "rejected") + ".");
      } catch(e){setNotice(e.message,true);}
    });
  }
  async function show() {
    try {await refresh();render();}
    catch(e){setHeader("Shared Learn","Shared project knowledge");
      renderContent('<section class="panel learn-shared-error"><h2>Cannot load Shared Learn</h2><p>' +
        esc(e.message) + '</p><button id="sharedRetry" class="button">Retry</button>' +
        '<button id="sharedBack" class="button">My Learn</button></section>');
      document.getElementById("sharedRetry").onclick=show;
      document.getElementById("sharedBack").onclick=showPersonal;
    }
  }
  function dialog(title,fields,onSubmit) {
    const d=document.createElement("dialog");
    d.className="learn-shared-dialog";
    d.innerHTML='<form method="dialog" class="learn-shared-form"><h3>' + esc(title) + '</h3>' + fields +
      '<p class="learn-shared-dialog-error" role="alert" hidden></p>' +
      '<div class="learn-shared-dialog-actions"><button type="button" class="button" data-cancel>Cancel</button>' +
      '<button type="submit" class="button primary" data-submit>Continue</button></div></form>';
    document.body.append(d);
    d.addEventListener("close",()=>d.remove(),{once:true});
    d.querySelector("[data-cancel]").onclick=()=>d.close();
    d.querySelector("form").onsubmit=async ev=>{
      ev.preventDefault();
      const submit=d.querySelector("[data-submit]"),error=d.querySelector(".learn-shared-dialog-error");
      submit.disabled=true;error.hidden=true;
      try{await onSubmit(Object.fromEntries(new FormData(ev.target)));d.close();}
      catch(e){error.textContent=e.message;error.hidden=false;}finally{submit.disabled=false;}
    };
    d.showModal();
  }
  function createGroup() {
    dialog("Create shared project group",
      '<label>Group name<input name="name" maxlength="80" required placeholder="Buddy2"></label>' +
      '<label>Canonical project key<input name="projectKey" maxlength="200" required placeholder="buddy2"></label>',
      async values => {
        const result=await write("/admin/api/learn/groups",values);
        selectedGroupId=result.group.id;tab="approved";selectedItemId=null;
        await show();setNotice("Shared group created.");
      });
  }
  function manageMembers() {
    if (!detail) return;
    const members=detail.members||[];
    const rows=members.map(m=>'<div class="learn-shared-member"><span>' + esc(m.userId) +
      ' <small>' + esc(roleLabel(m.role)) + '</small></span>' +
      (isOwner() && m.role !== "owner" ?
        '<button type="button" class="button small danger" data-remove-member="' + esc(m.userId) + '">Remove</button>' : '') +
      '</div>').join('');
    const fields='<div class="learn-shared-members">' + rows + '</div>' +
      (isOwner() ? '<label>Invite existing account ID<input name="userId" required placeholder="user-google-..."></label>' +
        '<label>Role<select name="role"><option value="member">Member - propose</option>' +
        '<option value="editor">Editor - review</option><option value="viewer">Viewer - read only</option></select></label>' :
        '<p class="learn-shared-muted">Only the group owner can manage members.</p>');
    dialog("Members · " + detail.group.name,fields,async values=>{
      if (!isOwner()) return;
      await write(groupUrl(selectedGroupId)+"/members",values);
      await show();setNotice("Member invited.");
    });
    const d=document.querySelector("dialog.learn-shared-dialog:last-of-type");
    if (!isOwner()) d.querySelector("[data-submit]").hidden=true;
    d.querySelectorAll("[data-remove-member]").forEach(el=>el.onclick=async ()=>{
      if (!window.confirm("Remove this member's access?"))return;
      try {
        await api(groupUrl(selectedGroupId)+"/members/"+encodeURIComponent(el.dataset.removeMember),
          {method:"DELETE",body:"{}"});
        d.close();await show();setNotice("Member removed.");
      }catch(e){setNotice(e.message,true);}
    });
  }
  function manageAliases() {
    if (!detail) return;
    const current=detail.group?.aliases||[];
    const aliases=current.map(alias=>'<div class="learn-shared-member"><span>' + esc(alias) + '</span>' +
      (isOwner() ? '<button type="button" class="button small danger" data-remove-alias="' + esc(alias) +
        '">Remove</button>' : '') + '</div>').join("");
    const fields='<p class="learn-shared-muted">Approved aliases let team members use different folder names for the same project.</p>' +
      '<p class="learn-shared-meta">Canonical project: <strong>' + esc(detail.group.projectKey) + '</strong></p>' +
      '<div class="learn-shared-members">' + (aliases || '<p class="learn-shared-muted">No aliases yet.</p>') + '</div>' +
      (isOwner() ? '<label>New project alias<input name="alias" maxlength="200" required placeholder="buddy-android"></label>' :
        '<p class="learn-shared-muted">Only the group owner can manage project aliases.</p>');
    dialog("Project aliases · " + detail.group.name,fields,async values=>{
      if (!isOwner()) return;
      await write(groupUrl(selectedGroupId)+"/aliases",values);
      await show();setNotice("Project alias added.");
    });
    const d=document.querySelector("dialog.learn-shared-dialog:last-of-type");
    if (!isOwner()) d.querySelector("[data-submit]").hidden=true;
    d.querySelectorAll("[data-remove-alias]").forEach(el=>el.onclick=async()=>{
      if(!window.confirm("Remove this project alias?"))return;
      try {
        await write(groupUrl(selectedGroupId)+"/aliases/remove",{alias:el.dataset.removeAlias});
        d.close();await show();setNotice("Project alias removed.");
      } catch(e){setNotice(e.message,true);}
    });
  }
  async function shareMemory(item) {
    if (item?.scope !== "project") return setNotice("Only project memories can be shared.",true);
    try {
      const result=await api("/admin/api/learn/groups");
      const possible=(result.items||[]).filter(g=>(g.projectKey===item.scopeKey||(g.aliases||[]).includes(item.scopeKey)) && g.role!=="viewer");
      if (!possible.length) {
        setNotice("No matching Shared Learn group. Create or join a group for this project first.",true);
        return;
      }
      dialog("Share project memory",
        '<p class="learn-shared-muted">A copy is proposed for review. Your personal memory remains private.</p>' +
        '<label>Memory<strong>' + esc(item.key) + '</strong></label><label>Share to group<select name="groupId">' +
        possible.map(g=>'<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>').join('') +
        '</select></label>',
        async values=>{
          await write(groupUrl(values.groupId)+"/proposals",{memoryId:item.id});
          setNotice("Proposal submitted. Shared members cannot read it until approved.");
        });
    } catch(e){setNotice(e.message,true);}
  }
  return {show,shareMemory};
}
