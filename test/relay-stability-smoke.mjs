import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentConnectionState, computeReconnectDelay } from "../agent/connection-state.mjs";
import {
  HeartbeatAckWatchdog,
  HEARTBEAT_ACK_TIMEOUT_REASON,
} from "../agent/heartbeat-ack-watchdog.mjs";
import {
  createTerminalSessionId,
  terminalSessionMiss,
} from "../agent/terminal-continuity.mjs";
import {
  agentLiveness,
  isAuthoritativeAgentSocket,
  nextAgentConnectionGeneration,
  selectLatestAgentSocket,
} from "../src/agent-state.ts";
import {
  acquireRunnerOwnership,
  RunnerAlreadyActiveError,
} from "../cli/runner-ownership.mjs";
import { protocolCompatibility, shouldRestartAgent } from "../cli/remote.mjs";
import { attachmentSocket, readProjectSource, runTests } from "./fixtures/stability-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function testTransportAndLogicalLivenessAreIndependent() {
  const socket = attachmentSocket({
    connectionGeneration: 1,
    connectedAt: 1,
    lastSeenAt: 1,
    heartbeatEnabled: true,
    heartbeatMs: 5_000,
    processId: 101,
  });
  const stale = agentLiveness(socket);
  assert.equal(stale.connected, true);
  assert.equal(stale.online, false);
  assert.equal(stale.stale, true);

  const absent = agentLiveness(null);
  assert.equal(absent.connected, false);
  assert.equal(absent.online, false);
}

