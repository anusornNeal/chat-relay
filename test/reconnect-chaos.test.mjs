import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentConnectionState,
  classifySocketDisconnect,
  computeReconnectDelay,
} from "../agent/connection-state.mjs";

test("simulated burst of abnormal closes backs off and recovers without stale state", () => {
  const state = new AgentConnectionState();
  const delays = [];
  state.markConnected(1_000);
  for (let index = 1; index <= 100; index++) {
    state.markDisconnected(1006, "socket_closed", index * 1_000 + 1_000);
    assert.equal(state.snapshot().lastDisconnectCategory, "abnormal_transport");
    const delay = state.nextDelay(() => 0.5);
    state.scheduleReconnect(delay, index * 1_000 + 1_000);
    delays.push(delay);
    assert.ok(delay >= 100 && delay <= 30_000);
  }
  assert.deepEqual(delays.slice(0, 4), [2_000, 4_000, 8_000, 16_000]);
  assert.equal(delays.at(-1), 30_000);
  assert.equal(state.snapshot().reconnectCount, 100);
  state.markConnected(120_000);
  assert.equal(state.snapshot().reconnectAttempt, 0);
  assert.equal(state.snapshot().nextReconnectAt, null);
  assert.equal(state.nextDelay(() => 0.5), 2_000);
});

test("isolated DNS, network reset and heartbeat failures classify without payloads", () => {
  for (const [code, reason, category] of [
    [1006, "ENOTFOUND", "dns"],
    [1006, "ECONNRESET", "network"],
    [1006, "ETIMEDOUT", "timeout"],
    [1006, "heartbeat_ack_timeout", "timeout"],
    [1012, "restart_requested", "restart"],
    [4001, "credential_revoked", "authorization"],
  ]) {
    const state = new AgentConnectionState();
    state.markConnected(1_000);
    state.markSocketError(reason);
    state.markDisconnected(code, "socket_closed", 2_000);
    assert.equal(state.snapshot().lastDisconnectCategory, category);
  }
  assert.equal(classifySocketDisconnect(1006, "socket_closed", null), "abnormal_transport");
});

test("randomized jitter remains bounded at every reconnect attempt", () => {
  for (let attempt = 1; attempt <= 1000; attempt++) {
    for (const value of [0, 0.5, 1]) {
      const ms = computeReconnectDelay(attempt, { random: () => value });
      assert.ok(Number.isInteger(ms) && ms >= 100 && ms <= 30_000);
    }
  }
});
