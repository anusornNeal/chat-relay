import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import WebSocket from "ws";
import { AGENT_PROTOCOL_VERSION, buildAgentHello } from "../agent/protocol.mjs";
import { shouldRestartAgent } from "../cli/remote.mjs";import { DesktopManager, createDesktopPlatformAdapter } from "../agent/desktop-manager.mjs";


function protocolContractTests() {
  const windows = buildAgentHello({
    agentVersion: "test-version",
    platform: "win32",
    arch: "x64",
    terminalEnabled: true,
    desktopEnabled: true,
  });
  if (windows.protocolVersion !== AGENT_PROTOCOL_VERSION || windows.agentVersion !== "test-version") {
    throw new Error("agent hello identity failed");
  }
  for (const capability of ["filesystem.batch", "terminal.batch", "desktop.control"]) {
    if (!windows.capabilities.includes(capability)) throw new Error(`missing capability: ${capability}`);
  }

  const linux = buildAgentHello({
    agentVersion: "test-version",
    platform: "linux",
    arch: "x64",
    terminalEnabled: false,
    desktopEnabled: true,
  });
  if (linux.capabilities.some((item) => item.startsWith("desktop."))) {
    throw new Error("unsupported desktop capability was advertised");
  }
  if (linux.capabilities.some((item) => item.startsWith("terminal."))) {
    throw new Error("disabled terminal capability was advertised");
  }
  if (shouldRestartAgent({ code: 3 }) !== false) {
    throw new Error("protocol incompatibility would restart the CLI loop");
  }
}

async function platformAdapterTests() {
  const windowsAdapter = createDesktopPlatformAdapter({ platform: "win32", runner: async () => ({ ok: true }) });
  if (!windowsAdapter.supported || windowsAdapter.transport !== "persistent-worker") throw new Error("windows desktop adapter contract failed");
  const windowsManager = new DesktopManager({ enabled: true, adapter: windowsAdapter });
  if (!windowsManager.getConfig().supported || windowsManager.getConfig().platform !== "win32") throw new Error("windows desktop manager config failed");

  for (const platform of ["darwin", "linux"]) {
    const adapter = createDesktopPlatformAdapter({ platform });
    if (adapter.supported || adapter.transport !== "unsupported") throw new Error(`${platform} desktop adapter was unexpectedly supported`);
    const manager = new DesktopManager({ enabled: true, adapter });
    const config = manager.getConfig();
    if (config.supported || config.platform !== platform) throw new Error(`${platform} desktop config failed`);
    const result = await manager.screenshot();
    if (result.error !== "unsupported_platform") throw new Error(`${platform} desktop call did not degrade explicitly`);
    manager.close();
  }

  const darwinHello = buildAgentHello({ agentVersion: "test-version", platform: "darwin", arch: "arm64", terminalEnabled: true, desktopEnabled: false });
  if (!darwinHello.capabilities.includes("filesystem.batch") || !darwinHello.capabilities.includes("terminal.batch")) throw new Error("darwin core capabilities missing");
  if (darwinHello.capabilities.some((item) => item.startsWith("desktop."))) throw new Error("darwin desktop capability advertised");
  windowsManager.close();
}

await platformAdapterTests();
protocolContractTests();

import { FileManager } from "../agent/file-manager.mjs";

async function fsBatchBoundaryTests() {
  const manager = new FileManager(process.cwd());
  let rejected = false;
  try {
    await manager.batch(Array.from({ length: 21 }, () => ({ op: "stat", path: "README.md" })));
  } catch (error) {
    rejected = error instanceof Error && error.message === "invalid_batch";
  }
  if (!rejected) throw new Error("fs batch item cap was not enforced");
}

