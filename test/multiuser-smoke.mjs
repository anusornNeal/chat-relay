import fs from "node:fs";
import path from "node:path";

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
  "list_agents", "get_config", "list_directory", "read_file", "read_multiple_files",
  "write_file", "edit_block", "create_directory", "move_path", "delete_path",
  "start_search", "get_more_search_results", "list_processes", "kill_process",
  "terminal_exec", "terminal_start", "terminal_start_shell", "terminal_read",
  "terminal_write", "terminal_list", "terminal_kill",
]) {
  if (!names.has(required)) throw new Error(`missing tool: ${required}`);
}
console.log("tool surface ok:", names.size);

const agents = await tool(ownerToken, 2, "list_agents");
if (!agents.agents?.some((agent) => agent.id === "default" && agent.online)) {
  throw new Error(`default agent not online: ${JSON.stringify(agents)}`);
}
console.log("agent routing ok");

const config = await tool(ownerToken, 3, "get_config");
const configPayload = config.payload;
if (!configPayload?.allowedRoots?.length) throw new Error("missing allowed roots");
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
}, true);
if (oversizeList.payload?.error !== "response_too_large") {
  throw new Error(`oversize response did not fail safely: ${JSON.stringify(oversizeList)}`);
}
console.log("oversize response fail-safe ok");

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
