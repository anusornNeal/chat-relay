import assert from "node:assert/strict";
import test from "node:test";
import { AgentConnectionState, safeConnectionReason } from "../agent/connection-state.mjs";

import {
  AGENT_CONNECTION_EVENT_LIMIT,
  AGENT_PROCESS_EPOCH_LIMIT,
  appendAgentConnectionEvent,
  emptyAgentDiagnostics,
  recordAgentProcessEpoch,
  normalizeAgentHealth,
  normalizeAgentLifecycle,
  normalizeAgentDiagnosticReason,
  agentConnectionGeneration,
  isAuthoritativeAgentSocket,
  nextAgentConnectionGeneration,
  selectLatestAgentSocket,
} from "../src/agent-state.ts";

test("disconnect diagnostics survive process epochs and exclude sensitive input", () => {
  let diagnostics = appendAgentConnectionEvent(emptyAgentDiagnostics(), { type: "accepted", at: 1 });
  diagnostics = recordAgentProcessEpoch(diagnostics, {
    processId: 101,
    seenAt: 2,
    health: {
      processStartedAt: "2026-10-01T00:00:00.000Z",
      reconnectCount: 3,
      lastCloseCode: 1006,
      lastConnectionDurationMs: 1200,
      lastDisconnectReason: "token=secret user command",
      lastSocketError: "Authorization: Bearer sensitive",
      headers: { authorization: "secret" },
      payload: "private user content",
    },
  });
  diagnostics = appendAgentConnectionEvent(diagnostics, { type: "closed", at: 3, closeCode: 1006 });
  diagnostics = recordAgentProcessEpoch(diagnostics, {
    processId: 202,
    seenAt: 4,
    health: { processStartedAt: "2026-10-02T00:00:00.000Z", reconnectCount: 1, lastDisconnectedAt: "2026-10-02T00:01:00.000Z", lastDisconnectReason: "socket_closed", lastSocketError: "getaddrinfo ENOTFOUND internal.example" },
  });

  assert.equal(diagnostics.processEpochs.length, 2);
  assert.equal(diagnostics.totalAccepted, 1);
  assert.equal(diagnostics.totalDisconnected, 1);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  assert.equal(JSON.stringify(diagnostics).includes("private user content"), false);
  assert.equal(JSON.stringify(diagnostics).includes("internal.example"), false);
  assert.equal(diagnostics.processEpochs[1].lastDisconnectReason, "socket_closed");
  assert.equal(diagnostics.processEpochs[1].lastSocketError, "ENOTFOUND");
  assert.equal(diagnostics.processEpochs[1].lastDisconnectedAt, "2026-10-02T00:01:00.000Z");
  assert.equal(JSON.stringify(normalizeAgentHealth({
    lastDisconnectReason: "token=secret",
    lastSocketError: "Authorization: Bearer sensitive",
  })).includes("secret"), false);
  assert.equal(normalizeAgentHealth({ lastSocketError: "connect ECONNRESET 10.0.0.1" }).lastSocketError, "ECONNRESET");
  assert.deepEqual(Object.keys(diagnostics.processEpochs[0]).sort(), [
    "firstSeenAt", "lastCloseCode", "lastConnectionDurationMs", "lastDisconnectReason",
    "lastDisconnectedAt", "lastSeenAt", "lastSocketError", "maxReconnectCount",
    "processId", "processStartedAt",
  ]);
});

function fakeSocket(attachment) {
  return { deserializeAttachment: () => attachment };
}

test("socket recovery chooses the greatest accepted generation instead of timestamps", () => {
  const older = fakeSocket({ connectionGeneration: 7, connectedAt: 500, lastSeenAt: 900 });
  const newer = fakeSocket({ connectionGeneration: 8, connectedAt: 100, lastSeenAt: 100 });

  assert.equal(selectLatestAgentSocket([older, newer]), newer);
  assert.equal(selectLatestAgentSocket([newer, older]), newer);
  assert.equal(agentConnectionGeneration(newer), 8);
});

test("socket recovery uses timestamps only for legacy sockets during rolling deploy", () => {
  const olderLegacy = fakeSocket({ connectedAt: 100, lastSeenAt: 900 });
  const newerLegacy = fakeSocket({ connectedAt: 200, lastSeenAt: 800 });
  const generated = fakeSocket({ connectionGeneration: 1, connectedAt: 50, lastSeenAt: 50 });
  const malformed = fakeSocket({ connectionGeneration: "999", lastSeenAt: 1000 });

  assert.equal(selectLatestAgentSocket([olderLegacy, newerLegacy]), olderLegacy);
  assert.equal(selectLatestAgentSocket([olderLegacy, generated]), generated);
  assert.equal(selectLatestAgentSocket([malformed]), null);
});

