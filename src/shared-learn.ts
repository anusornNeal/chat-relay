import { canonicalLearnProjectKey } from "./project-identity";
import type { LearnRecord } from "./learning";

const roles = new Set(["owner","editor","member","viewer"]);
const kinds = new Set(["preference","response_style","work_style","coding_style","problem_solving","project_context","tool_pattern","workflow","correction","agent_context"]);
const txt = (s: unknown, n = 160) => typeof s === "string" ? s.trim().slice(0,n+1) : "";
const stamp = () => new Date().toISOString();
const makeId = (prefix: string) => prefix + crypto.randomUUID();
const out = (v: unknown, status = 200) => Response.json(v, {status, headers: {"cache-control":"private, no-store"}});
const actorOk = (id: string) => /^[a-zA-Z0-9._:-]{2,160}$/.test(id);
type Sql = DurableObjectStorage["sql"];
type Group = {id:string;name:string;project_key:string;owner_user_id:string;created_at:string};
type Member = {user_id:string;role:string;added_at:string};
type Proposal = {id:string;group_id:string;source_memory_id:string;source_user_id:string;memory_key:string;kind:string;content:string;confidence:number;status:string;reviewed_by:string|null;created_at:string;reviewed_at:string|null};
type Approved = {id:string;group_id:string;memory_key:string;kind:string;content:string;confidence:number;source_user_id:string;approved_by:string;revision:number;created_at:string;updated_at:string};

