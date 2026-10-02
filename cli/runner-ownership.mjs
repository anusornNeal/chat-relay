import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { configDir } from "./config.mjs";

const DEFAULT_STARTUP_GRACE_MS = 1_500;
const DEFAULT_PROBE_TIMEOUT_MS = 400;

export class RunnerAlreadyActiveError extends Error {
  constructor({ agentId, relayUrl, pid }) {
    const owner = Number.isInteger(pid) ? ` (PID ${pid})` : "";
    super(
      `Chat Relay agent "${agentId}" is already running for ${relayUrl}${owner}. ` +
      "Stop the existing runner before starting another one.",
    );
    this.name = "RunnerAlreadyActiveError";
    this.code = "CHAT_RELAY_RUNNER_ACTIVE";
  }
}

function normalizeRelayUrl(relayUrl) {
  try {
    const url = new URL(String(relayUrl));
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return String(relayUrl).replace(/\/+$/, "");
  }
}

function ownershipKey(relayUrl, agentId) {
  return createHash("sha256")
    .update(normalizeRelayUrl(relayUrl))
    .update("\0")
    .update(String(agentId))
    .digest("hex");
}

function socketEndpoint(key, token) {
  const name = `chat-relay-${createHash("sha256").update(key).update(token).digest("hex").slice(0, 32)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
  const base = Buffer.byteLength(path.join(os.tmpdir(), `${name}.sock`)) < 100 ? os.tmpdir() : "/tmp";
  return path.join(base, `${name}.sock`);
}

function readMetadata(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeOwner(metadata, timeoutMs) {
  if (!metadata?.endpoint || !metadata?.token) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const socket = net.createConnection(metadata.endpoint);
    const finish = (active) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("PING\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) finish(response.trim() === `OWNER ${metadata.token}`);
    });
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(response.trim() === `OWNER ${metadata.token}`));
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function removeSocket(endpoint) {
  if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
}

function removeStaleSocket(endpoint) {
  if (process.platform === "win32" || typeof endpoint !== "string") return;
  const allowedDirectories = new Set([path.resolve(os.tmpdir()), path.resolve("/tmp")]);
  if (!allowedDirectories.has(path.resolve(path.dirname(endpoint)))) return;
  if (!/^chat-relay-[a-f0-9]{32}\.sock$/.test(path.basename(endpoint))) return;
  fs.rmSync(endpoint, { force: true });
}

function reclaim(lockDir) {
  const staleDir = `${lockDir}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lockDir, staleDir);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
    throw error;
  }
  fs.rmSync(staleDir, { recursive: true, force: true });
  return true;
}

export async function acquireRunnerOwnership({
  relayUrl,
  agentId,
  directory = configDir(),
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (!relayUrl || !agentId) throw new Error("Runner ownership requires relayUrl and agentId");

  const key = ownershipKey(relayUrl, agentId);
  const locksDir = path.join(directory, "runner-locks");
  const lockDir = path.join(locksDir, key);
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const metadata = readMetadata(lockDir);
      if (await probeOwner(metadata, probeTimeoutMs)) {
        throw new RunnerAlreadyActiveError({ agentId, relayUrl, pid: metadata.pid });
      }

      let ageMs = Number.POSITIVE_INFINITY;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch {}
      if (ageMs < startupGraceMs) {
        await delay(Math.min(50, Math.max(1, startupGraceMs - ageMs)));
        continue;
      }
      if (reclaim(lockDir)) removeStaleSocket(metadata?.endpoint);
      else await delay(50);
      continue;
    }

    const token = randomUUID();
    const endpoint = socketEndpoint(key, token);
    const metadata = {
      version: 1,
      pid: process.pid,
      token,
      endpoint,
      relayUrl: normalizeRelayUrl(relayUrl),
      agentId: String(agentId),
      createdAt: new Date().toISOString(),
    };
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.end(`OWNER ${token}\n`));
    });

    try {
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(metadata), { mode: 0o600 });
      removeSocket(endpoint);
      await listen(server, endpoint);
      server.unref();
      if (process.platform !== "win32") {
        try { fs.chmodSync(endpoint, 0o600); } catch {}
      }
      if (readMetadata(lockDir)?.token !== token) {
        await close(server);
        removeSocket(endpoint);
        continue;
      }
    } catch (error) {
      try { await close(server); } catch {}
      removeSocket(endpoint);
      if (readMetadata(lockDir)?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await close(server);
        removeSocket(endpoint);
        if (readMetadata(lockDir)?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
}
