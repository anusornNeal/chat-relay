import { clearConfig, configPath, loadConfig, saveConfig } from "./config.mjs";
import { login, requestJson } from "./device-login.mjs";
import { protocolCompatibility, remote, validateConfig } from "./remote.mjs";

function parseOptions(args) {
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--desktop") options.desktopEnabled = true;
    else if (arg === "--no-desktop") options.desktopEnabled = false;
    else if (arg === "--plain") options.tuiEnabled = false;
    else if (arg === "--tui") options.tuiEnabled = true;
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
  chat-relay drain              Stop accepting new long-running work
  chat-relay resume             Resume normal work admission
  chat-relay restart            Restart after drain completes
  chat-relay logout             Revoke this computer login
  chat-relay help               Show this help

Options:
  --relay <url>                 Relay Worker URL
  --root <path>                 Allowed filesystem root (semicolon-separated for multiple)
  --name <name>                 Computer display name
  --agent-id <id>               Stable agent identifier
  --desktop                     Enable Windows desktop screenshot/input access
  --no-desktop                  Disable desktop access (default)
  --plain                       Use legacy line-by-line logs
  --tui                         Force interactive terminal UI
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
    console.log("Access:  sign-in required");
    console.log('Recovery: run "chat-relay login", then "chat-relay remote".');
    console.log("Config:  " + configPath());
    return 1;
  }

  const me = await requestJson(config.relayUrl + "/auth/me", {
    headers: { authorization: "Bearer " + config.userToken },
  }).catch((error) => ({
    response: { ok: false, status: 0 },
    data: { error: error.message },
  }));

  if (!me.response.ok) {
    console.log("Chat Relay");
    console.log("----------");
    console.log("Relay:   " + config.relayUrl);
    console.log("Device:  " + config.agentName + " (" + config.agentId + ")");
    if (me.response.status === 401 || me.response.status === 403) {
      console.log("Access:  sign-in expired");
      console.log('Recovery: run "chat-relay login --force", then "chat-relay remote".');
    } else {
      console.log("Access:  relay unavailable");
      console.log("Recovery: retry status when the relay is reachable.");
    }
    console.log("Config:  " + configPath());
    return 1;
  }

  const agentStatus = await requestJson(
    config.relayUrl + "/status?agentId=" + encodeURIComponent(config.agentId),
    { headers: { authorization: "Bearer " + config.userToken } },
  ).catch((error) => ({
    response: { ok: false, status: 0 },
    data: { error: error.message, online: false },
  }));

  const serverAgentName = agentStatus.response.ok && agentStatus.data.agentName
    ? String(agentStatus.data.agentName)
    : config.agentName;
  if (agentStatus.response.ok && serverAgentName !== config.agentName) {
    saveConfig({ ...config, agentName: serverAgentName });
  }

  const reauthorizationRequired = agentStatus.response.ok
    ? agentStatus.data.reauthorizationRequired === true || agentStatus.data.authorized === false
    : agentStatus.response.status === 401 || agentStatus.response.status === 403;

  console.log("Chat Relay");
  console.log("----------");
  console.log(
    "Account: " +
    (me.data.user?.name || me.data.user?.login || "signed in") +
    " (" + (me.data.user?.id || "unknown") + ")",
  );
  console.log("Login:   " + (me.data.user?.login || "-"));
  console.log("Device:  " + serverAgentName + " (" + config.agentId + ")");
  console.log("Relay:   " + config.relayUrl);
  console.log("Access:  " + (reauthorizationRequired ? "re-authorization required" : "authorized"));
  console.log(
    "Remote:  " +
    (agentStatus.response.ok && agentStatus.data.online ? "connected" : "offline"),
  );
  if (agentStatus.response.ok) {
    console.log("LastSeen: " + (agentStatus.data.lastSeenAt || "-"));
    console.log(
      "Scopes:   " +
      (Array.isArray(agentStatus.data.scopes) ? agentStatus.data.scopes.join(",") : "-"),
    );
    const connection = agentStatus.data.connection || {};
    const compatibility = protocolCompatibility(connection.protocolVersion, agentStatus.data.expectedProtocolVersion);
    console.log("Version:  " + (connection.agentVersion || "-"));
    console.log(`Protocol: ${connection.protocolVersion ?? "?"}/${agentStatus.data.expectedProtocolVersion ?? "?"} (${compatibility})`);
    if (agentStatus.data.lifecycle) {
      const lifecycle = agentStatus.data.lifecycle;
      console.log("Lifecycle: " + lifecycle.state + (lifecycle.readyToRestart ? " (ready to restart)" : ""));
      if (lifecycle.work?.total) console.log("ActiveWork: " + lifecycle.work.total);
    }
  }
  console.log("Files:   " + config.allowedRoots);
  console.log("Desktop: " + (config.desktopEnabled === true ? "enabled" : "disabled"));
  console.log("Config:  " + configPath());

  if (reauthorizationRequired) {
    console.log('Recovery: run "chat-relay login --force", then "chat-relay remote".');
    return 1;
  }
  if (!agentStatus.response.ok && agentStatus.response.status === 0) {
    console.log("Recovery: retry status when the relay is reachable.");
    return 1;
  }
  return 0;
}
async function lifecycleAction(action) {
  const config = loadConfig();
  if (!config) {
    console.error("Chat Relay: not signed in");
    return 1;
  }
  const result = await requestJson(config.relayUrl + "/relay?agentId=" + encodeURIComponent(config.agentId), {
    method: "POST",
    headers: { authorization: "Bearer " + config.userToken, "content-type": "application/json" },
    body: JSON.stringify({ payload: { action: "agent.lifecycle." + action } }),
  }).catch((error) => ({ response: { ok: false, status: 0 }, data: { error: error.message } }));
  if (!result.response.ok) {
    console.error("Lifecycle action failed: " + (result.data?.error || ("HTTP " + result.response.status)));
    return 1;
  }
  const payload = result.data?.payload || result.data;
  if (payload?.ok === false) {
    console.error("Lifecycle action rejected: " + (payload.error || "unknown_error"));
    if (payload.lifecycle?.work?.total) console.error("Active work remaining: " + payload.lifecycle.work.total);
    return 1;
  }
  console.log("Agent lifecycle: " + (payload?.lifecycle?.state || "unknown"));
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
  if (command === "drain") return lifecycleAction("drain");
  if (command === "resume") return lifecycleAction("resume");
  if (command === "restart") return lifecycleAction("restart");
  if (command === "remote") {
    return (await remote(options)) || 0;
  }

  console.error(`Unknown command: ${command}`);
  help();
  return 1;
}