export class SharedLearnGroups {
  private initialized = false;
  constructor(private sql: Sql) {}
  private init() {
    if (this.initialized) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learn_groups_v1 (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,project_key TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,created_at TEXT NOT NULL) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learn_group_members_v1 (
      group_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,added_at TEXT NOT NULL,
      PRIMARY KEY(group_id,user_id)) WITHOUT ROWID`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS lg_members_user_v1 ON learn_group_members_v1(user_id,group_id)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learn_group_aliases_v1 (
      group_id TEXT NOT NULL,alias_key TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(group_id,alias_key)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learn_group_proposals_v1 (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,source_memory_id TEXT NOT NULL,source_user_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,confidence INTEGER NOT NULL,
      status TEXT NOT NULL,reviewed_by TEXT,created_at TEXT NOT NULL,reviewed_at TEXT) WITHOUT ROWID`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS lg_proposals_group_v1 ON learn_group_proposals_v1(group_id,status,created_at)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learn_group_approved_v1 (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,memory_key TEXT NOT NULL,kind TEXT NOT NULL,
      content TEXT NOT NULL,confidence INTEGER NOT NULL,source_user_id TEXT NOT NULL,
      approved_by TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(group_id,kind,memory_key)) WITHOUT ROWID`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS lg_approved_group_v1 ON learn_group_approved_v1(group_id,updated_at)");
    this.initialized = true;
  }
  private group(id:string){ return this.sql.exec<Group>("SELECT * FROM learn_groups_v1 WHERE id=? LIMIT 1",id).toArray()[0]; }
  private role(groupId:string,userId:string) {return this.sql.exec<{role:string}>(
    "SELECT role FROM learn_group_members_v1 WHERE group_id=? AND user_id=? LIMIT 1",groupId,userId).toArray()[0]?.role;}
  private summary(actorId:string,projectKey?:string){
    const list=this.sql.exec<Group & {role:string}>(`SELECT g.*,m.role FROM learn_groups_v1 g JOIN learn_group_members_v1 m ON m.group_id=g.id
      WHERE m.user_id=? ORDER BY g.name,g.id LIMIT 65`,actorId).toArray().slice(0,64);
    const aliases=this.sql.exec<{group_id:string;alias_key:string}>(`SELECT a.group_id,a.alias_key
      FROM learn_group_aliases_v1 a JOIN learn_group_members_v1 m ON m.group_id=a.group_id
      WHERE m.user_id=? ORDER BY a.group_id,a.alias_key LIMIT 256`,actorId).toArray();
    const byGroup=new Map<string,string[]>();
    for(const alias of aliases) byGroup.set(alias.group_id,[...(byGroup.get(alias.group_id)||[]),alias.alias_key]);
    return list.filter(g=>!projectKey||g.project_key===projectKey||byGroup.get(g.id)?.includes(projectKey)).map(g=>({
      id:g.id,name:g.name,projectKey:g.project_key,ownerUserId:g.owner_user_id,
      role:g.role,createdAt:g.created_at,aliases:byGroup.get(g.id)||[],
    }));
  }
  async handle(path:string, input:any) :Promise<Response> {
    this.init();
    const actorId=txt(input?.actorId);
    if(!actorOk(actorId)) return out({error:"invalid_actor"},400);
    if(path==="/groups/list") return out({items:this.summary(actorId)});
    if(path==="/groups/prepare"){
      const projectKey=canonicalLearnProjectKey(input?.projectKey);
      if(!projectKey) return out({items:[],groups:[]});
      const groups=this.summary(actorId,projectKey).slice(0,4);
      const items: (LearnRecord & {origin:"shared";groupId:string;approvedBy:string})[]=[];
      for(const group of groups){
        const approved=this.sql.exec<Approved>(
          "SELECT * FROM learn_group_approved_v1 WHERE group_id=? ORDER BY updated_at DESC,id LIMIT 16",group.id).toArray();
        for(const m of approved) items.push({
          id:m.id,key:m.memory_key,kind:m.kind as LearnRecord["kind"],scope:"project",scopeKey:projectKey,content:m.content,
          confidence:m.confidence,positiveFeedback:0,negativeFeedback:0,createdAt:m.created_at,updatedAt:m.updated_at,
          origin:"shared",groupId:group.id,approvedBy:m.approved_by
        });
      }
      return out({items:items.slice(0,32),groups:groups.map(g=>({id:g.id,name:g.name}))});
    }
    if(path==="/groups/create"){
      const name=txt(input?.name,80),rawProject=txt(input?.projectKey,200);
      const projectKey=canonicalLearnProjectKey(rawProject);
      if(!name||name.length>80||!projectKey||projectKey.length>200)return out({error:"invalid_group"},400);
      const count=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM learn_groups_v1").toArray()[0]?.n||0;
      if(count>=200)return out({error:"group_limit"},409);
      const id=makeId("grp_"),createdAt=stamp();
      this.sql.exec("INSERT INTO learn_groups_v1(id,name,project_key,owner_user_id,created_at) VALUES (?,?,?,?,?)",
        id,name,projectKey,actorId,createdAt);
      this.sql.exec("INSERT INTO learn_group_members_v1(group_id,user_id,role,added_at) VALUES (?,?,?,?)",
        id,actorId,"owner",createdAt);
      return out({group:{id,name,projectKey,ownerUserId:actorId,role:"owner",createdAt}},201);
    }
    const groupId=txt(input?.groupId,80);
    if(!/^grp_[a-f0-9-]{36}$/.test(groupId))return out({error:"not_found"},404);
    const group=this.group(groupId),role=group&&this.role(groupId,actorId);
    if(!group||!role)return out({error:"not_found"},404);
    if(path==="/groups/detail"){
      const members=this.sql.exec<Member>("SELECT user_id,role,added_at FROM learn_group_members_v1 WHERE group_id=? ORDER BY user_id LIMIT 64",groupId).toArray();
      const memories=this.sql.exec<Approved>("SELECT * FROM learn_group_approved_v1 WHERE group_id=? ORDER BY updated_at DESC,id LIMIT 100",groupId).toArray();
      const proposals=this.sql.exec<Proposal>("SELECT * FROM learn_group_proposals_v1 WHERE group_id=? ORDER BY created_at DESC,id LIMIT 100",groupId).toArray();
      const aliases=this.sql.exec<{alias_key:string}>(
        "SELECT alias_key FROM learn_group_aliases_v1 WHERE group_id=? ORDER BY alias_key LIMIT 16",groupId,
      ).toArray().map(a=>a.alias_key);
      return out({group:{id:group.id,name:group.name,projectKey:group.project_key,
        aliases,ownerUserId:group.owner_user_id,role,createdAt:group.created_at},
        members:members.map(m=>({userId:m.user_id,role:m.role,addedAt:m.added_at})),
        memories:memories.map(m=>({id:m.id,key:m.memory_key,kind:m.kind,content:m.content,confidence:m.confidence,
          sourceUserId:m.source_user_id,approvedBy:m.approved_by,revision:m.revision,updatedAt:m.updated_at})),
        proposals:proposals.filter(m=>role==="owner"||role==="editor"||(role==="member"&&m.source_user_id===actorId)).map(m=>({id:m.id,key:m.memory_key,kind:m.kind,content:m.content,
          status:m.status,sourceUserId:m.source_user_id,reviewedBy:m.reviewed_by,
          createdAt:m.created_at,reviewedAt:m.reviewed_at}))});
    }
    if(path==="/groups/alias"){
      if(role!=="owner")return out({error:"forbidden"},403);
      const raw=txt(input?.alias,200),alias=canonicalLearnProjectKey(raw);
      if(!alias||alias.length>200||alias===group.project_key)return out({error:"invalid_alias"},400);
      const current=this.sql.exec<{alias_key:string}>(
        "SELECT alias_key FROM learn_group_aliases_v1 WHERE group_id=? ORDER BY alias_key LIMIT 17",groupId,
      ).toArray();
      if(current.some(row=>row.alias_key===alias))return out({error:"alias_exists"},409);
      if(current.length>=16)return out({error:"alias_limit"},409);
      this.sql.exec("INSERT INTO learn_group_aliases_v1(group_id,alias_key,created_at) VALUES (?,?,?)",
        groupId,alias,stamp());
      return out({ok:true,alias},201);
    }
    if(path==="/groups/alias-remove"){
      if(role!=="owner")return out({error:"forbidden"},403);
      const alias=canonicalLearnProjectKey(input?.alias);
      if(!alias||alias===group.project_key)return out({error:"invalid_alias"},400);
      this.sql.exec("DELETE FROM learn_group_aliases_v1 WHERE group_id=? AND alias_key=?",groupId,alias);
      return out({ok:true});
    }
    if(path==="/groups/invite"){
      if(role!=="owner")return out({error:"forbidden"},403);
      const userId=txt(input?.userId),assigned=txt(input?.role,12);
      if(!actorOk(userId)||!roles.has(assigned)||assigned==="owner"||userId===group.owner_user_id)return out({error:"invalid_member"},400);
      const count=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM learn_group_members_v1 WHERE group_id=?",groupId).toArray()[0]?.n||0;
      if(count>=64)return out({error:"member_limit"},409);
      if(this.role(groupId,userId))return out({error:"already_member"},409);
      this.sql.exec("INSERT INTO learn_group_members_v1(group_id,user_id,role,added_at) VALUES (?,?,?,?)",groupId,userId,assigned,stamp());
      return out({ok:true,userId,role:assigned},201);
    }
    if(path==="/groups/remove"){
      if(role!=="owner")return out({error:"forbidden"},403);
      const userId=txt(input?.userId);
      if(!actorOk(userId)||userId===group.owner_user_id)return out({error:"cannot_remove_owner"},409);
      this.sql.exec("DELETE FROM learn_group_members_v1 WHERE group_id=? AND user_id=?",groupId,userId);
      return out({ok:true});
    }
    if(path==="/groups/propose-direct"){
      if(role==="viewer")return out({error:"forbidden"},403);
      // New group knowledge is a proposal only. The author never writes the
      // approved table, and no personal Learn record is created.
      const key=txt(input?.key,160),kind=txt(input?.kind,40);
      const content=txt(input?.content,4000);
      if(!key||key.length>160||!kinds.has(kind)||!content||content.length>4000)
        return out({error:"invalid_memory"},400);
      const pending=this.sql.exec<Proposal>(
        "SELECT * FROM learn_group_proposals_v1 WHERE group_id=? AND kind=? AND memory_key=? AND status='pending' LIMIT 1",
        groupId,kind,key,
      ).toArray()[0];
      if(pending)return out({error:"already_pending"},409);
      const count=this.sql.exec<{n:number}>(
        "SELECT COUNT(*) AS n FROM learn_group_proposals_v1 WHERE group_id=? AND status='pending'",groupId,
      ).toArray()[0]?.n||0;
      if(count>=100)return out({error:"proposal_limit"},409);
      const proposalId=makeId("prp_");
      this.sql.exec(`INSERT INTO learn_group_proposals_v1(id,group_id,source_memory_id,source_user_id,memory_key,kind,content,
        confidence,status,reviewed_by,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        proposalId,groupId,makeId("direct_"),actorId,key,kind,content,100,"pending",null,stamp(),null);
      return out({ok:true,proposalId,status:"pending"},201);
    }
    if(path==="/groups/propose"){
      if(role==="viewer")return out({error:"forbidden"},403);
      const m=input?.memory as LearnRecord|undefined;
      const scopeKey=canonicalLearnProjectKey(m?.scopeKey);
      const knownAlias=scopeKey&&this.sql.exec<{alias_key:string}>(
        "SELECT alias_key FROM learn_group_aliases_v1 WHERE group_id=? AND alias_key=? LIMIT 1",groupId,scopeKey,
      ).toArray()[0];
      if(!m||m.scope!=="project"||(scopeKey!==group.project_key&&!knownAlias)||
        !kinds.has(m.kind)||!txt(m.key)||txt(m.key).length>160||
        !txt(m.content,4000)||txt(m.content,4000).length>4000||
        !/^[a-zA-Z0-9_-]{8,160}$/.test(String(m.id)))return out({error:"invalid_memory"},400);
      const pending=this.sql.exec<Proposal>("SELECT * FROM learn_group_proposals_v1 WHERE group_id=? AND source_memory_id=? AND source_user_id=? AND status='pending' LIMIT 1",
        groupId,m.id,actorId).toArray()[0];
      if(pending)return out({error:"already_pending"},409);
      const count=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM learn_group_proposals_v1 WHERE group_id=? AND status='pending'",groupId).toArray()[0]?.n||0;
      if(count>=100)return out({error:"proposal_limit"},409);
      const proposalId=makeId("prp_");
      this.sql.exec(`INSERT INTO learn_group_proposals_v1(id,group_id,source_memory_id,source_user_id,memory_key,kind,content,
        confidence,status,reviewed_by,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        proposalId,groupId,m.id,actorId,m.key,m.kind,m.content,Math.max(0,Math.min(100,Number(m.confidence)||100)),"pending",null,stamp(),null);
      return out({ok:true,proposalId,status:"pending"},201);
    }
    if(path==="/groups/review"){
      if(role!=="owner"&&role!=="editor")return out({error:"forbidden"},403);
      const proposalId=txt(input?.proposalId,80),decision=txt(input?.decision,12);
      if(!/^prp_[a-f0-9-]{36}$/.test(proposalId)||!["approve","reject"].includes(decision))return out({error:"invalid_review"},400);
      const p=this.sql.exec<Proposal>("SELECT * FROM learn_group_proposals_v1 WHERE group_id=? AND id=? LIMIT 1",groupId,proposalId).toArray()[0];
      if(!p)return out({error:"not_found"},404);
      if(p.status!=="pending")return out({error:"already_reviewed"},409);
      if(role!=="owner"&&p.source_user_id===actorId)return out({error:"self_review"},403);
      const existing=this.sql.exec<Approved>("SELECT * FROM learn_group_approved_v1 WHERE group_id=? AND kind=? AND memory_key=? LIMIT 1",
        groupId,p.kind,p.memory_key).toArray()[0];
      if(decision==="approve"&&existing&&existing.content!==p.content&&input?.replace!==true)return out({error:"shared_memory_conflict",existingId:existing.id},409);
      const t=stamp();
      if(decision==="approve"){
        if(existing)this.sql.exec("UPDATE learn_group_approved_v1 SET content=?,confidence=?,source_user_id=?,approved_by=?,revision=?,updated_at=? WHERE id=?",
          p.content,p.confidence,p.source_user_id,actorId,existing.revision+1,t,existing.id);
        else {
          const count=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM learn_group_approved_v1 WHERE group_id=?",groupId).toArray()[0]?.n||0;
          if(count>=100)return out({error:"shared_memory_limit"},409);
          this.sql.exec(`INSERT INTO learn_group_approved_v1(id,group_id,memory_key,kind,content,confidence,source_user_id,approved_by,revision,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,makeId("smem_"),groupId,p.memory_key,p.kind,p.content,p.confidence,p.source_user_id,actorId,1,t,t);
        }
      }
      this.sql.exec("UPDATE learn_group_proposals_v1 SET status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'",
        decision==="approve"?"approved":"rejected",actorId,t,proposalId);
      return out({ok:true,status:decision==="approve"?"approved":"rejected"});
    }
    return out({error:"not_found"},404);
  }
}
