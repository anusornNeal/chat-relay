import assert from "node:assert/strict";
import test from "node:test";
import { deliverUsageBatch } from "../src/usage-batch.mjs";

test("successful usage batch is sent once", async () => {
  let sends = 0;
  const result = await deliverUsageBatch([1], async () => { sends++; return { ok: true }; });
  assert.equal(result.delivered, true);
  assert.equal(sends, 1);
});

test("retryable explicit errors recover within a bounded number of attempts", async () => {
  let sends = 0;
  const delays = [];
  const result = await deliverUsageBatch([1], async () => {
    sends++;
    return { ok: sends === 3, status: 503 };
  }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result.delivered, true);
  assert.equal(sends, 3);
  assert.deepEqual(delays, [150, 300]);
});

test("nonretryable statuses and retry exhaustion terminate", async () => {
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

test("ambiguous network exception does not replay potentially committed writes", async () => {
  let sends = 0;
  const result = await deliverUsageBatch([1], async () => {
    sends++;
    throw Error("network disconnected after server commit");
  });
  assert.equal(sends, 1);
  assert.equal(result.uncertain, true);
  assert.equal(result.delivered, false);
});
