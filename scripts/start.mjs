import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const configPath = path.resolve(".dev.vars");
const forceSetup = process.argv.includes("--setup");
let stopping = false;

function parseVars(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    result[line.slice(0, i)] = line.slice(i + 1);
  }
  return result;
}

function loadVars() {
  if (!fs.existsSync(configPath)) return {};
  return parseVars(fs.readFileSync(configPath, "utf8"));
}

function sanitizeId(value) {
  return value.toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "agent";
}

function defaultRoot() {
  const projects = path.join(os.homedir(), "Projects");
  return fs.existsSync(projects) ? projects : process.cwd();
}

function serializeVars(vars) {
  const preferred = [
    "RELAY_URL", "AGENT_ID", "AGENT_NAME", "AGENT_TOKEN",
    "TERMINAL_ENABLED", "ALLOWED_ROOTS", "CALLER_TOKEN", "ADMIN_TOKEN",
  ];
  const keys = [...preferred.filter((key) => vars[key] !== undefined)];
  for (const key of Object.keys(vars)) if (!keys.includes(key)) keys.push(key);
  return keys.map((key) => `${key}=${vars[key]}`).join(os.EOL) + os.EOL;
}

async function setup(existing) {
  const rl = readline.createInterface({ input, output });
  const defaults = {
    RELAY_URL: existing.RELAY_URL || "https://chat-relay.anusorn-hank.workers.dev",
    AGENT_ID: existing.AGENT_ID || sanitizeId(os.hostname()),
    AGENT_NAME: existing.AGENT_NAME || os.hostname(),
    AGENT_TOKEN: existing.AGENT_TOKEN || "",
    TERMINAL_ENABLED: existing.TERMINAL_ENABLED || "1",
    ALLOWED_ROOTS: existing.ALLOWED_ROOTS || defaultRoot(),
  };

  console.log("");
  console.log("Chat Relay setup");
  console.log("----------------");

  const relay = await rl.question(`Relay URL [${defaults.RELAY_URL}]: `);
  const agentId = await rl.question(`Agent ID [${defaults.AGENT_ID}]: `);
  const agentName = await rl.question(`Agent name [${defaults.AGENT_NAME}]: `);
  let agentToken = defaults.AGENT_TOKEN;
  if (!agentToken || forceSetup) {
    const answer = await rl.question(agentToken ? "Agent token [keep current]: " : "Agent token: ");
    if (answer.trim()) agentToken = answer.trim();
  }
  const root = await rl.question(`Allowed root [${defaults.ALLOWED_ROOTS}]: `);
  rl.close();

  if (!agentToken) {
    throw new Error("AGENT_TOKEN is required. Create/provision an agent token first.");
  }

  const vars = {
    ...existing,
    RELAY_URL: (relay.trim() || defaults.RELAY_URL).replace(/\/$/, ""),
    AGENT_ID: sanitizeId(agentId.trim() || defaults.AGENT_ID),
    AGENT_NAME: agentName.trim() || defaults.AGENT_NAME,
    AGENT_TOKEN: agentToken,
    TERMINAL_ENABLED: defaults.TERMINAL_ENABLED,
    ALLOWED_ROOTS: root.trim() || defaults.ALLOWED_ROOTS,
  };

  fs.writeFileSync(configPath, serializeVars(vars), "utf8");
  console.log(`Saved ${configPath}`);
  return vars;
}

async function ensureConfig() {
  const current = loadVars();
  const required = ["RELAY_URL", "AGENT_TOKEN"];
  const incomplete = required.some((key) => !current[key]);
  if (forceSetup || incomplete) return setup(current);

  return {
    ...current,
    AGENT_ID: current.AGENT_ID || sanitizeId(os.hostname()),
    AGENT_NAME: current.AGENT_NAME || os.hostname(),
    TERMINAL_ENABLED: current.TERMINAL_ENABLED || "1",
    ALLOWED_ROOTS: current.ALLOWED_ROOTS || defaultRoot(),
  };
}

async function checkRelay(relayUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(relayUrl.replace(/\/$/, "") + "/health", {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function printSummary(vars, health) {
  console.log("");
  console.log("Chat Relay Remote");
  console.log("-----------------");
  console.log(`Relay:      ${vars.RELAY_URL}`);
  console.log(`Agent:      ${vars.AGENT_NAME} (${vars.AGENT_ID})`);
  console.log(`Files:      ${vars.ALLOWED_ROOTS}`);
  console.log(`Terminal:   ${vars.TERMINAL_ENABLED === "1" ? "enabled" : "disabled"}`);
  console.log(`Worker:     ${health?.status || "ok"}`);
  console.log("");
}

function runAgent(vars) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["agent/local-agent.mjs"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...vars },
        stdio: "inherit",
        windowsHide: false,
      },
    );

    const stop = () => {
      stopping = true;
      if (!child.killed) child.kill();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const vars = await ensureConfig();
  let health;

  try {
    health = await checkRelay(vars.RELAY_URL);
  } catch (error) {
    console.error(`Cannot reach relay: ${error instanceof Error ? error.message : error}`);
    console.error("Run npm start -- --setup if the relay URL is wrong.");
    process.exit(1);
  }

  printSummary(vars, health);

  while (!stopping) {
    const result = await runAgent(vars);
    if (stopping) break;
    console.error(`Agent stopped (code=${result.code ?? "null"}, signal=${result.signal ?? "none"}). Restarting in 2s...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
