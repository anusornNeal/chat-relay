import WebSocket from "ws";
import { DesktopManager, createDesktopPlatformAdapter } from "./desktop-manager.mjs";
import { FileManager } from "./file-manager.mjs";
import { ProcessManager } from "./process-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { CapabilityScheduler } from "./capability-scheduler.mjs";
import { AgentConnectionState } from "./connection-state.mjs";
import { buildAgentHello } from "./protocol.mjs";
import {
  AgentLifecycle,
  AGENT_RESTART_EXIT_CODE,
  AGENT_UPGRADE_EXIT_CODE,
  summarizeAgentWork,
} from "./lifecycle.mjs";
import { humanizeToolCall } from "./toolcall-summary.mjs";
import {
  HeartbeatAckWatchdog,
  HEARTBEAT_ACK_TIMEOUT_REASON,
} from "./heartbeat-ack-watchdog.mjs";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const agentId = process.env.AGENT_ID || "default";
const agentName = process.env.AGENT_NAME || agentId;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const desktopEnabled = process.env.DESKTOP_ENABLED === "1";
const ipcUiEnabled = process.env.CHAT_RELAY_UI === "ipc";

function emitUi(event, payload = {}) {
  if (!ipcUiEnabled || typeof process.send !== "function") return;
  try { process.send({ type: "chat-relay-ui", event, at: new Date().toISOString(), ...payload }); } catch {}
}

function plainLog(...args) {
  if (!ipcUiEnabled) console.log(...args);
}

function plainError(...args) {
  if (!ipcUiEnabled) {
    console.error(...args);
    return;
  }
  emitUi("system", { level: "error", message: args.map((item) => String(item)).join(" ") });
}
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
  fastExec: process.env.TERMINAL_FAST_EXEC !== "0",
  fastExecPoolSize: process.env.TERMINAL_FAST_EXEC_POOL_SIZE,
  fastExecIdleMs: process.env.TERMINAL_FAST_EXEC_IDLE_MS,
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
let transportHeartbeatTimer = null;
let transportPongDeadlineTimer = null;
let stopping = false;

const TRANSPORT_PING_MS = Math.max(5000, Math.min(Number(process.env.AGENT_TRANSPORT_PING_MS) || 20000, 60000));
const TRANSPORT_PONG_TIMEOUT_MS = Math.max(3000, Math.min(Number(process.env.AGENT_TRANSPORT_PONG_TIMEOUT_MS) || 8000, 30000));
const FAST_RECONNECT_MS = Math.max(100, Math.min(Number(process.env.AGENT_FAST_RECONNECT_MS) || 250, 5000));
const FAST_RECONNECT_STABLE_MS = Math.max(5000, Math.min(Number(process.env.AGENT_FAST_RECONNECT_STABLE_MS) || 30000, 300000));
const HEARTBEAT_ACK_TIMEOUT_MS = Math.max(15000, Math.min(Number(process.env.AGENT_HEARTBEAT_ACK_TIMEOUT_MS) || 90000, 180000));
const heartbeatAckWatchdog = new HeartbeatAckWatchdog({
  timeoutMs: HEARTBEAT_ACK_TIMEOUT_MS,
  onTimeout: () => {
    const socket = activeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    connectionState.markSocketError(HEARTBEAT_ACK_TIMEOUT_REASON);
    try { socket.terminate(); } catch {}
  },
});

function currentWorkSummary() {
  return summarizeAgentWork({
    terminal: terminals.observability(),
    scheduler: scheduler.snapshot(),
    desktop: desktop.getConfig(),
  });
}

const lifecycle = new AgentLifecycle({ workSummary: currentWorkSummary });

