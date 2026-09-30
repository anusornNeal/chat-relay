import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import {
  defaultAllowedRoot,
  loadConfig,
  loadIdentity,
  saveConfig,
  saveIdentity,
} from "./config.mjs";

const DEFAULT_RELAY_URL = "https://chat-relay.anusorn-hank.workers.dev";

function sanitizeAgentId(value) {
  const normalized = value.toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54) || "machine";
  return normalized;
}

function createAgentId(hostname) {
  return `${sanitizeAgentId(hostname)}-${randomBytes(4).toString("hex")}`;
}

async function requestJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser(url) {
  if (process.env.CHAT_RELAY_NO_BROWSER === "1") return false;
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return true;
    }
    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }
    const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function login(options = {}) {
  const existing = loadConfig() || {};
  const relayUrl = String(options.relayUrl || existing.relayUrl || DEFAULT_RELAY_URL).replace(/\/$/, "");
  const hostname = os.hostname();
  const identity = loadIdentity() || {};
  const requestedAgentId = options.agentId ||
    existing.agentId ||
    identity.agentId ||
    createAgentId(hostname);
  const agentName = options.agentName || existing.agentName || hostname;
  const allowedRoots = options.allowedRoot || existing.allowedRoots || defaultAllowedRoot();
  const desktopEnabled = options.desktopEnabled ?? existing.desktopEnabled ?? false;

  saveIdentity({
    agentId: requestedAgentId,
    createdAt: identity.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const { response, data } = await requestJson(`${relayUrl}/auth/device/start`, {
    method: "POST",
    body: JSON.stringify({ agentId: requestedAgentId, agentName }),
  });
  if (!response.ok) {
    throw new Error(`Unable to start device login: ${data.error || response.status}`);
  }

  console.log("");
  console.log("Chat Relay sign in");
  console.log("------------------");
  console.log(`Code: ${data.userCode}`);
  console.log(`Open: ${data.verificationUriComplete}`);
  console.log("");

  const opened = options.noOpen ? false : openBrowser(data.verificationUriComplete);
  console.log(opened ? "Browser opened. Waiting for authorization..." : "Open the URL above to continue.");

  const deadline = Date.now() + Number(data.expiresIn || 600) * 1000;
  const intervalMs = Math.max(Number(data.interval || 2), 1) * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const tokenResult = await requestJson(`${relayUrl}/auth/device/token`, {
      method: "POST",
      body: JSON.stringify({ deviceCode: data.deviceCode }),
    });

    if (tokenResult.response.status === 428 && tokenResult.data.error === "authorization_pending") {
      continue;
    }
    if (!tokenResult.response.ok) {
      throw new Error(`Device login failed: ${tokenResult.data.error || tokenResult.response.status}`);
    }

    const result = tokenResult.data;

    if (existing.userToken && existing.relayUrl) {
      const revoke = await requestJson(`${String(existing.relayUrl).replace(/\/$/, "")}/auth/session/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${existing.userToken}` },
      }).catch(() => null);
      if (revoke && !revoke.response.ok && revoke.response.status !== 401) {
        console.warn("Warning: previous Chat Relay session could not be revoked.");
      }
    }

    saveIdentity({
      agentId: result.agent.id,
      createdAt: identity.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const config = {
      relayUrl,
      user: result.user,
      userToken: result.userToken,
      userTokenExpiresAt: result.userTokenExpiresAt,
      agentId: result.agent.id,
      agentName: result.agent.name,
      agentToken: result.agentToken,
      allowedRoots,
      terminalEnabled: true,
      desktopEnabled: Boolean(desktopEnabled),
      loggedInAt: new Date().toISOString(),
    };
    const file = saveConfig(config);

    console.log(`Signed in as ${result.user.name}.`);
    console.log(`Registered ${result.agent.name} (${result.agent.id}).`);
    console.log(`Saved credentials to ${file}`);
    return config;
  }

  throw new Error("Device login expired. Run the login command again.");
}

export { DEFAULT_RELAY_URL, requestJson };