async function testDuplicateRunnerOwnershipIsRejected() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-relay-stability-owner-"));
  const options = {
    directory,
    relayUrl: "https://relay.example",
    agentId: "stability-agent",
    startupGraceMs: 50,
    probeTimeoutMs: 150,
  };
  let owner;
  try {
    owner = await acquireRunnerOwnership(options);
    await assert.rejects(
      acquireRunnerOwnership(options),
      (error) => error instanceof RunnerAlreadyActiveError && error.code === "CHAT_RELAY_RUNNER_ACTIVE",
    );
    const otherAgent = await acquireRunnerOwnership({ ...options, agentId: "stability-agent-2" });
    await otherAgent.release();
  } finally {
    await owner?.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testGenerationSafeSocketRecoveryAndLateClose() {
  const older = attachmentSocket({ connectionGeneration: 7, connectedAt: 500, lastSeenAt: 900 });
  const newer = attachmentSocket({ connectionGeneration: 8, connectedAt: 100, lastSeenAt: 100 });

  assert.equal(selectLatestAgentSocket([older, newer]), newer);
  assert.equal(selectLatestAgentSocket([newer, older]), newer);
  assert.equal(isAuthoritativeAgentSocket(older, newer), false);
  assert.equal(isAuthoritativeAgentSocket(newer, newer), true);
  assert.equal(nextAgentConnectionGeneration(8), 9);
  assert.throws(
    () => nextAgentConnectionGeneration(Number.MAX_SAFE_INTEGER),
    /agent_connection_generation_exhausted/,
  );
}

async function testHeartbeatAckLossForcesDeterministicRecovery() {
  let now = 1_000;
  let scheduled = null;
  let timedOut = null;
  const watchdog = new HeartbeatAckWatchdog({
    timeoutMs: 1_000,
    now: () => now,
    setTimer: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
    onTimeout: (event) => {
      timedOut = event;
    },
  });

  watchdog.start();
  now = 1_500;
  watchdog.acknowledge();
  assert.equal(watchdog.snapshot().active, true);
  assert.equal(timedOut, null);

  now = 2_501;
  scheduled();
  assert.equal(timedOut.reason, HEARTBEAT_ACK_TIMEOUT_REASON);
  assert.equal(watchdog.snapshot().active, false);
  assert.equal(watchdog.snapshot().lastTimeoutReason, HEARTBEAT_ACK_TIMEOUT_REASON);

  const state = new AgentConnectionState({ baseReconnectMs: 100, maxReconnectMs: 400 });
  state.markConnected(1_000);
  state.markSocketError(HEARTBEAT_ACK_TIMEOUT_REASON);
  state.markDisconnected(1006, HEARTBEAT_ACK_TIMEOUT_REASON, 2_000);
  assert.equal(state.snapshot().lastSocketError, HEARTBEAT_ACK_TIMEOUT_REASON);
  assert.equal(state.snapshot().state, "waiting");
  const noCloseCode = new AgentConnectionState({ baseReconnectMs: 100, maxReconnectMs: 400 });
  noCloseCode.markConnected(1_000);
  noCloseCode.markDisconnected(null, "unexpected_response_409", 1_500);
  assert.equal(noCloseCode.snapshot().lastCloseCode, null);
  assert.equal(noCloseCode.snapshot().lastDisconnectReason, "unexpected_response_409");
  assert.equal(
    computeReconnectDelay(3, { baseMs: 100, maxMs: 400, jitterRatio: 0, random: () => 0.5 }),
    400,
  );
}

async function testUnexpectedHandshakeResponseRecovers() {
  const localSource = await readProjectSource(root, "agent/local-agent.mjs");
  const handlerAt = localSource.indexOf('socket.on("unexpected-response"');
  assert.ok(handlerAt >= 0, "missing unexpected-response handler");
  const closeAt = localSource.indexOf('socket.on("close"', handlerAt);
  const handler = localSource.slice(handlerAt, closeAt);
  assert.match(handler, /response\.resume\(\)/, "unexpected HTTP response body is not drained");
  assert.match(handler, /activeSocket = null/, "unexpected handshake response does not release the failed socket");
  assert.match(handler, /scheduleReconnect\(null, reason\)/, "unexpected handshake response does not schedule recovery");
}

async function testTerminalRestartIsExplicitAndSocketReconnectSafe() {
  const oldSession = createTerminalSessionId("process-old", "session-1");
  const restarted = terminalSessionMiss(oldSession, "process-new");
  assert.equal(restarted.error, "terminal_session_epoch_mismatch");
  assert.equal(restarted.reason, "agent_process_restarted");
  assert.equal(restarted.recovery, "start_new_session");
  assert.equal(restarted.resumable, false);

  const unknownSameEpoch = terminalSessionMiss(
    createTerminalSessionId("process-new", "missing"),
    "process-new",
  );
  assert.equal(unknownSameEpoch.error, "session_not_found");
}

async function testTerminalToolSchemaAcceptsRestartAwareIds() {
  const workerSource = await readProjectSource(root, "src/worker-app.ts");
  assert.match(workerSource, /const terminalSessionIdSchema = z\.union\(/);
  const mcpServerAt = workerSource.indexOf("function createMcpServer");
  assert.ok(mcpServerAt >= 0, "missing MCP server implementation");
  for (const toolName of [
    "terminal_read",
    "terminal_write",
    "terminal_kill",
    "read_process_output",
    "interact_with_process",
    "force_terminate",
  ]) {
    const toolAt = workerSource.indexOf(`"${toolName}"`, mcpServerAt);
    assert.ok(toolAt >= 0, `missing tool schema for ${toolName}`);
    const nextToolAt = workerSource.indexOf("register(", toolAt + toolName.length + 2);
    const toolBlock = workerSource.slice(toolAt, nextToolAt >= 0 ? nextToolAt : toolAt + 1600);
    assert.match(toolBlock, /sessionId:\s*terminalSessionIdSchema/, `${toolName} rejects restart-aware terminal IDs`);
  }
}

async function testRecoveryStaysInsideRemoteSupervisor() {
  const remoteSource = await readProjectSource(root, "cli/remote.mjs");
  const acquireAt = remoteSource.indexOf("acquireRunnerOwnership");
  const loopAt = remoteSource.indexOf("while (!stopping)");
  const releaseAt = remoteSource.lastIndexOf("ownership.release");
  assert.ok(acquireAt >= 0 && loopAt > acquireAt && releaseAt > loopAt,
    "runner ownership must wrap the supervisor restart loop");

  assert.equal(shouldRestartAgent({ code: 4 }), true);
  assert.equal(shouldRestartAgent({ code: 2 }), false);
  assert.equal(shouldRestartAgent({ code: 3 }), false);
  assert.equal(shouldRestartAgent({ code: 1 }, true), false);
  assert.equal(protocolCompatibility(1, 1), "compatible");
  assert.equal(protocolCompatibility(1, 2), "incompatible");
}

const tests = [
  ["transport and logical liveness are independent", testTransportAndLogicalLivenessAreIndependent],
  ["duplicate runners are rejected before opening a competing connection", testDuplicateRunnerOwnershipIsRejected],
  ["socket recovery and late-close authority are generation-safe", testGenerationSafeSocketRecoveryAndLateClose],
  ["heartbeat ACK loss forces deterministic recovery", testHeartbeatAckLossForcesDeterministicRecovery],
  ["unexpected handshake responses drain and reconnect", testUnexpectedHandshakeResponseRecovers],
  ["terminal process restart is explicit while same-process identity remains distinct", testTerminalRestartIsExplicitAndSocketReconnectSafe],
  ["terminal MCP schemas accept restart-aware session IDs", testTerminalToolSchemaAcceptsRestartAwareIds],
  ["recovery stays inside the existing remote supervisor", testRecoveryStaysInsideRemoteSupervisor],
];

await runTests(tests);
console.log("relay stability smoke test passed");
