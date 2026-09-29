import WebSocket from "ws";

const relayUrl = process.env.RELAY_URL;
const agentToken = process.env.AGENT_TOKEN;
const reconnectMs = Number(process.env.RECONNECT_MS ?? 2000);

if (!relayUrl || !agentToken) {
  console.error("RELAY_URL and AGENT_TOKEN are required");
  process.exit(1);
}

const wsUrl = relayUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";

function handlePayload(payload) {
  if (payload && typeof payload === "object" && payload.action === "ping") {
    return { ok: true, action: "pong", at: new Date().toISOString() };
  }

  return payload;
}

function connect() {
  console.log(`Connecting to ${wsUrl}`);
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
