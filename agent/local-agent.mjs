import WebSocket from "ws";
import { FileManager } from "./file-manager.mjs";
import { ProcessManager } from "./process-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const agentId = process.env.AGENT_ID || "default";
const agentName = process.env.AGENT_NAME || agentId;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const MAX_RESPONSE_BYTES = 60 * 1024;
const terminals = new TerminalManager();
const files = new FileManager(process.env.ALLOWED_ROOTS);
const processes = new ProcessManager();
const recentCalls = [];

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
        allowedRoots: files.getRoots(),
        reconnectMs,
      });
    case "agent.recentCalls":
      return recentCalls.slice(-(Math.min(Math.max(Number(payload.limit) || 50, 1), 100)));

    case "fs.stat":
      return files.stat(payload.path);
    case "fs.list":
      return files.list(payload.path, payload.depth);
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

    case "terminal.exec":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.exec(payload.command, payload.cwd, payload.timeoutMs);
    case "terminal.start":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.start(payload.command, payload.cwd);
    case "terminal.shell.start":
      if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
      return terminals.startShell(payload.cwd);
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

    default:
      return { ok: false, error: "unknown_action" };
  }
}

function connect() {
  console.log(`Connecting to ${wsUrl}`);
  console.log(`Terminal access: ${terminalEnabled ? "enabled" : "disabled"}`);
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

  socket.on("close", (code, reason) => {
    console.log(`Agent disconnected (${code}) ${reason.toString()}`);
    setTimeout(connect, reconnectMs);
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
}

connect();
