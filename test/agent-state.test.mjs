import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CONNECTION_EVENT_LIMIT,
  AGENT_PROCESS_EPOCH_LIMIT,
  appendAgentConnectionEvent,
  emptyAgentDiagnostics,
  recordAgentProcessEpoch,
  normalizeAgentHealth,
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
    health: { processStartedAt: "2026-10-02T00:00:00.000Z", reconnectCount: 1 },
  });

  assert.equal(diagnostics.processEpochs.length, 2);
  assert.equal(diagnostics.totalAccepted, 1);
  assert.equal(diagnostics.totalDisconnected, 1);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  assert.equal(JSON.stringify(diagnostics).includes("private user content"), false);
  assert.equal(JSON.stringify(normalizeAgentHealth({
    lastDisconnectReason: "token=secret",
    lastSocketError: "Authorization: Bearer sensitive",
  })).includes("secret"), false);
  assert.deepEqual(Object.keys(diagnostics.processEpochs[0]).sort(), [
    "firstSeenAt", "lastCloseCode", "lastConnectionDurationMs", "lastSeenAt",
    "maxReconnectCount", "processId", "processStartedAt",
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
