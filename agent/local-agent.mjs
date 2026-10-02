import WebSocket from "ws";
import { DesktopManager, createDesktopPlatformAdapter } from "./desktop-manager.mjs";
import { FileManager } from "./file-manager.mjs";
import { ProcessManager } from "./process-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { CapabilityScheduler } from "./capability-scheduler.mjs";
import { AgentConnectionState } from "./connection-state.mjs";
import { buildAgentHello } from "./protocol.mjs";
import { AgentLifecycle, AGENT_RESTART_EXIT_CODE } from "./lifecycle.mjs";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const agentId = process.env.AGENT_ID || "default";
const agentName = process.env.AGENT_NAME || agentId;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const desktopEnabled = process.env.DESKTOP_ENABLED === "1";
const desktopAdapter = createDesktopPlatformAdapter({ platform: process.platform });
const agentHello = buildAgentHello({
  platform: desktopAdapter.platform,
  terminalEnabled,
  desktopEnabled: desktopEnabled && desktopAdapter.supported,
});
const MAX_RESPONSE_BYTES = 60 * 1024;
const terminals = new TerminalManager({
  batchConcurrency: process.env.TERMINAL_BATCH_CONCURRENCY,
  maxQueuedJobs: process.env.TERMINAL_BATCH_MAX_QUEUED,
});
const scheduler = new CapabilityScheduler({
  maxQueued: process.env.AGENT_MAX_QUEUED,
  queueTimeoutMs: process.env.AGENT_QUEUE_TIMEOUT_MS,
  fileConcurrency: process.env.AGENT_FILE_CONCURRENCY,
  processConcurrency: process.env.AGENT_PROCESS_CONCURRENCY,
  terminalExecConcurrency: process.env.AGENT_TERMINAL_EXEC_CONCURRENCY,
  terminalControlConcurrency: process.env.AGENT_TERMINAL_CONTROL_CONCURRENCY,
  desktopReadConcurrency: process.env.AGENT_DESKTOP_READ_CONCURRENCY,
});
const connectionState = new AgentConnectionState({
  baseReconnectMs: reconnectMs,
  maxReconnectMs: process.env.RECONNECT_MAX_MS,
  heartbeatMs: process.env.AGENT_HEARTBEAT_MS,
});
const files = new FileManager(process.env.ALLOWED_ROOTS);
const processes = new ProcessManager();
const desktop = new DesktopManager({
  enabled: desktopEnabled,
  adapter: desktopAdapter,
  controlMaxQueued: process.env.DESKTOP_CONTROL_MAX_QUEUED,
  controlQueueTimeoutMs: process.env.AGENT_QUEUE_TIMEOUT_MS,
});
const recentCalls = [];
const RECENT_TIMING_KEYS = ["queueWaitMs", "inputMs", "explicitWaitMs", "settleMs", "captureMs", "encodeMs", "workerMs", "managerMs", "totalMs", "requestedActions", "executedActions"];
function recentTiming(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  for (const key of RECENT_TIMING_KEYS) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) output[key] = Math.round(number);
  }
  return Object.keys(output).length > 0 ? output : null;
}
let reauthorizationRequired = false;
let activeSocket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let stopping = false;

function currentWorkSummary() {
  const terminal = terminals.observability();
  const terminalExec = scheduler.snapshot().terminalExec || {};
  return {
    activeSessions: terminal.sessions.filter((item) => item.status === "running").length,
    activeBatchJobs: terminal.activeExecJobs,
    queuedBatchJobs: terminal.queuedJobs,
    activeTerminalExecs: terminalExec.active,
    queuedTerminalExecs: terminalExec.queued,
  };
}

const lifecycle = new AgentLifecycle({ workSummary: currentWorkSummary });

