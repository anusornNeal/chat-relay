import assert from "node:assert/strict";
import test from "node:test";

import { AgentConnectionState } from "../agent/connection-state.mjs";

test("heartbeat ACK generation is stable for one socket and resets on reconnect", () => {
  const state = new AgentConnectionState();
  state.markConnected(1000);

  assert.equal(state.markServerConnectionGeneration(undefined), true, "rolling-deploy ACK without generation stays compatible");
  assert.equal(state.markServerConnectionGeneration(7), true);
  assert.equal(state.snapshot().serverConnectionGeneration, 7);
  assert.equal(state.markServerConnectionGeneration(7), true);

  assert.equal(state.markServerConnectionGeneration(8), false);
  assert.equal(state.snapshot().lastSocketError, "connection_generation_changed");

  state.markDisconnected(1006, "socket_closed", 2000);
  state.markConnected(3000);
  assert.equal(state.snapshot().serverConnectionGeneration, null);
  assert.equal(state.markServerConnectionGeneration(8), true);
  assert.equal(state.snapshot().serverConnectionGeneration, 8);
});

test("invalid server connection generations force a reconnect decision", () => {
  const state = new AgentConnectionState();
  state.markConnected();
  assert.equal(state.markServerConnectionGeneration("not-a-generation"), false);
  assert.equal(state.snapshot().lastSocketError, "connection_generation_changed");
});
