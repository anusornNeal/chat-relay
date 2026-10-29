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

test("in-flight failures explicitly forbid automatic retries of unknown side effects", async () => {
  // Source contract: the Worker already dispatched the command; a disconnect,
  // timeout or oversized response cannot prove whether it executed.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const source = await readFile(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  for (const code of ["agent_disconnected", "agent_timeout", "agent_response_too_large"]) {
    const at = source.indexOf('"' + code + '"');
    assert.ok(at >= 0, "missing error: " + code);
    const snippet = source.slice(at, at + 160);
    if (code !== "agent_disconnected") {
      assert.ok(snippet.includes('executionStatus: "unknown"'), code + " must preserve uncertain execution");
      assert.ok(snippet.includes("retrySafe: false"), code + " must forbid blind retry");
    }
  }
  assert.ok(source.includes('pending.resolve(error(status, code, { executionStatus: "unknown", retrySafe: false }))'));
  assert.ok(source.includes("isAuthoritativeAgentSocket(socket, this.resolveAgent())"));
});

test("transport close 1006 is categorized without exposing private payload", () => {
  const state = new AgentConnectionState({baseReconnectMs:2000,maxReconnectMs:30000});
  state.markConnected(1000);
  state.markSocketError("Authorization: Bearer secret-data");
  state.markDisconnected(1006, "socket_closed", 32000);
  assert.equal(state.snapshot().lastCloseCode,1006);
  assert.equal(state.snapshot().lastDisconnectCategory,"abnormal_transport");
  assert.equal(state.snapshot().lastSocketError,"socket_error");
  assert.ok(!JSON.stringify(state.snapshot()).includes("secret-data"));
  state.scheduleReconnect(250,32000);
  assert.equal(state.snapshot().nextReconnectDelayMs,250);
  state.markConnected(33000);
  assert.equal(state.snapshot().reconnectAttempt,0);
  assert.equal(state.snapshot().reconnectCount,1);
});
