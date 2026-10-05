import { spawn } from "node:child_process";
import { AgentConnectionState, computeReconnectDelay } from "../agent/connection-state.mjs";
import { protocolCompatibility, shouldRestartAgent } from "../cli/remote.mjs";
import { AgentLifecycle } from "../agent/lifecycle.mjs";
import { provisionOperatorFixture } from "./operator-fixture.mjs";

function connectionStateTests() {
  const options = { baseMs: 1000, maxMs: 4000, jitterRatio: 0.2, random: () => 0.5 };
  if (computeReconnectDelay(1, options) !== 1000) throw new Error("first reconnect delay failed");
  if (computeReconnectDelay(2, options) !== 2000) throw new Error("second reconnect delay failed");
  if (computeReconnectDelay(4, options) !== 4000) throw new Error("reconnect cap failed");

  const state = new AgentConnectionState({ baseReconnectMs: 1000, maxReconnectMs: 4000, heartbeatMs: 5000 });
  state.markConnecting(1000);
  state.markConnected(2000);
  state.markHeartbeat(2500);
  state.markSocketError("ECONNRESET");
  state.markDisconnected(1006, "network drop", 3000);
  if (state.nextDelay(() => 0.5) !== 1000) throw new Error("state reconnect delay failed");
  state.scheduleReconnect(1000, 3000);
  const waiting = state.snapshot();
  if (waiting.state !== "waiting" || waiting.lastCloseCode !== 1006 || waiting.lastDisconnectedAt !== new Date(3000).toISOString() || waiting.lastConnectionDurationMs !== 1000 || waiting.lastSocketError !== "ECONNRESET" || !waiting.nextReconnectAt) {
    throw new Error("connection waiting state failed");
  }
  state.markConnected(4000);
  const reconnected = state.snapshot();
  if (reconnected.reconnectAttempt !== 0) throw new Error("reconnect attempt did not reset");
  if (reconnected.reconnectCount !== 1 || reconnected.lastCloseCode !== 1006 || reconnected.lastDisconnectedAt !== new Date(3000).toISOString()) throw new Error("reconnect diagnostics were not retained");
  state.markReauthorization("credential_revoked", 5000);
  if (state.snapshot().state !== "reauthorization-required") throw new Error("reauthorization state failed");

  if (shouldRestartAgent({ code: 2 }) !== false) throw new Error("reauthorization restart loop guard failed");
  if (shouldRestartAgent({ code: 3 }) !== false) throw new Error("protocol mismatch restart loop guard failed");
  if (shouldRestartAgent({ code: 4 }) !== true) throw new Error("explicit restart exit code failed");
  if (shouldRestartAgent({ code: 5 }) !== false) throw new Error("upgrade handoff must not enter crash restart loop");
  if (protocolCompatibility(1, 1) !== "compatible" || protocolCompatibility(1, 2) !== "incompatible" || protocolCompatibility(null, 1) !== "unknown") throw new Error("protocol compatibility notice failed");
  if (shouldRestartAgent({ code: 1 }) !== true) throw new Error("crash restart policy failed");
  if (shouldRestartAgent({ code: 1 }, true) !== false) throw new Error("intentional stop restart guard failed");
}

function lifecycleTests() {
  let activeSessions = 1;
  const lifecycle = new AgentLifecycle({
    now: () => 1000,
    workSummary: () => ({ activeSessions }),
  });
  const drained = lifecycle.drain();
  if (drained.lifecycle.state !== "draining") throw new Error("drain state failed");
  if (!lifecycle.guard("terminal.start")?.error?.includes("agent_draining")) throw new Error("drain admission failed");
  if (lifecycle.guard("terminal.read") !== null) throw new Error("existing terminal control blocked during drain");
  if (lifecycle.requestRestart().error !== "active_work_remaining") throw new Error("active work restart guard failed");
  activeSessions = 0;
  if (!lifecycle.snapshot().readyToRestart) throw new Error("drain readiness failed");
  if (!lifecycle.requestRestart().ok || lifecycle.snapshot().state !== "restart-pending") throw new Error("graceful restart request failed");
  if (lifecycle.resume().error !== "restart_pending") throw new Error("restart pending resume guard failed");

  const recovery = new AgentLifecycle();
  recovery.drain();
  if (!recovery.resume().ok || recovery.snapshot().state !== "running") throw new Error("failed update recovery resume failed");

  const upgrade = new AgentLifecycle({ now: () => 2000, workSummary: () => ({}) });
  if (upgrade.requestUpgrade().error !== "drain_required") throw new Error("upgrade drain guard failed");
  upgrade.drain();
  const requestedUpgrade = upgrade.requestUpgrade();
  if (!requestedUpgrade.ok || !requestedUpgrade.upgrade || upgrade.snapshot().state !== "upgrade-pending") throw new Error("upgrade request failed");
  if (upgrade.resume().error !== "upgrade_pending") throw new Error("upgrade pending resume guard failed");
}

