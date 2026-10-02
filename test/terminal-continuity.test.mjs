import assert from "node:assert/strict";
import {
  createTerminalSessionId,
  parseTerminalSessionId,
  terminalContinuityConfig,
  terminalSessionMiss,
} from "../agent/terminal-continuity.mjs";

const sessionId = createTerminalSessionId("epoch-a", "session-a");
assert.deepEqual(parseTerminalSessionId(sessionId), {
  processEpoch: "epoch-a",
  sessionUuid: "session-a",
});

assert.deepEqual(terminalSessionMiss(sessionId, "epoch-b"), {
  ok: false,
  error: "terminal_session_epoch_mismatch",
  reason: "agent_process_restarted",
  sessionId,
  sessionProcessEpoch: "epoch-a",
  currentProcessEpoch: "epoch-b",
  resumable: false,
  recovery: "start_new_session",
});

assert.equal(terminalSessionMiss("unknown", "epoch-b").error, "session_not_found");

const continuity = terminalContinuityConfig("epoch-b", 2);
assert.equal(continuity.activeSessions, 2);
assert.equal(continuity.preservesSessionsAcrossSocketReconnect, true);
assert.equal(continuity.preservesSessionsAcrossProcessRestart, false);
assert.equal(continuity.resumableAfterProcessRestart, false);

console.log("terminal continuity tests passed");
