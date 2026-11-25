import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const size = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = value => Math.round(value * 100) / 100;

test("real MCP registration and real local agent over loopback WebSocket, with fixture registry", async t => {
  await fs.mkdir(".workspace", { recursive: true });
  const directory = await fs.mkdtemp(path.resolve(".workspace", "efficiency-mcp-"));
  const root = path.join(directory, "project");
  const home = path.join(directory, "agent-home");
  await fs.mkdir(root);
  let child, socket;
  const clients = [];
  const pending = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => {});
      child.kill();
      await Promise.race([exited, wait(2000)]);
    }
    for (const conn of sockets) conn.terminate();
    await new Promise(resolve => wss.close(resolve));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error("fixture_closed")); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await once(wss, "listening");
  const relayUrl = "http://127.0.0.1:" + wss.address().port;
  let hello;
  let wireCalls = 0;
  wss.on("connection", conn => {
    socket = conn; sockets.add(conn); hello = null;
    conn.on("close", () => { sockets.delete(conn); if (socket === conn) socket = null; });
    conn.on("message", raw => {
      const msg = JSON.parse(String(raw));
      if (msg.control === "agent_hello") { hello = msg; return; }
      if (msg.control === "agent_heartbeat") {
        conn.send(JSON.stringify({ control: "agent_heartbeat_ack", connectionGeneration: 1 }));
        return;
      }
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId); clearTimeout(entry.timer); entry.resolve(msg);
    });
  });

  const agentId = "efficiency-fixture";
  async function startAgent() {
    hello = null;
    let log = "";
    child = spawn(process.execPath, ["agent/local-agent.mjs"], { cwd: process.cwd(),
      env: { ...process.env, RELAY_URL: relayUrl, AGENT_TOKEN: "fixture-only", AGENT_ID: agentId,
        TERMINAL_ENABLED: "1", DESKTOP_ENABLED: "0", ALLOWED_ROOTS: root,
        CHAT_RELAY_UI: "plain", CHAT_RELAY_HOME: home, CHAT_RELAY_USAGE_DISABLED: "0" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", chunk => { log = (log + String(chunk)).slice(-4000); });
    child.stderr.on("data", chunk => { log = (log + String(chunk)).slice(-4000); });
    for (let i = 0; i < 150 && !hello; i++) {
      if (child.exitCode !== null) break;
      await wait(50);
    }
    assert.ok(hello, "fixture agent startup: " + log);
    assert.ok(hello.capabilities.includes("filesystem.editMany"));
    assert.ok(hello.capabilities.includes("terminal.output.compact"));
    assert.ok(hello.capabilities.includes("agent.usageStats"));
  }

  const bundle = await build({
    stdin: { contents: 'export { createMcpServer } from "./src/worker-app";',
      resolveDir: process.cwd(), sourcefile: "efficiency-entry.ts" },
    bundle: true, format: "esm", platform: "node", packages: "external", write: false,
    plugins: [{ name: "cloudflare-stub", setup(bundler) {
      bundler.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "stub", namespace: "stub" }));
      bundler.onLoad({ filter: /.*/, namespace: "stub" },
        () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
    } }],
  });
  const entrypoint = path.join(directory, "worker.mjs");
  await fs.writeFile(entrypoint, bundle.outputFiles[0].text);
  const { createMcpServer } = await import(pathToFileURL(entrypoint).href);

  const forwarded = [];
  const env = {
    USAGE_RECORD_DAILY_BUDGET: 0,
    REGISTRY: { idFromName: name => name, get: () => ({ fetch: async req => {
      const route = new URL(req.url).pathname;
      if (route === "/security/revision") return Response.json({ revision: 1 });
      assert.equal(route, "/resolve");
      const args = await req.json();
      const scopes = args.userId === "owner-fixture" ? ["*"] : ["read"];
      if (!scopes.includes("*") && !scopes.includes(args.scope)) {
        return Response.json({ error: "permission_denied" }, { status: 403 });
      }
      return Response.json({ agent: { id: agentId }, scopes, securityRevision: 1 });
    } }) },
    RELAY: { idFromName: name => name, get: () => ({ fetch: async req => {
      const { payload } = await req.json();
      assert.ok(socket);
      forwarded.push(payload.action);
      wireCalls++;
      const requestId = randomUUID();
      const value = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error("fixture_rpc_timeout")); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ requestId, payload }));
      });
      return Response.json(value);
    } }) },
  };
  async function connect(id) {
    const client = new Client({ name: id, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(env, { id, email: id + "@example.com", admin: false });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);
    return client;
  }
  const owner = await connect("owner-fixture"), reader = await connect("read-fixture");
  const catalog = (await owner.listTools()).tools;
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  assert.equal(catalog.length, 66);
  assert.equal(byName.get("edit_files").annotations.readOnlyHint, false);
  assert.equal(byName.get("edit_files").annotations.destructiveHint, true);
  assert.equal(byName.get("fs_batch").annotations.readOnlyHint, true);
  const schemaBytes = size(Object.fromEntries(catalog.map(tool => [tool.name, {
    inputSchema: tool.inputSchema, annotations: tool.annotations, outputSchema: tool.outputSchema
  }])));
  const descriptionBytes = catalog.reduce((n, tool) => n + Buffer.byteLength(tool.description || ""), 0);
  async function call(client, name, args = {}, allowError = false) {
    const result = await client.callTool({ name, arguments: { agentId, ...args } });
    if (!allowError) assert.ok(!result.isError, JSON.stringify(result));
    const text = result.content.find(item => item.type === "text")?.text;
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text }; }
    return { payload: json.payload ?? json, isError: !!result.isError, bytes: Buffer.byteLength(text || "") };
  }

  await startAgent();
  const editArgs = { basePath: root, operations: [{ op: "create", path: "forbidden.txt", content: "blocked" }] };
  const before = wireCalls;
  const denied = await call(reader, "edit_files", editArgs, true);
  assert.equal(denied.isError, true);
  assert.equal(denied.payload.error, "permission_denied");
  assert.equal(wireCalls, before, "read-only grant must not send write action");
  await assert.rejects(fs.stat(path.join(root, "forbidden.txt")), { code: "ENOENT" });

  let invalidRead;
  const beforeInvalid = wireCalls;
  try { invalidRead = await call(reader, "fs_batch", { basePath: root,
    operations: [{ op: "create", path: "bad.txt", content: "blocked" }] }, true); }
  catch { invalidRead = { isError: true }; }
  assert.equal(invalidRead.isError, true);
  assert.equal(wireCalls, beforeInvalid, "read-only batch schema rejects write operations");

  const files = Array.from({ length: 8 }, (_, i) => "file-" + i + ".txt");
  const created = await call(owner, "edit_files", { basePath: root, operations: files.map(name =>
    ({ op: "create", path: name, content: "OLD\n" })) });
  assert.equal(created.payload.succeeded, 8);
  const reads = await call(reader, "read_multiple_files", { basePath: root, paths: files });
  assert.equal(reads.payload.files.length, 8);
  assert.ok(reads.payload.files.every(file => file.ok && file.content === "OLD\n"));
  assert.equal(forwarded.at(-1), "fs.readMany.relative");
  const legacyRead = await call(reader, "read_multiple_files", { paths: [path.join(root, files[0])] });
  assert.equal(legacyRead.payload.files[0].content, "OLD\n");
  assert.equal(forwarded.at(-1), "fs.readMany");
  const sequentialMs = [], batchMs = [];
  let sequentialCalls = 0, batchCalls = 0;
  for (let i = 0; i < 5; i++) {
    let mark = performance.now(), n = wireCalls;
    for (const name of files) await call(owner, "edit_block", { path: path.join(root, name), oldText: "OLD", newText: "NEW" });
    sequentialMs.push(performance.now() - mark); sequentialCalls += wireCalls - n;
    mark = performance.now(); n = wireCalls;
    const batch = await call(owner, "edit_files", { basePath: root, operations: files.map(name =>
      ({ op: "edit", path: name, edits: [{ oldText: "NEW", newText: "OLD" }] })) });
    batchMs.push(performance.now() - mark); batchCalls += wireCalls - n;
    assert.equal(batch.payload.succeeded, files.length);
    for (const name of files) assert.equal(await fs.readFile(path.join(root, name), "utf8"), "OLD\n");
  }
  assert.equal(sequentialCalls, 40);
  assert.equal(batchCalls, 5);

  const lines = Array.from({ length: 35 }, (_, i) => "line " + i + " " + "abcdefghij".repeat(12));
  lines[10] += " UNIQUE_ALPHA"; lines[13] += " UNIQUE_BETA"; lines[15] += " UNIQUE_GAMMA";
  await fs.writeFile(path.join(root, "search.kt"), lines.join("\n"));
  const operations = ["UNIQUE_ALPHA", "UNIQUE_BETA", "UNIQUE_GAMMA"].map(pattern =>
    ({ op: "search", path: ".", searchType: "content", pattern, previewLines: 18 }));
  const rawSearch = await call(reader, "fs_batch", { basePath: root, operations });
  const packedSearch = await call(reader, "fs_batch", { basePath: root, operations, deduplicatePreviews: true });
  assert.ok(packedSearch.payload.sharedPreviews.length);
  assert.ok(packedSearch.bytes < rawSearch.bytes);
  assert.deepEqual(packedSearch.payload.results.map(row => row.result.results.map(match => match.line)),
    rawSearch.payload.results.map(row => row.result.results.map(match => match.line)));

  const command = process.platform === "win32"
    ? "1..400 | ForEach-Object { Write-Output ('line ' + $_ + ('x' * 15)) }"
    : "for i in $(seq 1 400); do printf 'line %sxxxxxxxxxxxxxxx\\n' $i; done";
  const full = await call(owner, "terminal_exec", { command, cwd: root });
  const summary = await call(owner, "terminal_exec", { command, cwd: root, outputMode: "summary" });
  assert.equal(summary.payload.exitCode, 0);
  assert.equal(summary.payload.stdout, "");
  assert.ok(summary.bytes < full.bytes);
  assert.ok(summary.payload.rawOutputId);
  const replay = await call(owner, "terminal_read", { sessionId: summary.payload.rawOutputId });
  assert.equal(replay.payload.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join(""),
    full.payload.stdout);
  const history = await call(reader, "get_recent_tool_calls", { view: "history", limit: 10 });
  assert.equal(history.payload.capacity, 1000);
  assert.ok(history.payload.nextCursor);
  const next = await call(reader, "get_recent_tool_calls", { view: "history", limit: 10, cursor: history.payload.nextCursor });
  assert.ok(next.payload.calls.at(-1).seq < history.payload.calls[0].seq);
  const stats = await call(reader, "get_recent_tool_calls", { view: "stats", days: 30 });
  assert.ok(stats.payload.totals.calls > 40);
  assert.equal(stats.payload.byTool.find(row => row.action === "fs.editMany").batchSucceeded, 48);
  assert.equal(stats.payload.byTool.find(row => row.action === "fs.readMany").readItems, 9);
  assert.ok(stats.payload.totals.estimatedSavedReadCalls >= 7);
  assert.equal(stats.payload.retentionDays, 30);
  // Real graceful restart exercises flush/load; no raw content is persisted.
  await call(owner, "drain_agent");
  const exited = once(child, "exit");
  await call(owner, "restart_agent");
  const [exitCode] = await exited;
  assert.equal(exitCode, 4);
  const persisted = await fs.readdir(path.join(home, "usage"));
  assert.equal(persisted.filter(name => name.endsWith(".json")).length, 1);
  const disk = await fs.readFile(path.join(home, "usage", persisted.find(name => name.endsWith(".json"))), "utf8");
  assert.ok(!disk.includes("UNIQUE_ALPHA") && !disk.includes("file-0") && !disk.includes("fixture-only"));
  await startAgent();
  const restored = await call(reader, "get_recent_tool_calls", { view: "stats", days: 30 });
  assert.ok(restored.payload.totals.calls >= stats.payload.totals.calls);
  assert.equal(restored.payload.recentRetained, 0);

  console.log(JSON.stringify({ benchmark: "loopback MCP + real local agent; fixture registry/relay; no Cloudflare/model time",
    catalog: { tools: catalog.length, schemaBytes, descriptionBytes },
    edit: { samples: 5, sequentialCalls: sequentialCalls / 5, batchCalls: batchCalls / 5,
      sequentialP50Ms: rounded(median(sequentialMs)), batchP50Ms: rounded(median(batchMs)) },
    search: { rawBytes: rawSearch.bytes, packedBytes: packedSearch.bytes },
    terminal: { fullBytes: full.bytes, summaryBytes: summary.bytes, replayBytes: replay.bytes },
    relativeReadArguments: { absolute: size({ paths: files.map(name => path.join(root, name)) }),
      relative: size({ basePath: root, paths: files }) },
  }));
});
