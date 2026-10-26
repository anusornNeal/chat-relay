// Exactly-once within the receipt retention window, without per-tool-call storage.
// The receipt and hourly usage upserts must commit in the same DO transaction.
const RECEIPT_PREFIX = "usage:batch:";
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 512;

export class UsageBatchReceipts {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql ?? null;
    this.accepted = 0;
    if (this.sql) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS usage_batch_receipts (
        batch_id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL
      ) WITHOUT ROWID`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS idx_usage_batch_recorded_at ON usage_batch_receipts(recorded_at)");
    }
  }

  async record(batchId, apply, now = Date.now()) {
    if (!batchId) {
      await apply();
      return { duplicate: false };
    }
    const fresh = await this.storage.transaction(async () => {
      if (this.sql) {
        this.sql.exec("INSERT OR IGNORE INTO usage_batch_receipts (batch_id, recorded_at) VALUES (?, ?)", batchId, now);
        const changed = this.sql.exec("SELECT changes() AS changed").toArray()[0]?.changed;
        if (Number(changed) === 0) return false;
      } else {
        const key = RECEIPT_PREFIX + batchId;
        if (await this.storage.get(key)) return false;
        await this.storage.put(key, now);
      }
      await apply();
      return true;
    });
    if (fresh && this.sql && ++this.accepted % PRUNE_EVERY === 0) {
      try {
        // Opportunistic bounded cleanup; older retries are no longer protected.
        this.sql.exec(`DELETE FROM usage_batch_receipts WHERE batch_id IN
          (SELECT batch_id FROM usage_batch_receipts WHERE recorded_at < ? LIMIT 128)`, now - RETAIN_MS);
      } catch {
        // Never invalidate successful accounting because cleanup failed.
      }
    }
    return { duplicate: !fresh };
  }
}