test("connection generations increase and never wrap", () => {
  assert.equal(nextAgentConnectionGeneration(undefined), 1);
  assert.equal(nextAgentConnectionGeneration(41), 42);
  assert.throws(() => nextAgentConnectionGeneration("41"), /invalid_agent_connection_generation/);
  assert.throws(() => nextAgentConnectionGeneration(Number.MAX_SAFE_INTEGER), /generation_exhausted/);
});

test("late close or error from an older socket cannot clear the authoritative socket", () => {
  const older = fakeSocket({ connectionGeneration: 11 });
  const newer = fakeSocket({ connectionGeneration: 12 });
  let authoritative = newer;
  const disconnect = (socket) => {
    if (isAuthoritativeAgentSocket(socket, authoritative)) authoritative = null;
  };

  disconnect(older); // late close
  disconnect(older); // late error
  assert.equal(authoritative, newer);
  disconnect(newer);
  assert.equal(authoritative, null);
});

test("disconnect diagnostics retention is bounded", () => {
  let diagnostics = emptyAgentDiagnostics();
  for (let index = 0; index < AGENT_CONNECTION_EVENT_LIMIT + 5; index += 1) {
    diagnostics = appendAgentConnectionEvent(diagnostics, { type: "closed", at: index + 1 });
  }
  for (let index = 0; index < AGENT_PROCESS_EPOCH_LIMIT + 3; index += 1) {
    diagnostics = recordAgentProcessEpoch(diagnostics, {
      processId: index + 1,
      seenAt: index + 1,
      health: { processStartedAt: new Date(index + 1).toISOString() },
    });
  }
  assert.equal(diagnostics.events.length, AGENT_CONNECTION_EVENT_LIMIT);
  assert.equal(diagnostics.processEpochs.length, AGENT_PROCESS_EPOCH_LIMIT);
  assert.equal(diagnostics.events[0].at, new Date(6).toISOString());
  assert.equal(diagnostics.processEpochs[0].processId, 4);
});

test("upgrade lifecycle and generation diagnostics survive normalization", () => {
  const lifecycle = normalizeAgentLifecycle({
    state: "upgrade-pending",
    drainStartedAt: "2026-10-04T00:00:00.000Z",
    upgradeRequestedAt: "2026-10-04T00:00:01.000Z",
    readyToUpgrade: true,
    work: { total: 0 },
  });
  assert.equal(lifecycle.state, "upgrade-pending");
  assert.equal(lifecycle.upgradeRequestedAt, "2026-10-04T00:00:01.000Z");
  assert.equal(lifecycle.readyToUpgrade, true);

  const health = normalizeAgentHealth({
    serverConnectionGeneration: 42,
    lastSocketError: "connection_generation_changed",
  });
  assert.equal(health.serverConnectionGeneration, 42);
  assert.equal(health.lastSocketError, "connection_generation_changed");
  assert.equal(normalizeAgentDiagnosticReason("upgrade_requested"), "upgrade_requested");
});

test("connection diagnostics classify closes without exposing socket payloads", () => {
  const state = new AgentConnectionState();
  state.markConnected(1_000);
  state.markSocketError("Authorization: Bearer secret=do-not-log");
  state.markDisconnected(1006, "token=secret user command", 2_000);
  const abnormal = state.snapshot();
  assert.equal(abnormal.lastSocketError, "socket_error");
  assert.equal(abnormal.lastDisconnectReason, "socket_error");
  assert.equal(abnormal.lastDisconnectCategory, "abnormal_transport");
  assert.equal(JSON.stringify(abnormal).includes("secret"), false);

  state.markConnected(3_000);
  state.markSocketError("transport_pong_timeout");
  state.markDisconnected(1006, "socket_closed", 4_000);
  assert.equal(state.snapshot().lastDisconnectCategory, "timeout");

  state.markConnected(5_000);
  state.markDisconnected(1006, "socket_closed", 6_000);
  assert.equal(state.snapshot().lastDisconnectCategory, "abnormal_transport", "old timeouts must not leak into new socket diagnoses");
  assert.equal(state.snapshot().lastSocketError, "transport_pong_timeout", "historical socket errors remain inspectable");
  assert.equal(safeConnectionReason("connect ECONNRESET 192.0.2.1"), "ECONNRESET");
  assert.equal(safeConnectionReason("unexpected_response_503"), "unexpected_response_503");
  assert.equal(safeConnectionReason("user private header"), "socket_error");
});
