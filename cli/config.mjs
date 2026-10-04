import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSecrets, readSecrets, writeSecrets } from "./secret-store.mjs";

export function configDir() {
  if (process.env.CHAT_RELAY_HOME) return path.resolve(process.env.CHAT_RELAY_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "chat-relay");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "chat-relay");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function identityPath() {
  return path.join(configDir(), "identity.json");
}

export function loadIdentity() {
  const file = identityPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function saveIdentity(identity) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = identityPath();
  fs.writeFileSync(file, JSON.stringify(identity, null, 2) + os.EOL, {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function parseEnvFile(file) {
  const result = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function migrateLegacyConfig() {
  const legacyPath = path.resolve(".dev.vars");
  if (!fs.existsSync(legacyPath)) return null;
  const legacy = parseEnvFile(legacyPath);
  if (!legacy.RELAY_URL || !legacy.CALLER_TOKEN || !legacy.AGENT_TOKEN) return null;

  const config = {
    relayUrl: legacy.RELAY_URL.replace(/\/$/, ""),
    user: { id: "owner", name: "Owner", login: null },
    userToken: legacy.CALLER_TOKEN,
    agentId: legacy.AGENT_ID || "default",
    agentName: legacy.AGENT_NAME || "Primary PC",
    agentToken: legacy.AGENT_TOKEN,
    allowedRoots: legacy.ALLOWED_ROOTS || defaultAllowedRoot(),
    terminalEnabled: legacy.TERMINAL_ENABLED !== "0",
    desktopEnabled: legacy.DESKTOP_ENABLED === "1",
    migratedAt: new Date().toISOString(),
  };
  saveConfig(config);
  saveIdentity({
    agentId: config.agentId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return config;
}

function configSecrets(config = {}) {
  return {
    ...(typeof config.userToken === "string" && config.userToken ? { userToken: config.userToken } : {}),
    ...(typeof config.agentToken === "string" && config.agentToken ? { agentToken: config.agentToken } : {}),
  };
}

function persistedConfig(config, credentialStorage) {
  const persisted = { ...config, credentialStorage };
  delete persisted.userToken;
  delete persisted.agentToken;
  return persisted;
}

function writeConfigFile(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + os.EOL, {
    encoding: "utf8",
    mode: 0o600,
  });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return migrateLegacyConfig();
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const embeddedSecrets = configSecrets(stored);
    if (embeddedSecrets.userToken || embeddedSecrets.agentToken) {
      // One-time migration from pre-0.11.3 plaintext config storage.
      saveConfig(stored);
      return stored;
    }
    const secrets = readSecrets(configDir(), { store: stored.credentialStorage });
    return { ...stored, ...secrets };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid Chat Relay config: ${file}`);
    throw error;
  }
}

export function saveConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const storage = writeSecrets(dir, configSecrets(config));
  return writeConfigFile(persistedConfig(config, storage));
}

export function clearConfig() {
  const file = configPath();
  let storage;
  if (fs.existsSync(file)) {
    try { storage = JSON.parse(fs.readFileSync(file, "utf8"))?.credentialStorage; } catch {}
  }
  clearSecrets(configDir(), { store: storage });
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

export function defaultAllowedRoot() {
  const projects = path.join(os.homedir(), "Projects");
  if (fs.existsSync(projects)) return projects;
  return os.homedir();
}
