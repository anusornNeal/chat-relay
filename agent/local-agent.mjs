import WebSocket from "ws";
import { DesktopManager } from "./desktop-manager.mjs";
import { FileManager } from "./file-manager.mjs";
import { ProcessManager } from "./process-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const agentId = process.env.AGENT_ID || "default";
const agentName = process.env.AGENT_NAME || agentId;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const desktopEnabled = process.env.DESKTOP_ENABLED === "1";
const MAX_RESPONSE_BYTES = 60 * 1024;
const terminals = new TerminalManager({
  batchConcurrency: process.env.TERMINAL_BATCH_CONCURRENCY,
  maxQueuedJobs: process.env.TERMINAL_BATCH_MAX_QUEUED,
});
const files = new FileManager(process.env.ALLOWED_ROOTS);
const processes = new ProcessManager();
const desktop = new DesktopManager({ enabled: desktopEnabled });
const recentCalls = [];
let reauthorizationRequired = false;

if (!relayUrl || !agentToken) {
  console.error("RELAY_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const wsUrl = relayUrl.replace(/^http/, "ws").replace(/\/$/, "") +
  `/agent?agentId=${encodeURIComponent(agentId)}`;

function serializeResponse(requestId, payload) {
  const response = JSON.stringify({ requestId, payload });
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

  switch (payload.action) {
    case "ping":
      return { ok: true, action: "pong", at: new Date().toISOString(), agentId, agentName };

    case "agent.config":
      return processes.info({
        agentId,
        agentName,
        terminalEnabled,
        terminalBatch: terminals.getBatchConfig(),
        desktop: desktop.getConfig(),
        allowedRoots: files.getRoots(),
        reconnectMs,
      });
    case "agent.recentCalls":
      return recentCalls.slice(-(Math.min(Math.max(Number(payload.limit) || 50, 1), 100)));

    case "fs.stat":
      return files.stat(payload.path);
    case "fs.list":
      return files.list(payload.path, payload.depth, payload.offset, payload.limit, payload.maxBytes);
    case "fs.read":
      return files.read(payload.path, payload.offset, payload.length, payload.maxBytes);
    case "fs.readMany":
      return files.readMany(payload.paths, payload.maxTotalBytes);
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

function requireReauthorization() {
  if (reauthorizationRequired) return;
  reauthorizationRequired = true;
  desktop.close();
  process.exitCode = 2;
  console.error("Agent credential was revoked or rejected.");
  console.error('Recovery: run "chat-relay login --force", then "chat-relay remote".');
}

function connect() {
  if (reauthorizationRequired) return;
  console.log(`Connecting to ${wsUrl}`);
  console.log(`Terminal access: ${terminalEnabled ? "enabled" : "disabled"}`);
  console.log("Desktop access: " + (desktopEnabled ? "enabled" : "disabled"));
  const socket = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });

  socket.on("open", () => console.log("Agent connected"));

  socket.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message?.control === "credential_revoked") {
      requireReauthorization();
      try { socket.close(4001, "credential_revoked"); } catch {}
      return;
    }

    if (!message || typeof message.requestId !== "string") return;

    const startedAt = Date.now();
    const action = message.payload && typeof message.payload === "object"
      ? String(message.payload.action ?? "unknown")
      : "unknown";
    try {
      const result = await handlePayload(message.payload);
      recentCalls.push({
        at: new Date().toISOString(),
        action,
        durationMs: Date.now() - startedAt,
        ok: !(result && typeof result === "object" && result.ok === false),
      });
      if (recentCalls.length > 100) recentCalls.shift();
      socket.send(serializeResponse(message.requestId, result));
    } catch (error) {
      recentCalls.push({
        at: new Date().toISOString(),
        action,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      });
      if (recentCalls.length > 100) recentCalls.shift();
      socket.send(serializeResponse(message.requestId, {
        ok: false,
        error: error instanceof Error ? error.message : "agent_error",
      }));
    }
  });

  socket.on("unexpected-response", (_request, response) => {
    if (response.statusCode === 401 || response.statusCode === 403) {
      response.resume();
      requireReauthorization();
      socket.terminate();
    }
  });

  socket.on("close", (code, reason) => {
    const reasonText = reason.toString();
    console.log("Agent disconnected (" + code + ") " + reasonText);
    if (code === 4001 || reasonText === "credential_revoked") {
      requireReauthorization();
      return;
    }
    if (!reauthorizationRequired) setTimeout(connect, reconnectMs);
  });

  socket.on("error", (error) => {
    if (!reauthorizationRequired) console.error("WebSocket error:", error.message);
  });
}

function shutdown() {
  desktop.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", shutdown);

connect();
