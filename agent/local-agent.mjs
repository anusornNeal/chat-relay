import { execFile } from "node:child_process";
import WebSocket from "ws";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);
const terminalEnabled = process.env.TERMINAL_ENABLED === "1";
const blockedCommands = [
  /\b(format|diskpart|shutdown|reboot|bcdedit|netsh|sfc|cipher|takeown|runas)\b/i,
  /\b(sc|reg)\.exe\b/i,
];

if (!relayUrl || !agentToken) {
  console.error("RELAY_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const wsUrl = relayUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";

function runTerminal(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 20000);
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        cwd: cwd || process.cwd(),
        timeout,
        windowsHide: true,
        maxBuffer: 48 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error ? error.message : null,
        });
      },
    );
  });
}

async function handlePayload(payload) {
  if (payload && typeof payload === "object" && payload.action === "ping") {
    return { ok: true, action: "pong", at: new Date().toISOString() };
  }

  if (payload && typeof payload === "object" && payload.action === "terminal.exec") {
    if (!terminalEnabled) return { ok: false, error: "terminal_disabled" };
    if (typeof payload.command !== "string" || payload.command.length === 0 || payload.command.length > 4000) {
      return { ok: false, error: "invalid_command" };
    }
    if (blockedCommands.some((pattern) => pattern.test(payload.command))) {
      return { ok: false, error: "command_blocked" };
    }
    if (payload.cwd !== undefined && typeof payload.cwd !== "string") {
      return { ok: false, error: "invalid_cwd" };
    }
    return runTerminal(payload.command, payload.cwd, payload.timeoutMs);
  }

  return payload;
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