connectionStateTests();
lifecycleTests();

import { CapabilityScheduler } from "../agent/capability-scheduler.mjs";

async function schedulerTests() {
  let releaseFile;
  const fileGate = new Promise((resolve) => { releaseFile = resolve; });
  const scheduler = new CapabilityScheduler({
    fileConcurrency: 1,
    terminalExecConcurrency: 1,
    maxQueued: 1,
    queueTimeoutMs: 120,
  });

  const firstFile = scheduler.run("fs.read", async () => { await fileGate; return "first"; });
  let observedQueueWaitMs = -1;
  const secondFile = scheduler.run("fs.stat", async (meta = {}) => { observedQueueWaitMs = Number(meta.queueWaitMs); return "second"; });
  let overflow = null;
  try { await scheduler.run("fs.list", async () => "third"); }
  catch (error) { overflow = error instanceof Error ? error.message : String(error); }
  if (overflow !== "queue_full") throw new Error(`scheduler overflow failed: ${overflow}`);

  const terminal = await scheduler.run("terminal.exec", async () => "terminal");
  if (terminal !== "terminal") throw new Error("scheduler cross-lane fairness failed");
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFile();
  const fileResults = await Promise.all([firstFile, secondFile]);
  if (fileResults.join(",") !== "first,second") throw new Error("scheduler FIFO failed");
  if (!Number.isFinite(observedQueueWaitMs) || observedQueueWaitMs <= 0) throw new Error("scheduler queue wait metadata failed");

  let releaseTimeout;
  const timeoutGate = new Promise((resolve) => { releaseTimeout = resolve; });
  const timeoutScheduler = new CapabilityScheduler({ fileConcurrency: 1, maxQueued: 2, queueTimeoutMs: 120 });
  const blocker = timeoutScheduler.run("fs.read", async () => { await timeoutGate; return "done"; });
  const timed = timeoutScheduler.run("fs.stat", async () => "late")
    .then(() => "unexpected")
    .catch((error) => error instanceof Error ? error.message : String(error));
  await new Promise((resolve) => setTimeout(resolve, 160));
  if (await timed !== "queue_timeout") throw new Error("scheduler queue timeout failed");
  releaseTimeout();
  await blocker;
}

await schedulerTests();

