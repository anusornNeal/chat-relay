import assert from "node:assert/strict";
import test from "node:test";
import { deliverUsageBatch } from "../src/usage-batch.mjs";
import { UsageBatchReceipts } from "../src/usage-batch-receipts.mjs";

const UUID = "1b2079e5-8e83-4b63-952a-4122183d02c7";

test("successful usage batch is sent once with stable id", async () => {
  const ids = [];
  const result = await deliverUsageBatch([1], async (_, id) => { ids.push(id); return { ok: true }; }, { batchId: UUID });
  assert.equal(result.delivered, true);
  assert.deepEqual(ids, [UUID]);
});

test("explicit 503 retry preserves idempotency token and bounded backoff", async () => {
  const ids = [], delays = [];
  const result = await deliverUsageBatch([1], async (_, id) => {
    ids.push(id);
    return { ok: ids.length === 3, status: 503 };
  }, { batchId: UUID, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result.delivered, true);
  assert.deepEqual(ids, [UUID, UUID, UUID]);
  assert.deepEqual(delays, [150, 300]);
});

test("nonretryable HTTP statuses and transient exhaustion terminate", async () => {
  for (const status of [400, 401, 409]) {
    let sends = 0;
    const result = await deliverUsageBatch([1], async () => {
      sends++;
      return { ok: false, status };
    });
    assert.equal(result.delivered, false);
    assert.equal(sends, 1);
  }
  let sends = 0;
  const failed = await deliverUsageBatch([1], async () => {
    sends++;
    return { ok: false, status: 503 };
  }, { sleep: async () => {} });
  assert.equal(failed.delivered, false);
  assert.equal(sends, 3);
});

test("ambiguous dropped acknowledgement retries the same batch UUID", async () => {
  let sends = 0;
  const ids = [];
  const result = await deliverUsageBatch([1], async (_, id) => {
    ids.push(id);
    if (++sends === 1) throw Error("acknowledgement lost after commit");
    return { ok: true };
  }, { batchId: UUID, sleep: async () => {} });
  assert.equal(result.delivered, true);
  assert.deepEqual(ids, [UUID, UUID]);
});

test("persistent network exception reports an uncertain result after three attempts", async () => {
  let sends = 0;
  const result = await deliverUsageBatch([1], async () => {
    sends++;
    throw Error("network disconnected");
  }, { sleep: async () => {} });
  assert.equal(sends, 3);
  assert.equal(result.uncertain, true);
  assert.equal(result.delivered, false);
});

test("receipt ensures duplicate batch applies once, including restart", async () => {
  const records = new Map();
  const storage = {
    async get(key) { return records.get(key); },
    async put(key,value) { records.set(key,value); },
    async transaction(fn) {
      const saved = new Map(records);
      try { return await fn(); } catch (error) {
        records.clear();
        for (const [key, value] of saved) records.set(key,value);
        throw error;
      }
    },
  };
  let calls = 0;
  const first = new UsageBatchReceipts(storage);
  assert.deepEqual(await first.record(UUID, async () => { calls++; }), { duplicate: false });
  const restarted = new UsageBatchReceipts(storage);
  assert.deepEqual(await restarted.record(UUID, async () => { calls++; }), { duplicate: true });
  assert.equal(calls, 1);
});

test("failed aggregation rolls back receipt so next attempt can succeed", async () => {
  const data = new Map();
  const storage = {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key,value); },
    async transaction(fn) {
      const before = new Map(data);
      try { return await fn(); } catch(error) { data.clear(); for (const [k,v] of before) data.set(k,v); throw error; }
    },
  };
  const receipts = new UsageBatchReceipts(storage);
  await assert.rejects(receipts.record(UUID, async () => { throw new Error("SQL failure"); }));
  assert.deepEqual(await receipts.record(UUID, async () => {}), { duplicate: false });
});

test("SQL receipt path performs no writes on a duplicate", async () => {
  const ids = new Set();
  let changes = 0;
  let inserts = 0;
  const storage = {
    sql: {
      exec(query, ...args) {
        if (query.startsWith("INSERT OR IGNORE")) {
          changes = ids.has(args[0]) ? 0 : 1;
          if (changes) { ids.add(args[0]); inserts++; }
        } else if (query.includes("SELECT changes()")) {
          return { toArray: () => [{ changed: changes }] };
        }
        return { toArray: () => [] };
      },
    },
    transaction: async (fn) => fn(),
  };
  const receipts = new UsageBatchReceipts(storage);
  let applied = 0;
  await receipts.record(UUID, async () => { applied++; });
  await receipts.record(UUID, async () => { applied++; });
  assert.equal(applied, 1);
  assert.equal(inserts, 1);
});
