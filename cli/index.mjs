import { clearConfig, configPath, loadConfig } from "./config.mjs";
import { login, requestJson } from "./device-login.mjs";
import { remote, validateConfig } from "./remote.mjs";

function parseOptions(args) {
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--relay") options.relayUrl = args[++index];
    else if (arg.startsWith("--relay=")) options.relayUrl = arg.slice(8);
    else if (arg === "--root") options.allowedRoot = args[++index];
    else if (arg.startsWith("--root=")) options.allowedRoot = arg.slice(7);
    else if (arg === "--name") options.agentName = args[++index];
    else if (arg.startsWith("--name=")) options.agentName = arg.slice(7);
    else if (arg === "--agent-id") options.agentId = args[++index];
    else if (arg.startsWith("--agent-id=")) options.agentId = arg.slice(11);
    else rest.push(arg);
  }
  return { options, rest };
}

function help() {
  console.log(`Chat Relay

Usage:
  chat-relay remote [options]   Connect this computer to ChatGPT
  chat-relay login [options]    Sign in and register this computer
  chat-relay status             Show account and connection status
  chat-relay logout             Revoke this computer login
  chat-relay help               Show this help

Options:
  --relay <url>                 Relay Worker URL
  --root <path>                 Allowed filesystem root (semicolon-separated for multiple)
  --name <name>                 Computer display name
  --agent-id <id>               Stable agent identifier
  --no-open                     Do not open the browser automatically
  --force                       Force a new login

Examples:
  npx @anusornneal/chat-relay@latest remote
  npx @anusornneal/chat-relay@latest login
  npx @anusornneal/chat-relay@latest status
`);
}

async function status() {
  const config = loadConfig();
  if (!config) {
    console.log("Chat Relay: not signed in");
    console.log(`Config: ${configPath()}`);
    return 1;
  }

  const me = await requestJson(`${config.relayUrl}/auth/me`, {
    headers: { authorization: `Bearer ${config.userToken}` },
  }).catch((error) => ({ response: { ok: false, status: 0 }, data: { error: error.message } }));

  if (!me.response.ok) {
    console.log("Chat Relay: login expired or unavailable");
    console.log(`Relay:  ${config.relayUrl}`);
    console.log(`Agent:  ${config.agentName} (${config.agentId})`);
    console.log(`Config: ${configPath()}`);
    return 1;
  }

  const agentStatus = await requestJson(
    `${config.relayUrl}/status?agentId=${encodeURIComponent(config.agentId)}`,
    { headers: { authorization: `Bearer ${config.userToken}` } },
  ).catch(() => ({ response: { ok: false }, data: { online: false } }));

  console.log("Chat Relay");
  console.log("----------");
  console.log(`Account: ${me.data.user?.name || me.data.user?.login || "signed in"}`);
  console.log(`Login:   ${me.data.user?.login || "-"}`);
  console.log(`Agent:   ${config.agentName} (${config.agentId})`);
  console.log(`Remote:  ${agentStatus.response.ok && agentStatus.data.online ? "connected" : "offline"}`);
  console.log(`Files:   ${config.allowedRoots}`);
  console.log(`Config:  ${configPath()}`);
  return 0;
}

async function logout() {
  const config = loadConfig();
  if (!config) {
    console.log("Chat Relay: already logged out");
    return 0;
  }

  let revoked = false;
  try {
    const result = await requestJson(`${config.relayUrl}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.userToken}` },
      body: JSON.stringify({ agentId: config.agentId }),
    });
    revoked = result.response.ok || result.response.status === 401;
    if (!revoked) {
      throw new Error(result.data.error || `HTTP ${result.response.status}`);
    }
  } catch (error) {
    console.error(`Logout could not revoke the server session: ${error instanceof Error ? error.message : error}`);
    console.error("Local credentials were kept. Retry when the relay is reachable.");
    return 1;
  }

  clearConfig();
  console.log("Chat Relay: logged out and local credentials removed");
  return 0;
}

export async function runCli(argv = process.argv.slice(2)) {
  const command = (argv[0] || "remote").toLowerCase();
  const { options } = parseOptions(argv.slice(1));

  if (command === "help" || command === "--help" || command === "-h") {
    help();
    return 0;
  }

  if (command === "login") {
    const current = loadConfig();
    if (!options.force && await validateConfig(current)) {
      console.log(`Already signed in as ${current.user?.name || current.user?.login || "user"}.`);
      console.log("Use --force to sign in again.");
      return 0;
    }
    await login(options);
    return 0;
  }

  if (command === "logout") return logout();
  if (command === "status") return status();
  if (command === "remote") {
    await remote(options);
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  help();
  return 1;
}
