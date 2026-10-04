import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, saveConfig } from "./config.mjs";
import { login, requestJson } from "./device-login.mjs";
import { acquireRunnerOwnership, RunnerAlreadyActiveError } from "./runner-ownership.mjs";
import { getAgentVersion } from "../agent/protocol.mjs";
import { RemoteTui, shouldUseTui } from "./tui.mjs";
import { startRelayHealthMonitor } from "./relay-health.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stopping = false;

export function shouldRestartAgent(result, stoppingNow = false) {
  return !stoppingNow && result?.code !== 2 && result?.code !== 3;
}

export function protocolCompatibility(agentProtocolVersion, expectedProtocolVersion) {
  if (agentProtocolVersion === null || agentProtocolVersion === undefined || expectedProtocolVersion === null || expectedProtocolVersion === undefined) return "unknown";
  if (!Number.isInteger(Number(agentProtocolVersion)) || !Number.isInteger(Number(expectedProtocolVersion))) return "unknown";
  return Number(agentProtocolVersion) === Number(expectedProtocolVersion) ? "compatible" : "incompatible";
}

function terminateChildTree(child) {
  if (child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const pid = child.pid;
    execFile("taskkill.exe", ["/PID", String(pid), "/T"], { windowsHide: true }, () => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
        }
      }, 1000);
    });
    return;
  }
  child.kill("SIGTERM");
}

async function validateConfig(config) {
  if (!config?.relayUrl || !config?.userToken || !config?.agentToken || !config?.agentId) return false;
  const { response } = await requestJson(`${config.relayUrl}/auth/me`, {
    headers: { authorization: `Bearer ${config.userToken}` },
  }).catch(() => ({ response: { ok: false } }));
  return Boolean(response.ok);
}

function printSummary(config) {
  console.log("");
  console.log("Chat Relay Remote");
  console.log("-----------------");
  console.log(`Account:    ${config.user?.name || config.user?.login || "signed in"}`);
  console.log(`Relay:      ${config.relayUrl}`);
  console.log(`Agent:      ${config.agentName} (${config.agentId})`);
  console.log(`Files:      ${config.allowedRoots}`);
  console.log(`Terminal:   ${config.terminalEnabled === false ? "disabled" : "enabled"}`);
  console.log("Desktop:    " + (config.desktopEnabled === true ? "enabled" : "disabled"));
  console.log("");
}

function spawnAgent(config, { tui = null, onConnectionState = null } = {}) {
  const agentPath = path.join(packageRoot, "agent", "local-agent.mjs");
  const cwd = String(config.allowedRoots || process.cwd()).split(";")[0] || process.cwd();
  const useTui = Boolean(tui);
  const child = spawn(process.execPath, [agentPath], {
    cwd,
    env: {
      ...process.env,
      RELAY_URL: config.relayUrl,
      AGENT_ID: config.agentId,
      AGENT_NAME: config.agentName,
      AGENT_TOKEN: config.agentToken,
      TERMINAL_ENABLED: config.terminalEnabled === false ? "0" : "1",
      DESKTOP_ENABLED: config.desktopEnabled === true ? "1" : "0",
      ALLOWED_ROOTS: config.allowedRoots,
      CHAT_RELAY_UI: useTui ? "ipc" : "plain",
    },
    stdio: useTui ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    windowsHide: false,
  });
  if (useTui) child.on("message", (message) => {
    tui.handleMessage(message);
    if (message?.type === "chat-relay-ui" && message.event === "connection") {
      onConnectionState?.(message.state);
    }
  });
  return child;
}

export async function remote(options = {}) {
  stopping = false;
  let config = loadConfig();
  if (!(await validateConfig(config))) {
    console.log("No valid Chat Relay login found. Starting sign in...");
    config = await login(options);
  }

  let ownership;
  try {
    ownership = await acquireRunnerOwnership({ relayUrl: config.relayUrl, agentId: config.agentId });
  } catch (error) {
    if (!(error instanceof RunnerAlreadyActiveError)) throw error;
    console.error(error.message);
    return 1;
  }
  let tui = null;
  let stopRelayHealthMonitor = null;
  try {
    if (options.allowedRoot && options.allowedRoot !== config.allowedRoots) {
      config = { ...config, allowedRoots: options.allowedRoot };
      saveConfig(config);
    }
    if (options.desktopEnabled !== undefined && Boolean(options.desktopEnabled) !== Boolean(config.desktopEnabled)) {
      config = { ...config, desktopEnabled: Boolean(options.desktopEnabled) };
      saveConfig(config);
    }

    const useTui = shouldUseTui(options);
    tui = useTui ? new RemoteTui({ config, version: getAgentVersion() }) : null;
    if (tui) {
      tui.start();
      stopRelayHealthMonitor = startRelayHealthMonitor(config.relayUrl, {
        userToken: config.userToken,
        agentId: config.agentId,
        onStatus: (health) => tui?.setRelayHealth(health),
      });
    }
    else printSummary(config);

    while (!stopping) {
      const child = spawnAgent(config, {
        tui,
        onConnectionState: (state) => {
          if (state === "connected") stopRelayHealthMonitor?.checkNow?.();
        },
      });

      const stop = () => {
        stopping = true;
        terminateChildTree(child);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      const result = await new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (stopping) break;

      if (result.code === 2) {
        stopping = true;
        console.error("Agent authorization is no longer valid. Run chat-relay login --force, then chat-relay remote.");
        break;
      }
      if (result.code === 3) {
        stopping = true;
        console.error("Agent protocol is incompatible with the relay. Update Chat Relay, then run chat-relay remote again.");
        break;
      }

      if (result.code === 4) {
        console.log("Agent restart requested. Restarting local agent...");
        continue;
      }

      if (shouldRestartAgent(result, stopping)) {
        console.error(
          `Agent stopped (code=${result.code ?? "null"}, signal=${result.signal ?? "none"}). Restarting in 2s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } finally {
    try { stopRelayHealthMonitor?.(); } catch {}
    try { tui?.stop?.(); } catch {}
    await ownership.release();
  }
}

export { validateConfig };