if (!relayUrl || !agentToken) {
  console.error("RELAY_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const wsUrl = relayUrl.replace(/^http/, "ws").replace(/\/$/, "") +
  `/agent?agentId=${encodeURIComponent(agentId)}`;

function serializeResponse(requestId, payload, meta) {
  const response = JSON.stringify({ requestId, payload, ...(meta ? { meta } : {}) });
  if (Buffer.byteLength(response, "utf8") <= MAX_RESPONSE_BYTES) return response;
  return JSON.stringify({
    requestId,
    payload: {
      ok: false,
      error: "response_too_large",
      maxBytes: MAX_RESPONSE_BYTES,
    },
  });
}

async function handlePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const action = String(payload.action ?? "");
  const lifecycleGate = lifecycle.guard(action);
  if (lifecycleGate) return lifecycleGate;

  switch (action) {
    case "ping":
      return { ok: true, action: "pong", at: new Date().toISOString(), agentId, agentName };

    case "agent.config":
      return processes.info({
        agentId,
        agentName,
        terminalEnabled,
        terminalBatch: terminals.getBatchConfig(),
        concurrency: scheduler.snapshot(),
        desktop: desktop.getConfig(),
        allowedRoots: files.getRoots(),
        reconnectMs: connectionState.baseReconnectMs,
        connection: { ...connectionState.snapshot(), processId: process.pid },
        lifecycle: lifecycle.snapshot(),
        terminalContinuity: {
          processId: process.pid,
          activeSessions: terminals.list().filter((session) => session.status === "running").length,
        },
        protocol: {
          protocolVersion: agentHello.protocolVersion,
          agentVersion: agentHello.agentVersion,
          platform: agentHello.platform,
          arch: agentHello.arch,
          capabilities: agentHello.capabilities,
        },
      });
    case "agent.recentCalls":
      return recentCalls.slice(-(Math.min(Math.max(Number(payload.limit) || 50, 1), 100)));
    case "agent.lifecycle.status":
      return { ok: true, lifecycle: lifecycle.snapshot() };
    case "agent.lifecycle.drain":
      return lifecycle.drain();
    case "agent.lifecycle.resume":
      return lifecycle.resume();
    case "agent.lifecycle.restart": {
      const result = lifecycle.requestRestart();
      if (result.ok) setTimeout(restartAgentProcess, 150);
      return result;
    }

    case "fs.stat":
      return files.stat(payload.path);
    case "fs.list":
      return files.list(payload.path, payload.depth, payload.offset, payload.limit, payload.maxBytes);
    case "fs.read":
      return files.read(payload.path, payload.offset, payload.length, payload.maxBytes);
    case "fs.readMany":
      return files.readMany(payload.paths, payload.maxTotalBytes);
    case "fs.batch":
      return files.batch(payload.operations, payload.maxTotalBytes);
    case "fs.artifact":
      return files.exportArtifact(payload.path, payload.maxBytes);
    case "fs.write":
      return files.write(payload.path, payload.content, payload.mode);
    case "fs.edit":
      return files.edit(payload.path, payload.oldText, payload.newText, payload.expectedReplacements);
    case "fs.mkdir":
      return files.mkdir(payload.path);
    case "fs.move":
      return files.move(payload.source, payload.destination);
    case "fs.delete":
      return files.remove(payload.path, payload.recursive);
    case "fs.search.start":
      return files.startSearch(payload.path, payload.pattern, payload.searchType, payload.maxResults);
    case "fs.search.results":
      return files.getSearchResults(payload.sessionId, payload.offset, payload.length);

    case "process.list":
      return processes.list(payload.filter);
    case "process.kill":
      return processes.kill(payload.pid);

    case "desktop.screenshot":
      return desktop.screenshot(payload);
    case "desktop.clipboard.read":
      return desktop.clipboardRead(payload);
    case "desktop.clipboard.write":
      return desktop.clipboardWrite(payload);
    case "desktop.window.list":
      return desktop.listWindows(payload);
    case "desktop.window.focus":
      return desktop.focusWindow(payload);
    case "desktop.mouse.click":
      return desktop.mouseClick(payload);
    case "desktop.keyboard.input":
      return desktop.keyboardInput(payload);
    case "desktop.step":
      return desktop.step(payload);

    case "terminal.exec":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.exec(payload.command, payload.cwd, payload.timeoutMs);
    case "terminal.batch.start":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.batchStart(payload.jobs, { cwd: payload.cwd, timeoutMs: payload.timeoutMs, concurrency: payload.concurrency, observability: payload.observability });
    case "terminal.batch.status":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.batchStatus(payload.batchId);
    case "terminal.batch.read":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.batchRead(payload.batchId, payload.maxChars);
    case "terminal.batch.cancel":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.batchCancel(payload.batchId);
    case "terminal.start":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.start(payload.command, payload.cwd, payload.observability);
    case "terminal.shell.start":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.startShell(payload.cwd, payload.observability);
    case "terminal.read":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.read(payload.sessionId, payload.afterSeq, payload.maxChars);
    case "terminal.write":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.write(payload.sessionId, payload.input, payload.appendNewline !== false);
    case "terminal.kill":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.kill(payload.sessionId);
    case "terminal.list":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.list();
    case "terminal.observability":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.observability();

    default:
      return { ok: false, error: "unknown_action" };
  }
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function sendHeartbeat(socket) {
  if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  try {
    socket.send(JSON.stringify({
      control: "agent_heartbeat",
      at: now,
      agentId,
      processId: process.pid,
      heartbeatMs: connectionState.heartbeatMs,
      lifecycle: lifecycle.snapshot(),
      health: {
        reconnectCount: connectionState.reconnectCount,
        reconnectAttempt: connectionState.reconnectAttempt,
        processStartedAt: connectionState.processStartedAt,
        connectedAt: connectionState.connectedAt,
        lastDisconnectedAt: connectionState.lastDisconnectedAt,
        lastCloseCode: connectionState.lastCloseCode,
        lastDisconnectReason: connectionState.lastDisconnectReason,
        lastConnectionDurationMs: connectionState.lastConnectionDurationMs,
        lastSocketError: connectionState.lastSocketError,
        queues: scheduler.snapshot(),
      },
    }));
    connectionState.markHeartbeat(now);
  } catch {}
}

function startHeartbeat(socket) {
  stopHeartbeat();
  sendHeartbeat(socket);
  heartbeatTimer = setInterval(() => sendHeartbeat(socket), connectionState.heartbeatMs);
}

function sendSocketResponse(socket, requestId, payload, meta) {
  if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(serializeResponse(requestId, payload, meta)); } catch {}
}

function scheduleReconnect(code, reason) {
  if (stopping || reauthorizationRequired) return;
  connectionState.markDisconnected(code, reason);
  const delay = connectionState.nextDelay();
  connectionState.scheduleReconnect(delay);
  clearReconnectTimer();
  console.log(`Reconnect scheduled in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}


function requireProtocolUpdate(details = {}) {
  if (stopping) return;
  stopping = true;
  connectionState.markStopping("protocol_incompatible");
  clearReconnectTimer();
  stopHeartbeat();
  const socket = activeSocket;
  activeSocket = null;
  try { socket?.terminate(); } catch {}
  desktop.close();
  const expected = details.expectedProtocolVersion ?? "current";
  const received = details.receivedProtocolVersion ?? agentHello.protocolVersion;
  console.error(`Agent protocol is incompatible (local=${received}, relay=${expected}). Update Chat Relay, then reconnect.`);
  setImmediate(() => process.exit(3));
}

function requireReauthorization(reason = "credential_revoked") {
  if (reauthorizationRequired) return;
  reauthorizationRequired = true;
  connectionState.markReauthorization(reason);
  clearReconnectTimer();
  stopHeartbeat();
  const socket = activeSocket;
  activeSocket = null;
  try { socket?.terminate(); } catch {}
  desktop.close();
  console.error("Agent credential was revoked or rejected.");
  console.error('Recovery: run "chat-relay login --force", then "chat-relay remote".');
  setImmediate(() => process.exit(2));
}

function connect() {
  if (stopping || reauthorizationRequired) return;
  clearReconnectTimer();
  connectionState.markConnecting();
  console.log(`Connecting to ${wsUrl}`);
  console.log(`Terminal access: ${terminalEnabled ? "enabled" : "disabled"}`);
  const desktopConfig = desktop.getConfig();
  console.log("Desktop access: " + (!desktopEnabled ? "disabled" : desktopConfig.supported ? "enabled" : `unsupported (${desktopConfig.platform})`));

  const socket = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  activeSocket = socket;

  socket.on("open", () => {
    if (socket !== activeSocket) return;
    socket.send(JSON.stringify(agentHello));
    connectionState.markConnected();
    startHeartbeat(socket);
    console.log("Agent connected");
  });

  socket.on("message", async (raw) => {
    if (socket !== activeSocket) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message?.control === "credential_revoked") {
      requireReauthorization("credential_revoked");
      return;
    }
    if (message?.control === "protocol_incompatible") {
      requireProtocolUpdate(message);
      return;
    }

    if (!message || typeof message.requestId !== "string") return;

    const startedAt = Date.now();
    const action = message.payload && typeof message.payload === "object"
      ? String(message.payload.action ?? "unknown")
      : "unknown";
    let scheduleMeta = { lane: "unknown", queueWaitMs: 0, queueDepthAtStart: 0, activeAtStart: 0 };
    let handlerDurationMs = 0;
    try {
      const result = await scheduler.run(action, async (meta = {}) => {
        scheduleMeta = { ...scheduleMeta, ...meta };
        const handlerStartedAt = Date.now();
        try {
          return await handlePayload(message.payload);
        } finally {
          handlerDurationMs = Math.max(0, Date.now() - handlerStartedAt);
        }
      });
      const timing = recentTiming(result?.timing);
      recentCalls.push({
        at: new Date().toISOString(),
        action,
        durationMs: Date.now() - startedAt,
        queueWaitMs: scheduleMeta.queueWaitMs,
        handlerDurationMs,
        lane: scheduleMeta.lane,
        ...(timing ? { timing } : {}),
        ok: !(result && typeof result === "object" && result.ok === false),
      });
      if (recentCalls.length > 100) recentCalls.shift();
      sendSocketResponse(socket, message.requestId, result, {
        agentQueueWaitMs: scheduleMeta.queueWaitMs,
        agentHandlerMs: handlerDurationMs,
        lane: scheduleMeta.lane,
      });
    } catch (error) {
      recentCalls.push({
        at: new Date().toISOString(),
        action,
        durationMs: Date.now() - startedAt,
        queueWaitMs: scheduleMeta.queueWaitMs,
        handlerDurationMs,
        lane: scheduleMeta.lane,
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      });
      if (recentCalls.length > 100) recentCalls.shift();
      sendSocketResponse(socket, message.requestId, {
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      });
    }
  });

  socket.on("unexpected-response", (_request, response) => {
    if (response.statusCode === 401 || response.statusCode === 403) {
      response.resume();
      requireReauthorization("credential_rejected");
    }
  });

  socket.on("close", (code, reason) => {
    if (socket !== activeSocket) return;
    activeSocket = null;
    stopHeartbeat();
    const reasonText = reason.toString();
    console.log("Agent disconnected (" + code + ") " + reasonText);
    if (code === 4001 || reasonText === "credential_revoked") {
      requireReauthorization("credential_revoked");
      return;
    }
    if (code === 4002 || reasonText === "protocol_incompatible") {
      requireProtocolUpdate({ receivedProtocolVersion: agentHello.protocolVersion });
      return;
    }
    scheduleReconnect(code, reasonText || "socket_closed");
  });

  socket.on("error", (error) => {
    if (socket === activeSocket && !stopping && !reauthorizationRequired) {
      connectionState.markSocketError(error.message);
      console.error("WebSocket error:", error.message);
    }
  });
}

function restartAgentProcess() {
  if (stopping) return;
  stopping = true;
  connectionState.markStopping("restart_requested");
  clearReconnectTimer();
  stopHeartbeat();
  const socket = activeSocket;
  activeSocket = null;
  try { socket?.close(1012, "restart_requested"); } catch {}
  desktop.close();
  setTimeout(() => process.exit(AGENT_RESTART_EXIT_CODE), 50);
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  connectionState.markStopping(reason);
  clearReconnectTimer();
  stopHeartbeat();
  const socket = activeSocket;
  activeSocket = null;
  try { socket?.close(1000, "client_shutdown"); } catch {}
  desktop.close();
  setTimeout(() => process.exit(0), 50);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", () => desktop.close());

connect();