if (!relayUrl || !agentToken) {
  plainError("RELAY_URL and AGENT_TOKEN are required");
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
        terminalExec: terminals.getExecConfig(),
        concurrency: scheduler.snapshot(),
        desktop: desktop.getConfig(),
        allowedRoots: files.getRoots(),
        reconnectMs: connectionState.baseReconnectMs,
        connection: { ...connectionState.snapshot(), processId: process.pid },
        heartbeatAckWatchdog: heartbeatAckWatchdog.snapshot(),
        lifecycle: lifecycle.snapshot(),
        terminalContinuity: {
          processId: process.pid,
          ...terminals.getContinuityConfig(),
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
    case "agent.lifecycle.upgrade": {
      const result = lifecycle.requestUpgrade();
      if (result.ok) setTimeout(upgradeAgentProcess, 150);
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
  heartbeatAckWatchdog.stop();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (transportHeartbeatTimer) {
    clearInterval(transportHeartbeatTimer);
    transportHeartbeatTimer = null;
  }
  if (transportPongDeadlineTimer) {
    clearTimeout(transportPongDeadlineTimer);
    transportPongDeadlineTimer = null;
  }
}

function armTransportPongDeadline(socket) {
  if (transportPongDeadlineTimer) clearTimeout(transportPongDeadlineTimer);
  transportPongDeadlineTimer = setTimeout(() => {
    if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
    connectionState.markSocketError("transport_pong_timeout");
    try { socket.terminate(); } catch {}
  }, TRANSPORT_PONG_TIMEOUT_MS);
}

function sendTransportPing(socket) {
  if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.ping();
    armTransportPongDeadline(socket);
  } catch (error) {
    connectionState.markSocketError(error instanceof Error ? error.message : "transport_ping_failed");
    try { socket.terminate(); } catch {}
  }
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
        serverConnectionGeneration: connectionState.serverConnectionGeneration,
        heartbeatAckWatchdog: heartbeatAckWatchdog.snapshot(now),
        queues: scheduler.snapshot(),
      },
    }));
    connectionState.markHeartbeat(now);
  } catch {}
}

function startHeartbeat(socket) {
  stopHeartbeat();
  heartbeatAckWatchdog.start();
  sendHeartbeat(socket);
  heartbeatTimer = setInterval(() => sendHeartbeat(socket), connectionState.heartbeatMs);
  transportHeartbeatTimer = setInterval(() => sendTransportPing(socket), TRANSPORT_PING_MS);
}

function sendSocketResponse(socket, requestId, payload, meta) {
  if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return;
  try { socket.send(serializeResponse(requestId, payload, meta)); } catch {}
}

function scheduleReconnect(code, reason) {
  if (stopping || reauthorizationRequired) return;
  const stableConnectionMs = connectionState.connectedAt
    ? Math.max(0, Date.now() - Date.parse(connectionState.connectedAt))
    : 0;
  connectionState.markDisconnected(code, reason);
  const isTransientAbnormalClose = Number(code) === 1006 && stableConnectionMs >= FAST_RECONNECT_STABLE_MS;
  const delay = isTransientAbnormalClose ? FAST_RECONNECT_MS : connectionState.nextDelay();
  connectionState.scheduleReconnect(delay);
  emitUi("connection", {
    state: "reconnecting",
    reconnects: connectionState.snapshot().reconnectCount,
    delayMs: delay,
    closeCode: code ?? null,
    reason: reason || "socket_closed",
  });
  clearReconnectTimer();
  plainLog(`Reconnect scheduled in ${delay}ms`);
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
  terminals.close();
  desktop.close();
  const expected = details.expectedProtocolVersion ?? "current";
  const received = details.receivedProtocolVersion ?? agentHello.protocolVersion;
  plainError(`Agent protocol is incompatible (local=${received}, relay=${expected}). Update Chat Relay, then reconnect.`);
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
  terminals.close();
  desktop.close();
  plainError("Agent credential was revoked or rejected.");
  plainError('Recovery: run "chat-relay login --force", then "chat-relay remote".');
  setImmediate(() => process.exit(2));
}

