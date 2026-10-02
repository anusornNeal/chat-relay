import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CONNECTION_EVENT_LIMIT,
  AGENT_PROCESS_EPOCH_LIMIT,
  appendAgentConnectionEvent,
  emptyAgentDiagnostics,
  recordAgentProcessEpoch,
  normalizeAgentHealth,
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