async function allowedRootBoundaryTests() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "chat-relay-boundary-"));
  const allowed = path.join(sandbox, "allowed");
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret", "utf8");
  const escape = path.join(allowed, "escape");
  fs.symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  const manager = new FileManager(allowed);
  const expectBlocked = async (operation, label) => {
    let code = "";
    try { await operation(); } catch (error) { code = error instanceof Error ? error.message : String(error); }
    if (code !== "path_not_allowed") throw new Error(label + " escaped allowedRoots: " + code);
  };
  try {
    await expectBlocked(() => manager.read(path.join(allowed, "..", "outside", "secret.txt")), "path traversal");
    await expectBlocked(() => manager.read(path.join(escape, "secret.txt")), "symlink read");
    await expectBlocked(() => manager.write(path.join(escape, "new.txt"), "blocked"), "symlink write");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

await fsBatchBoundaryTests();
await allowedRootBoundaryTests();

const vars = Object.fromEntries(
  fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
    .filter((line) => line && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);

const base = process.env.TEST_RELAY_URL || "http://127.0.0.1:8795";
const ownerToken = vars.CALLER_TOKEN;
const adminToken = vars.ADMIN_TOKEN;

async function admin(route, method = "GET", body) {
  const response = await fetch(base + route, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`admin ${route}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function mcpUrl(token) {
  return `${base}/mcp?key=${encodeURIComponent(token)}`;
}

async function rpc(token, id, method, params = {}) {
  const response = await fetch(mcpUrl(token), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`rpc ${response.status} ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  if (!line) throw new Error("missing MCP data");
  return JSON.parse(line.slice(6));
}

async function tool(token, id, name, args = {}, expectError = false) {
  const result = await rpc(token, id, "tools/call", { name, arguments: args });
  const text = result.result?.content?.[0]?.text;
  if (!text) throw new Error(`missing tool output for ${name}`);
  if (Boolean(result.result?.isError) !== expectError) {
    throw new Error(`${name} error mismatch: ${text}`);
  }
  return JSON.parse(text);
}

async function expectProtocolMismatch(agent) {
  const wsBase = base.replace(/^http/, "ws");
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${wsBase}/agent?agentId=${encodeURIComponent(agent.agent.id)}`,
      { headers: { authorization: `Bearer ${agent.token}` } },
    );
    let response = null;
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      reject(new Error("protocol mismatch socket timed out"));
    }, 3000);

    socket.once("open", () => {
      socket.send(JSON.stringify({
        control: "agent_hello",
        protocolVersion: 999,
        agentVersion: "future-test",
        platform: "win32",
        arch: "x64",
        capabilities: ["filesystem.read"],
      }));
    });
    socket.on("message", (raw) => {
      try { response = JSON.parse(raw.toString()); } catch {}
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, response });
    });
  });
}

async function waitForText(token, sessionId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const output = await tool(token, 900, "terminal_read", { sessionId, afterSeq: 0 });
    text = output.payload.chunks.map((chunk) => chunk.text).join("");
    if (text.includes(expected)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return text;
}

const tools = await rpc(ownerToken, 1, "tools/list");
const names = new Set(tools.result.tools.map((item) => item.name));
for (const required of [
  "list_agents", "get_config", "stat_path", "list_directory", "read_file", "read_multiple_files", "fs_batch", "create_temp_artifact",
  "write_file", "edit_block", "create_directory", "move_path", "delete_path",
  "start_search", "get_more_search_results", "list_processes", "kill_process",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_read",
  "terminal_write", "terminal_list", "terminal_kill",
  "screenshot", "mouse_click", "keyboard_input",
]) {
  if (!names.has(required)) throw new Error(`missing tool: ${required}`);
}
console.log("tool surface ok:", names.size);

const agents = await tool(ownerToken, 2, "list_agents");
if (!agents.agents?.some((agent) => agent.id === "default" && agent.online)) {
  throw new Error(`default agent not online: ${JSON.stringify(agents)}`);
}
const negotiatedAgent = agents.agents.find((agent) => agent.id === "default");
if (negotiatedAgent?.connection?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
  throw new Error(`negotiated protocol missing from list_agents: ${JSON.stringify(negotiatedAgent)}`);
}
if (!negotiatedAgent.connection.capabilities?.includes("filesystem.batch")) {
  throw new Error("negotiated capabilities missing filesystem.batch");
}
console.log("agent routing ok");

const config = await tool(ownerToken, 3, "get_config");
const configPayload = config.payload;
if (!configPayload?.allowedRoots?.length) throw new Error("missing allowed roots");
if (configPayload?.desktop?.enabled !== false) throw new Error("desktop should be disabled by default");
if (configPayload?.protocol?.protocolVersion !== AGENT_PROTOCOL_VERSION) throw new Error("agent protocol version missing from config");
if (!configPayload?.protocol?.agentVersion) throw new Error("agent package version missing from config");
if (!configPayload?.protocol?.capabilities?.includes("filesystem.batch")) throw new Error("filesystem batch capability missing from config");
if (!configPayload?.protocol?.capabilities?.includes("filesystem.artifact")) throw new Error("filesystem artifact capability missing from config");
if (configPayload.protocol.capabilities.includes("desktop.control")) throw new Error("disabled desktop capability advertised");

const disabledShot = await tool(ownerToken, 30, "screenshot", {}, true);
if (disabledShot.payload?.error !== "desktop_disabled") throw new Error("screenshot did not honor desktop opt-in gate");
const disabledClick = await tool(ownerToken, 31, "mouse_click", { x: 23456, y: 12345 }, true);
if (disabledClick.payload?.error !== "desktop_disabled") throw new Error("mouse_click did not honor desktop opt-in gate");
const secretMarker = "desktop-secret-marker-9f2d";
const disabledKeyboard = await tool(ownerToken, 32, "keyboard_input", { text: secretMarker }, true);
if (disabledKeyboard.payload?.error !== "desktop_disabled") throw new Error("keyboard_input did not honor desktop opt-in gate");
const privacyCalls = await tool(ownerToken, 33, "get_recent_tool_calls", { limit: 20 });
const privacyText = JSON.stringify(privacyCalls);
if (privacyText.includes(secretMarker) || privacyText.includes("23456") || privacyText.includes("12345")) {
  throw new Error("desktop payload leaked into recentCalls");
}
console.log("desktop opt-in/privacy gate ok");
console.log("config ok");

const root = path.join(process.cwd(), ".relay-test");
const fileA = path.join(root, "a.txt");
const fileB = path.join(root, "b.txt");
const largeA = path.join(root, "large-a.txt");
const largeB = path.join(root, "large-b.txt");

await tool(ownerToken, 4, "create_directory", { path: root });
await tool(ownerToken, 5, "write_file", { path: fileA, content: "alpha\nbeta\n", mode: "rewrite" });
const readA = await tool(ownerToken, 6, "read_file", { path: fileA, offset: 0, length: 10 });
if (!readA.payload.content.includes("beta")) throw new Error("read_file failed");
await tool(ownerToken, 7, "edit_block", { path: fileA, oldText: "beta", newText: "gamma" });
await tool(ownerToken, 8, "move_path", { source: fileA, destination: fileB });
const many = await tool(ownerToken, 9, "read_multiple_files", { paths: [fileB, "README.md"] });
if (many.payload.files?.length !== 2) throw new Error("read_multiple_files failed");
console.log("filesystem read/write/edit/move ok");
const artifact = await tool(ownerToken, 127, "create_temp_artifact", {
  path: fileB,
  ttlSeconds: 1,
});
if (typeof artifact.tempUrl !== "string" || !artifact.tempUrl.includes("/tmp-artifact/")) {
  throw new Error(`artifact URL missing: ${JSON.stringify(artifact)}`);
}
if (artifact.tempUrl.includes(root) || artifact.tempUrl.includes(fileB)) {
  throw new Error("artifact URL leaked a local path");
}
const artifactPath = artifact.tempUrl.startsWith("http") ? new URL(artifact.tempUrl).pathname : artifact.tempUrl;
const artifactResponse = await fetch(base + artifactPath);
if (!artifactResponse.ok || await artifactResponse.text() !== "alpha\ngamma\n") {
  throw new Error("artifact content mismatch");
}
if (!String(artifactResponse.headers.get("cache-control")).includes("no-store")) {
  throw new Error("artifact cache policy missing");
}
await new Promise((resolve) => setTimeout(resolve, 1100));
const expiredArtifact = await fetch(base + artifactPath);
if (expiredArtifact.status !== 410) throw new Error("artifact did not expire");

const outsideArtifact = await tool(ownerToken, 128, "create_temp_artifact", {
  path: process.execPath,
}, true);
if (outsideArtifact.payload?.error !== "path_not_allowed") {
  throw new Error(`outside-root artifact was not blocked: ${JSON.stringify(outsideArtifact)}`);
}
const oversizedArtifactPath = path.join(root, "artifact-too-large.bin");
fs.writeFileSync(oversizedArtifactPath, Buffer.alloc(41 * 1024, 1));
const oversizedArtifact = await tool(ownerToken, 129, "create_temp_artifact", {
  path: oversizedArtifactPath,
}, true);
if (oversizedArtifact.payload?.error !== "artifact_too_large") {
  throw new Error(`oversized artifact was not blocked: ${JSON.stringify(oversizedArtifact)}`);
}
console.log("temporary artifact URL/expiry/bounds ok");

const directBatchStat = await tool(ownerToken, 122, "stat_path", { path: fileB });
const directBatchRead = await tool(ownerToken, 123, "read_file", { path: fileB, offset: 0, length: 10 });
const directBatchList = await tool(ownerToken, 124, "list_directory", { path: root, depth: 0, limit: 20 });
const fsBatch = await tool(ownerToken, 125, "fs_batch", {
  operations: [
    { id: "stat", op: "stat", path: fileB },
    { id: "read", op: "read", path: fileB, offset: 0, length: 10 },
    { id: "list", op: "list", path: root, depth: 0, limit: 20 },
    { id: "missing", op: "stat", path: path.join(root, "missing.txt") },
  ],
});
const batchById = Object.fromEntries(fsBatch.payload.results.map((entry) => [entry.id, entry]));
if (!batchById.stat?.ok || batchById.stat.result.size !== directBatchStat.payload.size) {
  throw new Error("fs_batch stat parity failed");
}
if (!batchById.read?.ok || batchById.read.result.content !== directBatchRead.payload.content) {
  throw new Error("fs_batch read parity failed");
}
if (!batchById.list?.ok || batchById.list.result.entries.length !== directBatchList.payload.entries.length) {
  throw new Error("fs_batch list parity failed");
}
if (batchById.missing?.ok !== false) throw new Error("fs_batch mixed failure semantics failed");
console.log("filesystem batch mixed-result parity ok");


const largeLinesA = Array.from({ length: 1200 }, (_, index) =>
  `A-${String(index).padStart(4, "0")} ${"x".repeat(48)}`
);
const largeLinesB = Array.from({ length: 1200 }, (_, index) =>
  `B-${String(index).padStart(4, "0")} ${"y".repeat(48)}`
);
fs.writeFileSync(largeA, largeLinesA.join("\n"), "utf8");
fs.writeFileSync(largeB, largeLinesB.join("\n"), "utf8");

const reconstructed = [];
let readOffset = 0;
let readId = 90;
while (true) {
  const chunk = await tool(ownerToken, readId++, "read_file", {
    path: largeA,
    offset: readOffset,
    length: 1000,
    maxBytes: 8192,
  });
  if (chunk.payload.offset !== readOffset) throw new Error("read_file continuation offset mismatch");
  reconstructed.push(chunk.payload.content);
  if (!chunk.payload.truncated) break;
  if (!Number.isInteger(chunk.payload.nextOffset) || chunk.payload.nextOffset <= readOffset) {
    throw new Error("read_file continuation did not advance");
  }
  readOffset = chunk.payload.nextOffset;
}
if (reconstructed.join("\n") !== largeLinesA.join("\n")) {
  throw new Error("read_file continuation did not reconstruct the source");
}

const boundedMany = await tool(ownerToken, 120, "read_multiple_files", {
  paths: [
    { path: largeA, offset: 0, length: 1000, maxBytes: 20000 },
    { path: largeB, offset: 0, length: 1000, maxBytes: 20000 },
    "README.md",
  ],
  maxTotalBytes: 32768,
});
if (!boundedMany.payload.truncated) throw new Error("large read_multiple_files was not bounded");
if (Buffer.byteLength(JSON.stringify(boundedMany.payload), "utf8") > 32768) {
  throw new Error("read_multiple_files exceeded aggregate response budget");
}
if (!boundedMany.payload.files?.length) throw new Error("bounded multi-file read returned no files");

const tinyMany = await tool(ownerToken, 121, "read_multiple_files", {
  paths: Array.from({ length: 20 }, () => largeA),
  maxTotalBytes: 4096,
});
if (!Number.isInteger(tinyMany.payload.nextIndex) ||
    tinyMany.payload.nextIndex <= 0 ||
    tinyMany.payload.nextIndex >= 20) {
  throw new Error(`aggregate continuation missing nextIndex: ${JSON.stringify(tinyMany.payload)}`);
}
if (Buffer.byteLength(JSON.stringify(tinyMany.payload), "utf8") > 4096) {
  throw new Error("tiny read_multiple_files exceeded aggregate budget");
}
console.log("bounded file read continuation ok");
const tinyBatch = await tool(ownerToken, 126, "fs_batch", {
  operations: Array.from({ length: 20 }, (_, index) => ({
    id: `read-${index}`,
    op: "read",
    path: index % 2 === 0 ? largeA : largeB,
    offset: 0,
    length: 1000,
    maxBytes: 8192,
  })),
  maxTotalBytes: 4096,
});
if (!Number.isInteger(tinyBatch.payload.nextIndex) ||
    tinyBatch.payload.nextIndex <= 0 ||
    tinyBatch.payload.nextIndex >= 20) {
  throw new Error(`fs_batch aggregate continuation missing: ${JSON.stringify(tinyBatch.payload)}`);
}
if (Buffer.byteLength(JSON.stringify(tinyBatch.payload), "utf8") > 4096) {
  throw new Error("fs_batch exceeded aggregate response budget");
}
console.log("filesystem batch aggregate continuation ok");


const hiddenNoise = path.join(root, ".generated-noise");
fs.mkdirSync(hiddenNoise, { recursive: true });
for (let index = 0; index < 5001; index++) {
  fs.writeFileSync(path.join(hiddenNoise, `noise-${index}.txt`), "no-match");
}

const search = await tool(ownerToken, 10, "start_search", {
  path: root,
  pattern: "gamma",
  searchType: "content",
});
const searchPage = await tool(ownerToken, 11, "get_more_search_results", {
  sessionId: search.payload.sessionId,
  offset: 0,
  length: 20,
});
if (!searchPage.payload.results?.some((item) => item.path.endsWith("b.txt"))) {
  throw new Error("search failed");
}
console.log("search sessions ok");

const processes = await tool(ownerToken, 12, "list_processes", { filter: "node" });
if (!Array.isArray(processes.payload)) throw new Error("list_processes failed");
console.log("process listing ok");

const oversizeDir = path.join(root, "oversize-list");
fs.mkdirSync(oversizeDir, { recursive: true });
for (let index = 0; index < 1000; index++) {
  fs.writeFileSync(
    path.join(oversizeDir, `entry-${String(index).padStart(4, "0")}-${"z".repeat(48)}.txt`),
    "",
  );
}
const oversizeList = await tool(ownerToken, 93, "list_directory", {
  path: oversizeDir,
  depth: 0,
  limit: 500,
  maxBytes: 16384,
});
if (!oversizeList.payload?.truncated || !Number.isInteger(oversizeList.payload.nextOffset)) {
  throw new Error(`oversize list did not return continuation: ${JSON.stringify(oversizeList)}`);
}
if (Buffer.byteLength(JSON.stringify(oversizeList.payload), "utf8") > 16384) {
  throw new Error("list_directory exceeded response budget");
}
const oversizeListPage2 = await tool(ownerToken, 94, "list_directory", {
  path: oversizeDir,
  depth: 0,
  offset: oversizeList.payload.nextOffset,
  limit: 500,
  maxBytes: 16384,
});
if (!oversizeListPage2.payload.entries?.length) throw new Error("list_directory continuation returned no entries");
console.log("bounded directory continuation ok");

const execResult = await tool(ownerToken, 13, "terminal_exec", { command: "Get-Location" });
if (!execResult.payload.ok || execResult.payload.exitCode !== 0) throw new Error("terminal_exec failed");

const started = await tool(ownerToken, 14, "terminal_start", {
  command: "Write-Output long-start; Start-Sleep -Milliseconds 250; Write-Output long-end",
});
const longText = await waitForText(
  ownerToken,
  started.payload.sessionId,
  "long-end",
);
if (!longText.includes("long-start") || !longText.includes("long-end")) {
  throw new Error("terminal_start/read failed");
}

const shell = await tool(ownerToken, 16, "terminal_start_shell");
await tool(ownerToken, 17, "terminal_write", {
  sessionId: shell.payload.sessionId,
  input: "Write-Output interactive-ok",
});
const shellText = await waitForText(
  ownerToken,
  shell.payload.sessionId,
  "interactive-ok",
);
if (!shellText.includes("interactive-ok")) {
  throw new Error("interactive terminal failed");
}
await tool(ownerToken, 19, "terminal_kill", { sessionId: shell.payload.sessionId });
console.log("terminal sessions ok");

const suffix = Date.now().toString(36);
const readerUser = await admin("/admin/users", "POST", {
  name: "Reader Test",
  id: `reader-${suffix}`,
});
await admin("/admin/grants", "POST", {
  userId: readerUser.user.id,
  agentId: "default",
  scopes: ["read"],
});

const readerRead = await tool(readerUser.token, 20, "read_file", { path: "README.md" });
if (!readerRead.payload.content.includes("chat-relay")) throw new Error("reader grant failed");
await tool(readerUser.token, 21, "terminal_exec", { command: "Get-Location" }, true);
console.log("scope enforcement ok");

const secondary = await admin("/admin/agents", "POST", {
  name: "Secondary Test",
  id: `secondary-${suffix}`,
});
const protocolMismatch = await expectProtocolMismatch(secondary);
if (protocolMismatch.code !== 4002 ||
    protocolMismatch.response?.control !== "protocol_incompatible" ||
    protocolMismatch.response?.expectedProtocolVersion !== AGENT_PROTOCOL_VERSION) {
  throw new Error(`protocol mismatch negotiation failed: ${JSON.stringify(protocolMismatch)}`);
}
console.log("protocol mismatch rejection ok");
await admin("/admin/grants", "POST", {
  userId: readerUser.user.id,
  agentId: secondary.agent.id,
  scopes: ["read"],
});
const readerAgents = await tool(readerUser.token, 22, "list_agents");
if (readerAgents.agents?.length !== 2) throw new Error("multi-agent grant failed");
await tool(readerUser.token, 23, "ping_agent", {}, true);
const explicitPing = await tool(readerUser.token, 24, "ping_agent", { agentId: "default" });
if (explicitPing.payload.action !== "pong") throw new Error("explicit agent routing failed");
console.log("multi-agent selection ok");

const rotated = await admin("/admin/users/rotate", "POST", { userId: readerUser.user.id });
let oldRejected = false;
try {
  await rpc(readerUser.token, 25, "tools/list");
} catch (error) {
  oldRejected = String(error).includes("401");
}
if (!oldRejected) throw new Error("old user token was not rejected after rotation");
const rotatedWho = await tool(rotated.token, 26, "whoami");
if (rotatedWho.user.id !== readerUser.user.id) throw new Error("rotated token failed");
console.log("token rotation ok");

await tool(ownerToken, 27, "delete_path", { path: root, recursive: true });
console.log("cleanup ok");
console.log("multi-user/full tool smoke test passed");