function connect() {
  if (stopping || reauthorizationRequired) return;
  clearReconnectTimer();
  connectionState.markConnecting();
  emitUi("connection", {
    state: connectionState.snapshot().reconnectCount > 0 ? "reconnecting" : "connecting",
    reconnects: connectionState.snapshot().reconnectCount,
  });
  plainLog(`Connecting to ${wsUrl}`);
  plainLog(`Terminal access: ${terminalEnabled ? "enabled" : "disabled"}`);
  const desktopConfig = desktop.getConfig();
  plainLog("Desktop access: " + (!desktopEnabled ? "disabled" : desktopConfig.supported ? "enabled" : `unsupported (${desktopConfig.platform})`));

  const socket = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  activeSocket = socket;

  socket.on("open", () => {
    if (socket !== activeSocket) return;
    socket.send(JSON.stringify(agentHello));
    connectionState.markConnected();
    emitUi("connection", { state: "connected", reconnects: connectionState.snapshot().reconnectCount });
    startHeartbeat(socket);
    plainLog("Agent connected");
  });

  socket.on("pong", () => {
    if (socket !== activeSocket) return;
    if (transportPongDeadlineTimer) {
      clearTimeout(transportPongDeadlineTimer);
      transportPongDeadlineTimer = null;
    }
  });

  socket.on("message", async (raw) => {
    if (socket !== activeSocket) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message?.control === "agent_heartbeat_ack") {
      heartbeatAckWatchdog.acknowledge();
      if (!connectionState.markServerConnectionGeneration(message.connectionGeneration)) {
        try { socket.terminate(); } catch {}
      }
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
    const callSummary = humanizeToolCall(message.payload);
    emitUi("tool:start", { requestId: message.requestId, action, summary: callSummary });
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
        summary: callSummary,
        durationMs: Date.now() - startedAt,
        queueWaitMs: scheduleMeta.queueWaitMs,
        handlerDurationMs,
        lane: scheduleMeta.lane,
        ...(timing ? { timing } : {}),
        ...(typeof result?.execMode === "string" ? { execMode: result.execMode } : {}),
        ok: !(result && typeof result === "object" && result.ok === false),
      });
      if (recentCalls.length > 100) recentCalls.shift();
      emitUi("tool:end", {
        requestId: message.requestId,
        action,
        summary: callSummary,
        ok: !(result && typeof result === "object" && result.ok === false),
        durationMs: Date.now() - startedAt,
        ...(result && typeof result === "object" && result.ok === false && result.error ? { error: String(result.error) } : {}),
      });
      sendSocketResponse(socket, message.requestId, result, {
        agentQueueWaitMs: scheduleMeta.queueWaitMs,
        agentHandlerMs: handlerDurationMs,
        lane: scheduleMeta.lane,
      });
    } catch (error) {
      recentCalls.push({
        at: new Date().toISOString(),
        action,
        summary: callSummary,
        durationMs: Date.now() - startedAt,
        queueWaitMs: scheduleMeta.queueWaitMs,
        handlerDurationMs,
        lane: scheduleMeta.lane,
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      });
      if (recentCalls.length > 100) recentCalls.shift();
      emitUi("tool:end", {
        requestId: message.requestId,
        action,
        summary: callSummary,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "agent_error",
      });
      sendSocketResponse(socket, message.requestId, {
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      });
    }
  });

  socket.on("unexpected-response", (_request, response) => {
    response.resume();
    if (socket !== activeSocket || stopping || reauthorizationRequired) return;
    const statusCode = Number(response.statusCode) || 0;
    if (statusCode === 401 || statusCode === 403) {
      requireReauthorization("credential_rejected");
      return;
    }
    activeSocket = null;
    stopHeartbeat();
    const reason = statusCode > 0 ? `unexpected_response_${statusCode}` : "unexpected_response";
    connectionState.markSocketError(reason);
    scheduleReconnect(null, reason);
  });

  socket.on("close", (code, reason) => {
    if (socket !== activeSocket) return;
    activeSocket = null;
    stopHeartbeat();
    const reasonText = reason.toString();
    plainLog("Agent disconnected (" + code + ") " + reasonText);
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
      plainError("WebSocket error:", error.message);
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
  terminals.close();
  desktop.close();
  setTimeout(() => process.exit(AGENT_RESTART_EXIT_CODE), 50);
}

function upgradeAgentProcess() {
  if (stopping) return;
  stopping = true;
  connectionState.markStopping("upgrade_requested");
  clearReconnectTimer();
  stopHeartbeat();
  const socket = activeSocket;
  activeSocket = null;
  try { socket?.close(1012, "upgrade_requested"); } catch {}
  terminals.close();
  desktop.close();
  setTimeout(() => process.exit(AGENT_UPGRADE_EXIT_CODE), 50);
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
  terminals.close();
  desktop.close();
  setTimeout(() => process.exit(0), 50);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", () => { terminals.close(); desktop.close(); });

connect();
