/** Per-account metadata index; source-of-truth remains learning_memory_v1.
 * Triggers keep compact metadata in the same transaction as source mutations. */
const SOURCE = "learning_memory_v1";
const INDEX = "learning_metadata_index_v1";
const META = "learning_metadata_index_meta_v1";
const VERSION = 3;
type Sql = {exec<T = any>(query:string,...args:any[]):{toArray():T[]}};
const required = `CASE WHEN NEW.memory_key='flowly-implementation-workflow'
  OR NEW.memory_key LIKE 'required-%' OR NEW.memory_key LIKE 'required:%'
  OR NEW.memory_key LIKE 'core-%' OR NEW.memory_key LIKE 'core:%'
  THEN 1 ELSE 0 END`;
const core = `CASE WHEN NEW.memory_key LIKE 'core-%'
  OR NEW.memory_key LIKE 'core:%' THEN 1 ELSE 0 END`;
const mask = `CASE WHEN NEW.kind='coding_style' THEN 28 ELSE 31 END`;
const requiredSelect = `CASE WHEN memory_key='flowly-implementation-workflow'
  OR memory_key LIKE 'required-%' OR memory_key LIKE 'required:%'
  OR memory_key LIKE 'core-%' OR memory_key LIKE 'core:%'
  THEN 1 ELSE 0 END`;
const coreSelect = `CASE WHEN memory_key LIKE 'core-%'
  OR memory_key LIKE 'core:%' THEN 1 ELSE 0 END`;
