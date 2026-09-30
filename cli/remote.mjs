import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, saveConfig } from "./config.mjs";
import { login, requestJson } from "./device-login.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stopping = false;

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

function spawnAgent(config) {
  const agentPath = path.join(packageRoot, "agent", "local-agent.mjs");
  const cwd = String(config.allowedRoots || process.cwd()).split(";")[0] || process.cwd();
  return spawn(process.execPath, [agentPath], {
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
    },
    stdio: "inherit",
    windowsHide: false,
  });
}

export async function remote(options = {}) {
  let config = loadConfig();
  if (!(await validateConfig(config))) {
    console.log("No valid Chat Relay login found. Starting sign in...");
    config = await login(options);
  }

  if (options.allowedRoot && options.allowedRoot !== config.allowedRoots) {
    config = { ...config, allowedRoots: options.allowedRoot };
    saveConfig(config);
  }
  if (options.desktopEnabled !== undefined && Boolean(options.desktopEnabled) !== Boolean(config.desktopEnabled)) {
    config = { ...config, desktopEnabled: Boolean(options.desktopEnabled) };
    saveConfig(config);
  }

  printSummary(config);

  while (!stopping) {
    const child = spawnAgent(config);

    const stop = () => {
      stopping = true;
      if (!child.killed) child.kill();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    const result = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (stopping) break;

    console.error(
      `Agent stopped (code=${result.code ?? "null"}, signal=${result.signal ?? "none"}). Restarting in 2s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export { validateConfig };
