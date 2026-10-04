import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "com.anusornneal.chat-relay";
const SECRET_KEYS = ["userToken", "agentToken"];

function normalizedSecrets(value = {}) {
  const result = {};
  for (const key of SECRET_KEYS) {
    const secret = value?.[key];
    if (typeof secret === "string" && secret.length > 0) result[key] = secret;
  }
  return result;
}

function fallbackPath(dir) {
  return path.join(dir, "secrets.json");
}

function dpapiPath(dir) {
  return path.join(dir, "secrets.dpapi");
}

function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function resolveStore({ store, platform = process.platform, env = process.env } = {}) {
  const requested = String(store || env?.CHAT_RELAY_SECRET_STORE || "").trim().toLowerCase();
  if (requested === "keychain" || requested === "dpapi" || requested === "file") return requested;
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "dpapi";
  return "file";
}

function readFallback(dir) {
  const file = fallbackPath(dir);
  if (!fs.existsSync(file)) return {};
  try {
    return normalizedSecrets(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function writeFallback(dir, secrets) {
  writePrivateFile(fallbackPath(dir), JSON.stringify(normalizedSecrets(secrets), null, 2) + "\n");
}

function powershell(script, input) {
  let lastError;
  for (const command of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    try {
      return execFileSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        input,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") break;
    }
  }
  throw lastError || new Error("powershell_unavailable");
}

function writeDpapi(dir, secrets) {
  const plain = JSON.stringify(normalizedSecrets(secrets));
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$value=[Console]::In.ReadToEnd()",
    "$bytes=[Text.Encoding]::UTF8.GetBytes($value)",
    "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("; ");
  const encrypted = powershell(script, plain).trim();
  if (!encrypted) throw new Error("dpapi_encrypt_failed");
  writePrivateFile(dpapiPath(dir), encrypted + "\n");
}

function readDpapi(dir) {
  const file = dpapiPath(dir);
  if (!fs.existsSync(file)) return {};
  const encrypted = fs.readFileSync(file, "utf8").trim();
  if (!encrypted) return {};
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$value=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($value)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  ].join("; ");
  const decoded = powershell(script, encrypted);
  return normalizedSecrets(JSON.parse(decoded));
}

function keychainRead(key) {
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", key,
      "-w",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function keychainDelete(key) {
  try {
    execFileSync("security", [
      "delete-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", key,
    ], {
      stdio: "ignore",
    });
  } catch {}
}

function readKeychain() {
  const result = {};
  for (const key of SECRET_KEYS) {
    const value = keychainRead(key);
    if (value) result[key] = value;
  }
  return result;
}

function writeKeychain(secrets) {
  const normalized = normalizedSecrets(secrets);
  for (const key of SECRET_KEYS) {
    const value = normalized[key];
    if (!value) {
      keychainDelete(key);
      continue;
    }
    execFileSync("security", [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", key,
      "-w", value,
    ], {
      stdio: "ignore",
    });
  }
}

function hasSecrets(value) {
  return SECRET_KEYS.some((key) => typeof value?.[key] === "string" && value[key].length > 0);
}

export function readSecrets(dir, options = {}) {
  const store = resolveStore(options);
  try {
    if (store === "keychain") {
      const secrets = readKeychain();
      if (hasSecrets(secrets)) return secrets;
    } else if (store === "dpapi") {
      const secrets = readDpapi(dir);
      if (hasSecrets(secrets)) return secrets;
    } else {
      return readFallback(dir);
    }
  } catch {}

  return readFallback(dir);
}

export function writeSecrets(dir, secrets, options = {}) {
  const normalized = normalizedSecrets(secrets);
  const store = resolveStore(options);

  if (store === "keychain") {
    try {
      writeKeychain(normalized);
      removeFile(fallbackPath(dir));
      removeFile(dpapiPath(dir));
      return "keychain";
    } catch {}
  } else if (store === "dpapi") {
    try {
      writeDpapi(dir, normalized);
      removeFile(fallbackPath(dir));
      return "dpapi";
    } catch {}
  }

  writeFallback(dir, normalized);
  return "file";
}

export function clearSecrets(dir, options = {}) {
  removeFile(fallbackPath(dir));
  removeFile(dpapiPath(dir));

  const store = resolveStore(options);
  if (store === "keychain" || process.platform === "darwin") {
    for (const key of SECRET_KEYS) keychainDelete(key);
  }
}

export function secretStorePaths(dir) {
  return {
    fallback: fallbackPath(dir),
    dpapi: dpapiPath(dir),
  };
}

export { resolveStore as resolveSecretStore };