const relayBase = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8794").replace(/\/$/, "");
const suffix = Date.now().toString(36);
const credentials = await provisionOperatorFixture(relayBase, {
  userId: `terminal-${suffix}`,
  name: "Terminal Smoke",
  agentId: `terminal-${suffix}`,
  agentName: "Terminal Smoke Agent",
});
const localAgent = spawn(process.execPath, ["agent/local-agent.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_URL: relayBase,
    AGENT_ID: credentials.agent.id,
    AGENT_NAME: credentials.agent.name,
    AGENT_TOKEN: credentials.agentToken,
    TERMINAL_ENABLED: "1",
    DESKTOP_ENABLED: "0",
    ALLOWED_ROOTS: process.cwd(),
    CHAT_RELAY_UI: "plain",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let agentOutput = "";
localAgent.stdout.on("data", (chunk) => { agentOutput += chunk.toString(); });
localAgent.stderr.on("data", (chunk) => { agentOutput += chunk.toString(); });
for (let attempt = 0; attempt < 80 && !agentOutput.includes("Agent connected"); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!agentOutput.includes("Agent connected")) {
  localAgent.kill();
  throw new Error(`local agent did not connect: ${agentOutput}`);
}
const cleanupAgent = () => { try { localAgent.kill(); } catch {} };
process.once("exit", cleanupAgent);
const base = `${relayBase}/mcp?key=${encodeURIComponent(credentials.userToken)}`;

async function rpc(id, method, params = {}) {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  if (!line) throw new Error(`missing MCP data: ${text}`);
  return JSON.parse(line.slice(6));
}

async function tool(id, name, args = {}) {
  const result = await rpc(id, "tools/call", { name, arguments: args });
  if (result.result?.isError) throw new Error(result.result.content?.[0]?.text ?? name);
  const relay = JSON.parse(result.result.content[0].text);
  return relay.payload;
}

const listed = await rpc(1, "tools/list");
const names = listed.result.tools.map((item) => item.name);
console.log("tools", names.join(", "));

const execResult = await tool(2, "terminal_exec", { command: "Write-Output terminal-exec-ok" });
if (!execResult.ok || !execResult.stdout.includes("terminal-exec-ok")) {
  throw new Error(`terminal_exec failed: ${JSON.stringify(execResult)}`);
}
console.log("exec ok");

const started = await tool(3, "terminal_start", {
  command: "1..3 | ForEach-Object { Write-Output ('tick ' + $_); Start-Sleep -Milliseconds 150 }",
});
await new Promise((resolve) => setTimeout(resolve, 700));
const output = await tool(4, "terminal_read", { sessionId: started.sessionId, afterSeq: 0 });
const joined = output.chunks.map((chunk) => chunk.text).join("");
if (!joined.includes("tick 1") || !joined.includes("tick 3")) {
  throw new Error(`terminal_start/read failed: ${JSON.stringify(output)}`);
}
console.log("long-running session ok");

const batchStartedAt = Date.now();
const batch = await tool(20, "terminal_batch_start", {
  concurrency: 4,
  jobs: Array.from({ length: 5 }, (_, index) => ({
    command: `Start-Sleep -Milliseconds 400; Write-Output batch-${index}`,
  })),
});
if (!batch.ok || batch.jobs.length !== 5 || Date.now() - batchStartedAt > 2500) {
  throw new Error(`terminal_batch_start failed: ${JSON.stringify(batch)}`);
}
let batchStatus = batch;
for (let attempt = 0; attempt < 30 && !batchStatus.endedAt; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  batchStatus = await tool(21 + attempt, "terminal_batch_status", { batchId: batch.batchId });
}
if (!batchStatus.endedAt || batchStatus.counts.completed !== 5) {
  throw new Error(`terminal_batch_status failed: ${JSON.stringify(batchStatus)}`);
}
const batchRead = await tool(60, "terminal_batch_read", { batchId: batch.batchId });
const batchText = batchRead.jobs.map((job) => job.stdout).join("\n");
if (!batchText.includes("batch-0") || !batchText.includes("batch-4")) {
  throw new Error(`terminal_batch_read failed: ${JSON.stringify(batchRead)}`);
}
console.log("batch terminal ok");

const shell = await tool(5, "terminal_start_shell");
await new Promise((resolve) => setTimeout(resolve, 300));
await tool(6, "terminal_write", {
  sessionId: shell.sessionId,
  input: "Write-Output shell-ok",
});
await new Promise((resolve) => setTimeout(resolve, 500));
const shellOutput = await tool(7, "terminal_read", { sessionId: shell.sessionId, afterSeq: 0 });
const shellText = shellOutput.chunks.map((chunk) => chunk.text).join("");
if (!shellText.includes("shell-ok")) {
  throw new Error(`interactive shell failed: ${JSON.stringify(shellOutput)}`);
}
console.log("interactive shell ok");

const sessions = await tool(8, "terminal_list");
if (!Array.isArray(sessions) || sessions.length < 2) {
  throw new Error(`terminal_list failed: ${JSON.stringify(sessions)}`);
}
console.log("list ok");

await tool(9, "terminal_kill", { sessionId: shell.sessionId });
console.log("kill ok");

const cancelled = await tool(61, "terminal_batch_start", {
  concurrency: 1,
  jobs: [
    "Start-Sleep -Seconds 5; Write-Output should-not-finish",
    "Start-Sleep -Seconds 5; Write-Output should-not-start",
  ],
});
const cancelResult = await tool(62, "terminal_batch_cancel", { batchId: cancelled.batchId });
if (!cancelResult.cancelled) {
  throw new Error(`terminal_batch_cancel failed: ${JSON.stringify(cancelResult)}`);
}
console.log("batch cancel ok");
cleanupAgent();
console.log("terminal MCP smoke test passed");
