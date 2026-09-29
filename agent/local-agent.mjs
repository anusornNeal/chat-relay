import WebSocket from "ws";
import { TerminalManager } from "./terminal-manager.mjs";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const terminals = new TerminalManager();

if (!relayUrl || !agentToken) {
  console.error("RELAY_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const wsUrl = relayUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";

async function handlePayload(payload) {
  if (payload && typeof payload === "object" && payload.action === "ping") {
    return { ok: true, action: "pong", at: new Date().toISOString() };
  }

  if (!payload || typeof payload !== "object" || !String(payload.action ?? "").startsWith("terminal.")) {
    return payload;
  }
  if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };

  switch (payload.action) {
    case "terminal.exec":
      return terminals.exec(payload.command, payload.cwd, payload.timeoutMs);
    case "terminal.start":
      return terminals.start(payload.command, payload.cwd);
    case "terminal.shell.start":
      return terminals.startShell(payload.cwd);
    case "terminal.read":
      return terminals.read(payload.sessionId, payload.afterSeq, payload.maxChars);
    case "terminal.write":
      return terminals.write(payload.sessionId, payload.input, payload.appendNewline !== false);
    case "terminal.kill":
      return terminals.kill(payload.sessionId);
    case "terminal.list":
      return terminals.list();
    default:
      return { ok: false, error: "unknown_terminal_action" };
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

    try {
      const result = await handlePayload(message.payload);
      socket.send(JSON.stringify({ requestId: message.requestId, payload: result }));
    } catch (error) {
      socket.send(JSON.stringify({
        requestId: message.requestId,
        payload: { ok: false, error: error instanceof Error ? error.message : "agent_error" },
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
