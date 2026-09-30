import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8796").replace(/\/$/, "");
const tarball = process.env.CHAT_RELAY_TARBALL;
if (!tarball) throw new Error("CHAT_RELAY_TARBALL is required");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-relay-npx-"));
const configDir = path.join(tempDir, "config");
const suffix = Date.now().toString(36);
const login = `npx-test-${suffix}`;
const password = `Npx-${suffix}-Password!`;
const agentId = `npx-test-${suffix}`;

async function jsonFetch(route, options = {}) {
  const response = await fetch(base + route, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, data };
}

async function provision() {
  const started = await jsonFetch("/auth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, agentName: "Zero Checkout Smoke" }),
  });
  if (!started.response.ok) throw new Error(`start failed: ${JSON.stringify(started.data)}`);

  const approved = await fetch(base + "/auth/device/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      userCode: started.data.userCode,
      login,
      password,
      name: "Npx Test",
    }),
  });
  if (!approved.ok) throw new Error(`approve failed: ${approved.status}`);

  const exchanged = await jsonFetch("/auth/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: started.data.deviceCode }),
  });
  if (!exchanged.response.ok) throw new Error(`exchange failed: ${JSON.stringify(exchanged.data)}`);
  return exchanged.data;
}

const credentials = await provision();
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
  relayUrl: base,
  user: credentials.user,
  userToken: credentials.userToken,
  userTokenExpiresAt: credentials.userTokenExpiresAt,
  agentId: credentials.agent.id,
  agentName: credentials.agent.name,
  agentToken: credentials.agentToken,
  allowedRoots: tempDir,
  terminalEnabled: true,
}, null, 2));

const tarballPath = path.resolve(tarball);
const command = process.platform === "win32"
  ? {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `npm exec --yes --package=${tarballPath} -- chat-relay remote`],
    }
  : {
      file: "npm",
      args: ["exec", "--yes", `--package=${tarballPath}`, "--", "chat-relay", "remote"],
    };
const child = spawn(command.file, command.args, {
  cwd: tempDir,
  env: { ...process.env, CHAT_RELAY_HOME: configDir },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  let connected = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (output.includes("Agent connected")) {
      connected = true;
      break;
    }
    if (child.exitCode !== null) break;
  }
  if (!connected) throw new Error(`npx remote did not connect:\n${output}`);

  const status = await jsonFetch(`/status?agentId=${encodeURIComponent(credentials.agent.id)}`, {
    headers: { authorization: `Bearer ${credentials.userToken}` },
  });
  if (!status.response.ok || !status.data.online) {
    throw new Error(`npx agent not online: ${JSON.stringify(status.data)}`);
  }

  console.log("zero-checkout npx remote connected");
} finally {
  if (child.exitCode === null) {
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], () => resolve());
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("zero-checkout package smoke test passed");
