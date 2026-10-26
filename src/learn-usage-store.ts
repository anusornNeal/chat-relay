const MEMORY_TABLE = "learning_memory_v1";
const RECEIPT_TABLE = "learning_usage_receipt_v1";
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_MEMORIES = 32;
const MEMORY_ID = /^mem_[a-f0-9]{64}$/;

type Sql = {
  exec<T = any>(query: string, ...bindings: any[]): { toArray(): T[] };
};

export type UsageVerification = { memoryId: string; evidenceRef: string };

function validIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECEIPT_MEMORIES ||
      value.some((id) => typeof id !== "string" || !MEMORY_ID.test(id))) return null;
  const unique = [...new Set(value)] as string[];
  return unique.length === value.length ? unique : null;
}

function placeholders(length: number) {
  return Array(length).fill("?").join(",");
}

export class LearnUsageStore {
  private preparations = 0;
  constructor(
    private readonly sql: Sql,
    private readonly atomic: <T>(operation: () => T) => T = (operation) => operation(),
  ) {}

  initialize() {
    const columns = new Set(this.sql.exec<{ name: string }>(
      `PRAGMA table_info(${MEMORY_TABLE})`,
    ).toArray().map(row => row.name));
    const additions = [
      ["usage_retrieved", "INTEGER NOT NULL DEFAULT 0"],
      ["usage_evaluated", "INTEGER NOT NULL DEFAULT 0"],
      ["usage_applied", "INTEGER NOT NULL DEFAULT 0"],
      ["usage_verified", "INTEGER NOT NULL DEFAULT 0"],
      ["usage_last_retrieved", "TEXT"],
      ["usage_last_applied", "TEXT"],
      ["usage_last_verified", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.sql.exec(`ALTER TABLE ${MEMORY_TABLE} ADD COLUMN ${name} ${definition}`);
      }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${RECEIPT_TABLE} (
      receipt_id TEXT PRIMARY KEY,
      memory_ids TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      reported_at INTEGER
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS learning_usage_receipt_expiry
      ON ${RECEIPT_TABLE}(expires_at)`);
  }

  createReceipt(value: unknown, now = Date.now()) {
    const requested = validIds(value);
    if (!requested || requested.length === 0) {
      return { receiptId: null, tracked: 0 };
    }
    const existing = this.sql.exec<{ id: string }>(
      `SELECT id FROM ${MEMORY_TABLE} WHERE id IN (${placeholders(requested.length)})`,
      ...requested,
    ).toArray();
    const allowed = new Set(existing.map(row => row.id));
    const ids = requested.filter(id => allowed.has(id));
    if (!ids.length) return { receiptId: null, tracked: 0 };

    this.preparations++;
    if (this.preparations === 1 || this.preparations % 64 === 0) {
      this.sql.exec(`DELETE FROM ${RECEIPT_TABLE} WHERE receipt_id IN
        (SELECT receipt_id FROM ${RECEIPT_TABLE} WHERE expires_at <= ? LIMIT 64)`, now);
    }
    const receiptId = crypto.randomUUID();
    return this.atomic(() => {
      this.sql.exec(`INSERT INTO ${RECEIPT_TABLE}
        (receipt_id, memory_ids, expires_at, reported_at) VALUES (?, ?, ?, NULL)`,
        receiptId, JSON.stringify(ids), now + RECEIPT_TTL_MS);
      this.sql.exec(`UPDATE ${MEMORY_TABLE}
        SET usage_retrieved = usage_retrieved + 1, usage_last_retrieved = ?
        WHERE id IN (${placeholders(ids.length)})`, new Date(now).toISOString(), ...ids);
      return { receiptId, tracked: ids.length };
    });
  }

  report(receiptId: unknown, appliedValue: unknown, verifiedValue: unknown, now = Date.now()) {
    if (typeof receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(receiptId)) {
      return { ok: false, status: 400, error: "invalid_receipt" };
    }
    const applied = validIds(appliedValue);
    const verified = verifiedValue == null ? [] : verifiedValue;
    if (!applied || !Array.isArray(verified) || verified.length > MAX_RECEIPT_MEMORIES) {
      return { ok: false, status: 400, error: "invalid_usage_report" };
    }
    const receipt = this.sql.exec<{
      memory_ids: string; expires_at: number; reported_at: number | null;
    }>(`SELECT memory_ids, expires_at, reported_at FROM ${RECEIPT_TABLE}
      WHERE receipt_id = ? LIMIT 1`, receiptId).toArray()[0];
    if (!receipt) return { ok: false, status: 404, error: "receipt_not_found" };
    if (receipt.reported_at != null) return { ok: true, changed: false, evaluated: 0, applied: 0, verified: 0 };
    if (receipt.expires_at <= now) return { ok: false, status: 410, error: "receipt_expired" };

    const ids = JSON.parse(receipt.memory_ids) as string[];
    const eligible = new Set(ids);
    const appliedSet = new Set(applied);
    if (applied.some(id => !eligible.has(id))) {
      return { ok: false, status: 400, error: "memory_not_in_prepared_context" };
    }
    const verifiedIds: string[] = [];
    for (const evidence of verified as UsageVerification[]) {
      const id = evidence?.memoryId;
      const ref = typeof evidence?.evidenceRef === "string" ? evidence.evidenceRef.trim() : "";
      if (!MEMORY_ID.test(id) || !appliedSet.has(id) || verifiedIds.includes(id) ||
          ref.length < 8 || ref.length > 200 || /[\n\r<>]/.test(ref)) {
        return { ok: false, status: 400, error: "invalid_verification_evidence" };
      }
      verifiedIds.push(id);
    }

    // Atomic receipt and aggregate update; retries cannot double-count.
    return this.atomic(() => {
      this.sql.exec(`UPDATE ${RECEIPT_TABLE} SET reported_at = ?
        WHERE receipt_id = ? AND reported_at IS NULL`, now, receiptId);
      this.sql.exec(`UPDATE ${MEMORY_TABLE}
        SET usage_evaluated = usage_evaluated + 1
        WHERE id IN (${placeholders(ids.length)})`, ...ids);
      const timestamp = new Date(now).toISOString();
      if (applied.length) this.sql.exec(`UPDATE ${MEMORY_TABLE}
        SET usage_applied = usage_applied + 1, usage_last_applied = ?
        WHERE id IN (${placeholders(applied.length)})`, timestamp, ...applied);
      if (verifiedIds.length) this.sql.exec(`UPDATE ${MEMORY_TABLE}
        SET usage_verified = usage_verified + 1, usage_last_verified = ?
        WHERE id IN (${placeholders(verifiedIds.length)})`, timestamp, ...verifiedIds);
      return { ok: true, changed: true, evaluated: ids.length, applied: applied.length, verified: verifiedIds.length };
    });
  }
}