export type LearnIndexEntry = {
  id:string; memory_key:string; kind:string; scope:string; scope_key:string|null;
  updated_at:string; content_length:number; content_preview:string;
  required_rule:number; core_rule:number; phase_mask:number;
  validity_status?: "valid" | "needs-review" | "deprecated";
};
export class LearnIndexStore {
  constructor(private readonly sql:Sql,
    private readonly atomic:<T>(fn:()=>T)=>T=(fn)=>fn()) {}
  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${INDEX} (
      id TEXT PRIMARY KEY, memory_key TEXT NOT NULL, kind TEXT NOT NULL,
      scope TEXT NOT NULL, scope_key TEXT, updated_at TEXT NOT NULL,
      content_length INTEGER NOT NULL, content_preview TEXT NOT NULL DEFAULT '',
      required_rule INTEGER NOT NULL DEFAULT 0, core_rule INTEGER NOT NULL DEFAULT 0,
      phase_mask INTEGER NOT NULL DEFAULT 31) WITHOUT ROWID`);
    const columns = new Set(this.sql.exec<{name:string}>(`PRAGMA table_info(${INDEX})`)
      .toArray().map(row=>row.name));
    if (!columns.has("content_preview"))
      this.sql.exec(`ALTER TABLE ${INDEX} ADD COLUMN content_preview TEXT NOT NULL DEFAULT ''`);
    if (!columns.has("phase_mask"))
      this.sql.exec(`ALTER TABLE ${INDEX} ADD COLUMN phase_mask INTEGER NOT NULL DEFAULT 31`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS learning_metadata_index_scope
      ON ${INDEX}(scope,scope_key,kind,required_rule,updated_at DESC)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS learning_metadata_index_key
      ON ${INDEX}(memory_key,scope,scope_key)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (
      version INTEGER PRIMARY KEY, rebuilt_at TEXT NOT NULL) WITHOUT ROWID`);
    // Only migrate triggers when schema version changes; no repeated DDL on DO wake.
    const ready = this.sql.exec<{version:number}>(
      `SELECT version FROM ${META} WHERE version=? LIMIT 1`,VERSION).toArray()[0];
    if (ready) return;
    for (const suffix of ["insert","update","delete"])
      this.sql.exec(`DROP TRIGGER IF EXISTS learning_metadata_after_${suffix}`);
    this.sql.exec(`CREATE TRIGGER learning_metadata_after_insert
      AFTER INSERT ON ${SOURCE} BEGIN
      INSERT INTO ${INDEX}
        (id,memory_key,kind,scope,scope_key,updated_at,content_length,
         content_preview,required_rule,core_rule,phase_mask)
      VALUES (NEW.id,NEW.memory_key,NEW.kind,NEW.scope,NEW.scope_key,
        NEW.updated_at,length(NEW.content),substr(NEW.content,1,120),
        ${required},${core},${mask});
      END`);
    this.sql.exec(`CREATE TRIGGER learning_metadata_after_update
      AFTER UPDATE OF memory_key,kind,scope,scope_key,content,confidence,
        positive_feedback,negative_feedback,updated_at ON ${SOURCE} BEGIN
      INSERT INTO ${INDEX}
        (id,memory_key,kind,scope,scope_key,updated_at,content_length,
         content_preview,required_rule,core_rule,phase_mask)
      VALUES (NEW.id,NEW.memory_key,NEW.kind,NEW.scope,NEW.scope_key,
        NEW.updated_at,length(NEW.content),substr(NEW.content,1,120),
        ${required},${core},${mask})
      ON CONFLICT(id) DO UPDATE SET
        memory_key=excluded.memory_key,kind=excluded.kind,scope=excluded.scope,
        scope_key=excluded.scope_key,updated_at=excluded.updated_at,
        content_length=excluded.content_length,content_preview=excluded.content_preview,
        required_rule=excluded.required_rule,core_rule=excluded.core_rule,
        phase_mask=excluded.phase_mask;
      END`);
    this.sql.exec(`CREATE TRIGGER learning_metadata_after_delete
      AFTER DELETE ON ${SOURCE} BEGIN
      DELETE FROM ${INDEX} WHERE id=OLD.id; END`);
    this.rebuild();
  }
  rebuild() {
    return this.atomic(()=>{
      this.sql.exec(`DELETE FROM ${INDEX}`);
      this.sql.exec(`INSERT INTO ${INDEX}
        (id,memory_key,kind,scope,scope_key,updated_at,content_length,
         content_preview,required_rule,core_rule,phase_mask)
        SELECT id,memory_key,kind,scope,scope_key,updated_at,length(content),
        substr(content,1,120),${requiredSelect},${coreSelect},
        CASE WHEN kind='coding_style' THEN 28 ELSE 31 END FROM ${SOURCE}`);
      this.sql.exec(`INSERT INTO ${META}(version,rebuilt_at) VALUES (?,?)
        ON CONFLICT(version) DO UPDATE SET rebuilt_at=excluded.rebuilt_at`,
        VERSION,new Date().toISOString());
      return Number(this.sql.exec<{n:number}>(`SELECT count(*) AS n FROM ${INDEX}`)
        .toArray()[0]?.n??0);
    });
  }
  discover(selectors:Array<{scope:string;scopeKey:string|null}>,max=512):LearnIndexEntry[]{
    const unique=new Map<string,{scope:string;scopeKey:string|null}>();
    for(const s of selectors.slice(0,8)){
      if(!["global","project","agent"].includes(s.scope))continue;
      if(s.scope!=="global"&&!s.scopeKey)continue;
      unique.set(s.scope+"|"+(s.scopeKey??""),s);
    }
    if(!unique.size)return [];
    const clauses:string[]=[],args:string[]=[];
    for(const s of unique.values()){
      if(s.scope==="global"){clauses.push("(scope=? AND scope_key IS NULL)");args.push("global");}
      else{clauses.push("(scope=? AND scope_key=?)");args.push(s.scope,s.scopeKey!);}
    }
    return this.sql.exec<LearnIndexEntry>(
      `SELECT i.*,l.status AS validity_status FROM ${INDEX} i
      LEFT JOIN learning_lifecycle_state_v1 l ON l.memory_id=i.id
      WHERE ${clauses.join(" OR ")}
      ORDER BY i.required_rule DESC,i.core_rule DESC,i.updated_at DESC,i.id ASC LIMIT ?`,
      ...args,Math.max(1,Math.min(512,Math.floor(max)))).toArray();
  }
}
