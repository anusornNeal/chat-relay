import assert from "node:assert/strict";
import { createSharedLearnUI } from "../dashboard/shared-learn.js";
let markup = "", header = "";
const elements = new Map();
globalThis.document = {
  getElementById(id) {if(!elements.has(id))elements.set(id,{onclick:null,addEventListener(){}});return elements.get(id)},
  querySelectorAll(){return []},
};
const group = {id:"grp_"+"a".repeat(8)+"-"+["a".repeat(4),"a".repeat(4),"a".repeat(4),"a".repeat(12)].join("-"),name:"Buddy2",projectKey:"buddy2",role:"viewer",ownerUserId:"owner"};
const fakeApi = async path => path==="/admin/api/learn/groups" ? {items:[group]} :
  {group,members:[{userId:"owner",role:"owner"}],memories:[{id:"smem_1",key:"shared-rule",kind:"workflow",content:"**Bold** details",revision:1,sourceUserId:"owner",approvedBy:"owner"}],
    proposals:[{id:"prp_1",key:"pending-rule",kind:"correction",content:"not approved",status:"pending",sourceUserId:"owner"}]};
const ui=createSharedLearnUI({api:fakeApi,renderContent(x){markup=x},setHeader(x){header=x},setNotice(){},escape(x){
 return String(x??"").replace(/[&<>"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
},showPersonal(){}});
await ui.show();
assert.equal(header,"Shared Learn");
assert.match(markup,/Buddy2/);
assert.match(markup,/Approved/);
assert.match(markup,/Pending/);
assert.match(markup,/History/);
assert.match(markup,/<strong>Bold<\/strong>/);
assert.doesNotMatch(markup,/data-shared-review=/,"viewer must not see approval controls");
await ui.shareMemory({scope:"global",key:"personal"});
const empty=createSharedLearnUI({api:async()=>({items:[]}),renderContent:x=>{markup=x},setHeader(){},setNotice(){},escape:x=>String(x),showPersonal(){}});
await empty.show();
assert.match(markup,/No shared groups yet/);
assert.match(markup,/Create group/);
console.log("PASS Shared Learn group UI, viewer state, safe Markdown, and empty state");
