import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentConnectionState, computeReconnectDelay } from "../agent/connection-state.mjs";
import { protocolCompatibility, shouldRestartAgent } from "../cli/remote.mjs";
import { agentLiveness } from "../src/agent-state.ts";
import {
  assertInOrder,
  attachmentSocket,
  readProjectSource,
  runTests,
  sourceBlock,
} from "./fixtures/stability-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function testTransportAndLogicalLivenessAreIndependent() {
  const attachment = {
    connectedAt: 1,
    lastSeenAt: 1,
    heartbeatEnabled: true,
    heartbeatMs: 5_000,
    processId: 101,
  };
  const socket = attachmentSocket(attachment);

  const stale = agentLiveness(socket);
  assert.equal(stale.connected, true, "open transport must remain distinguishable from logical liveness");
  assert.equal(stale.online, false, "stale heartbeat must make a connected transport logically offline");
  assert.equal(stale.stale, true);

  const absent = agentLiveness(null);
  assert.equal(absent.connected, false);
  assert.equal(absent.online, false);
}

async function testReplacementAndLateCloseContracts() {
  const relaySource = await readProjectSource(root, "src/index.ts");
  const connectBody = sourceBlock(relaySource, "private connectAgent(");
  const disconnectBody = sourceBlock(relaySource, "private disconnect(");

  assertInOrder(connectBody, ["existingAgent.close", "this.agent = server"], "agent replacement");
  assert.match(disconnectBody, /if\s*\(socket\s*!==\s*this\.agent\)\s*return/,
    "a late close from the replaced socket must not disconnect its replacement");

  assert.equal(shouldRestartAgent({ code: 1 }), true, "a crashed runner must be replaced");
  assert.equal(shouldRestartAgent({ code: 2 }), false, "reauthorization must not create a replacement loop");
  assert.equal(shouldRestartAgent({ code: 3 }), false, "protocol mismatch must not create a replacement loop");
  assert.equal(shouldRestartAgent({ code: 1 }, true), false, "intentional shutdown must not replace the runner");
  assert.equal(protocolCompatibility(1, 1), "compatible");
  assert.equal(protocolCompatibility(1, 2), "incompatible");
}

async function testHeartbeatAckLossTerminatesLiveTransport() {
  const agentSource = await readProjectSource(root, "agent/local-agent.mjs");
  const heartbeatBody = sourceBlock(agentSource, "function sendHeartbeat(");

  assert.match(heartbeatBody, /socket\s*!==\s*activeSocket\s*\|\|\s*socket\.readyState\s*!==\s*WebSocket\.OPEN/,
    "heartbeat must act only on the active open transport");
  assertInOrder(
    heartbeatBody,
    ["lastHeartbeatAckAt", "HEARTBEAT_ACK_TIMEOUT_MS", 'markSocketError("heartbeat_ack_timeout")', "socket.terminate()"],
    "heartbeat ACK deadline",
  );

  const state = new AgentConnectionState({ baseReconnectMs: 100, maxReconnectMs: 400 });
  state.markConnected(1_000);
  state.markSocketError("heartbeat_ack_timeout");
  state.markDisconnected(1006, "heartbeat_ack_timeout", 2_000);
  assert.equal(state.snapshot().lastSocketError, "heartbeat_ack_timeout");
  assert.equal(state.snapshot().state, "waiting");
  assert.equal(computeReconnectDelay(3, { baseMs: 100, maxMs: 400, jitterRatio: 0, random: () => 0.5 }), 400);
}

async function testProcessRestartInvalidatesTerminalIdentity() {
  const terminalSource = await readProjectSource(root, "agent/terminal-manager.mjs");
  const managerSource = terminalSource.slice(terminalSource.indexOf("export class TerminalManager"));
  const constructorBody = sourceBlock(managerSource, "constructor(");
  const lookupBody = sourceBlock(managerSource, "  #get(sessionId)");

  assert.match(constructorBody, /this\.sessions\s*=\s*new Map\(\)/,
    "terminal identities must be scoped to one manager process");
  assertInOrder(lookupBody, ["this.sessions.get(sessionId)", 'throw new Error("session_not_found")'],
    "terminal identity lookup");
}

async function testRecoveryStaysInsideRemoteSupervisor() {
  const remoteSource = await readProjectSource(root, "cli/remote.mjs");
  const remoteBody = sourceBlock(remoteSource, "export async function remote(");

  assert.equal(shouldRestartAgent({ code: 4 }), true, "requested restart must remain recoverable");
  assertInOrder(remoteBody, ["while (!stopping)", "spawnAgent(config)", "result.code === 4", "continue"], "remote supervisor recovery");
  assert.doesNotMatch(remoteBody, /\bnpx\b/, "recovery must not require invoking npx again");
}

const tests = [
  ["transport and logical liveness are independent", testTransportAndLogicalLivenessAreIndependent],
  ["duplicate runners and late closes cannot replace the active connection", testReplacementAndLateCloseContracts],
  ["heartbeat ACK loss terminates a live transport", testHeartbeatAckLossTerminatesLiveTransport],
  ["process restart invalidates old terminal identity", testProcessRestartInvalidatesTerminalIdentity],
  ["recovery stays inside the existing remote supervisor", testRecoveryStaysInsideRemoteSupervisor],
];

await runTests(tests);

console.log("relay stability smoke test passed");
