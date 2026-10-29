/**
 * Learn content validity is evidence-backed and independent of retrieval usage.
 * Every explicit correction retains the prior text and a reversible revision.
 * SQLite triggers cover regular edits, merges and compaction, not just API calls.
 */
const SOURCE = "learning_memory_v1";
const STATE = "learning_lifecycle_state_v1";
const HISTORY = "learning_lifecycle_revision_v1";
const EVENTS = "learning_lifecycle_event_v1";
const META = "learning_lifecycle_meta_v1";
type Sql = { exec<T=any>(query:string,...args:any[]):{toArray():T[]} };
export type LearnValidityStatus = "valid" | "needs-review" | "deprecated";
export type LearnValidity = {
  memory_id:string; status:LearnValidityStatus; revision:number;
  reason:string|null; evidence_ref:string|null; source_fingerprint:string|null;
  updated_at:string;
};
const clean = (v:unknown,n:number) => typeof v==="string" ? v.trim().slice(0,n) : "";

export class LearnLifecycleStore {
  constructor(private readonly sql:Sql,
    private readonly atomic:<T>(fn:()=>T)=>T=(fn)=>fn()) {}
  initialize(){
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${STATE} (
      memory_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'valid',
      revision INTEGER NOT NULL DEFAULT 1, reason TEXT, evidence_ref TEXT,
      source_fingerprint TEXT, updated_at TEXT NOT NULL) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY} (
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
      changed_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${EVENTS} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL, before_status TEXT, after_status TEXT NOT NULL,
      reason TEXT NOT NULL, evidence_ref TEXT NOT NULL, source_fingerprint TEXT,
      at TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS learning_lifecycle_events_memory
      ON ${EVENTS}(memory_id,seq DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (
      version INTEGER PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS learning_lifecycle_insert
      AFTER INSERT ON ${SOURCE} BEGIN
        INSERT OR IGNORE INTO ${STATE}(memory_id,status,revision,updated_at)
        VALUES (NEW.id,'valid',1,NEW.updated_at);
      END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS learning_lifecycle_content_change
      AFTER UPDATE OF content ON ${SOURCE}
      WHEN OLD.content<>NEW.content BEGIN
        INSERT OR IGNORE INTO ${HISTORY}(memory_id,revision,content,changed_at)
          SELECT OLD.id,revision,OLD.content,NEW.updated_at
          FROM ${STATE} WHERE memory_id=OLD.id;
        UPDATE ${STATE} SET revision=revision+1,updated_at=NEW.updated_at
          WHERE memory_id=NEW.id;
      END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS learning_lifecycle_delete
      AFTER DELETE ON ${SOURCE} BEGIN
        DELETE FROM ${STATE} WHERE memory_id=OLD.id;
        DELETE FROM ${HISTORY} WHERE memory_id=OLD.id;
        DELETE FROM ${EVENTS} WHERE memory_id=OLD.id;
      END`);
    const ready=this.sql.exec<{version:number}>(
      `SELECT version FROM ${META} WHERE version=1 LIMIT 1`).toArray()[0];
    if(!ready){
      this.atomic(()=>{
        this.sql.exec(`INSERT OR IGNORE INTO ${STATE}(memory_id,status,revision,updated_at)
          SELECT id,'valid',1,updated_at FROM ${SOURCE}`);
        this.sql.exec(`INSERT INTO ${META}(version,at) VALUES (1,?)`,new Date().toISOString());
      });
    }
  }
  get(id:string):LearnValidity|null{
    return this.sql.exec<LearnValidity>(
      `SELECT * FROM ${STATE} WHERE memory_id=? LIMIT 1`,id).toArray()[0]??null;
  }
  history(id:string){
    if(!this.get(id)) return null;
    return {
      current:this.get(id),
      revisions:this.sql.exec<{memory_id:string;revision:number;content:string;changed_at:string}>(
        `SELECT * FROM ${HISTORY} WHERE memory_id=? ORDER BY revision DESC LIMIT 32`,id).toArray(),
      events:this.sql.exec<any>(
        `SELECT event_type,before_status,after_status,reason,evidence_ref,
          source_fingerprint,at FROM ${EVENTS} WHERE memory_id=? ORDER BY seq DESC LIMIT 32`,id).toArray(),
    };
  }
  changeStatus(id:string,status:LearnValidityStatus,reason:unknown,evidence:unknown,fingerprint?:unknown){
    if(!["valid","needs-review","deprecated"].includes(status))
      return {ok:false,statusCode:400,error:"invalid_validity_status"};
    const note=clean(reason,400),ref=clean(evidence,200),source=clean(fingerprint,160);
    if(note.length<8||ref.length<8||/[\n\r<>]/.test(ref)||/[\n\r<>]/.test(source))
      return {ok:false,statusCode:400,error:"evidence_required"};
    const current=this.get(id);
    if(!current) return {ok:false,statusCode:404,error:"not_found"};
    if(current.status===status&&current.reason===note&&current.evidence_ref===ref)
      return {ok:true,changed:false,state:current};
    return this.atomic(()=>{
      const at=new Date().toISOString();
      this.sql.exec(`UPDATE ${STATE} SET status=?,reason=?,evidence_ref=?,
        source_fingerprint=?,updated_at=? WHERE memory_id=?`,
        status,note,ref,source||null,at,id);
      this.sql.exec(`INSERT INTO ${EVENTS}
        (memory_id,event_type,before_status,after_status,reason,evidence_ref,source_fingerprint,at)
        VALUES (?,'status',?,?,?,?,?,?)`,
        id,current.status,status,note,ref,source||null,at);
      return {ok:true,changed:true,state:this.get(id)};
    });
  }
  restore(id:string,revision:number,reason:unknown,evidence:unknown){
    const note=clean(reason,400),ref=clean(evidence,200);
    if(!Number.isSafeInteger(revision)||revision<1||note.length<8||ref.length<8||
      /[\n\r<>]/.test(ref))return {ok:false,statusCode:400,error:"invalid_restore"};
    const current=this.get(id);
    if(!current)return {ok:false,statusCode:404,error:"not_found"};
    const prior=this.sql.exec<{content:string}>(
      `SELECT content FROM ${HISTORY} WHERE memory_id=? AND revision=?`,
      id,revision).toArray()[0];
    if(!prior)return {ok:false,statusCode:404,error:"revision_not_found"};
    const now=new Date().toISOString();
    return this.atomic(()=>{
      // This UPDATE snapshots the pre-restore text via the content-change trigger.
      this.sql.exec(`UPDATE ${SOURCE} SET content=?,updated_at=? WHERE id=?`,
        prior.content,now,id);
      this.sql.exec(`UPDATE ${STATE} SET status='valid',reason=?,evidence_ref=?,
        source_fingerprint=NULL,updated_at=? WHERE memory_id=?`,note,ref,now,id);
      this.sql.exec(`INSERT INTO ${EVENTS}
        (memory_id,event_type,before_status,after_status,reason,evidence_ref,at)
        VALUES (?,'restore',?,?,?,?,?)`,
        id,current.status,"valid",note,ref,now);
      return {ok:true,changed:true,state:this.get(id)};
    });
  }
}
