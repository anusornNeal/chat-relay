import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

// Run the actual MCP registrations and Learn DO handlers without a live
// Cloudflare deployment, account credentials or external MCP catalog sync.
const bundle = await build({
  stdin: {
    contents: 'export { createMcpServer } from "./src/worker-app"; export { Learning } from "./src/learning";',
    resolveDir: process.cwd(),
    sourcefile: "learn-usage-mcp-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", packages: "external", write: false,
  plugins: [{
    name: "cloudflare-stub",
    setup(bundler) {
      bundler.onResolve({ filter: /^cloudflare:workers$/ },
        () => ({ path: "worker-stub", namespace: "worker-stub" }));
      bundler.onLoad({ filter: /.*/, namespace: "worker-stub" },
        () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
    },
  }],
});
const directory = mkdtempSync(join(process.cwd(), ".learn-usage-mcp-test-"));
let createMcpServer;
let Learning;
try {
  const entrypoint = join(directory, "bundle.mjs");
  writeFileSync(entrypoint, bundle.outputFiles[0].text);
  ({ createMcpServer, Learning } = await import(pathToFileURL(entrypoint).href));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const db = new DatabaseSync(":memory:");
const sql = {
  exec(query, ...values) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...values)
      : (statement.run(...values), []);
    return { toArray: () => rows };
  },
};
const learning = new Learning({
  storage: {
    sql,
    transactionSync(callback) {
      db.exec("BEGIN TRANSACTION");
      try {
        const result = callback();
        db.exec("COMMIT");
        return result;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  },
}, {});
const calls = [];
const env = {
  LEARNING: {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: (request) => {
        calls.push(new URL(request.url).pathname);
        return name === "user-learn-test"
          ? learning.fetch(request)
          : Response.json({ items: [] });
      },
    }),
  },
  // Optional operational usage telemetry is deliberately disabled in this test.
  USAGE_RECORD_DAILY_BUDGET: 0,
};
const user = { id: "user-learn-test", email: "test@example.com", admin: false };
const post = async (path, body) => {
  const response = await learning.fetch(new Request("https://learning.internal" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200, path);
  return response.json();
};
const memory = (await post("/put", {
  key: "safe-machine-paths",
  kind: "workflow",
  scope: "global",
  content: "For machine work, verify workspace paths before using them.",
})).item;

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createMcpServer(env, user);
const client = new Client({ name: "learn-usage-test", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

const parseTool = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content.find((entry) => entry.type === "text").text);
};
try {
  const catalog = await client.listTools();
  const prepareTool = catalog.tools.find((tool) => tool.name === "learn_prepare");
  const reportTool = catalog.tools.find((tool) => tool.name === "learn_usage_report");
  assert.ok(prepareTool, "MCP tools/list must expose prepare");
  assert.ok(reportTool, "MCP tools/list must expose the report for plugin sync");
  assert.ok(reportTool.inputSchema.properties.receiptId);
  assert.ok(reportTool.inputSchema.properties.appliedMemoryIds);
  assert.ok(reportTool.description.includes("Evaluates every prepared private memory"));

  const prepared = parseTool(await client.callTool({
    name: "learn_prepare",
    arguments: { query: "Verify machine paths before using them", limit: 8 },
  }));
  assert.ok(prepared.usageReceiptId, "prepare returns a reportable receipt");
  assert.ok(prepared.preparedContext.items.some((item) => item.id === memory.id));
  assert.match(prepared.guidance, /learn_usage_report/);
  assert.equal((await post("/profile", { limit: 10 })).items[0].usage.status, "unrated");

  const result = parseTool(await client.callTool({
    name: "learn_usage_report",
    arguments: {
      receiptId: prepared.usageReceiptId,
      appliedMemoryIds: [memory.id],
      verified: [{ memoryId: memory.id, evidenceRef: "test:mcp-prepared-memory-was-applied" }],
    },
  }));
  assert.deepEqual([result.changed, result.evaluated, result.applied, result.verified],
    [true, 1, 1, 1]);
  const profile = (await post("/profile", { limit: 10 })).items[0].usage;
  assert.deepEqual([profile.retrieved, profile.evaluated, profile.applied, profile.verified],
    [1, 1, 1, 1]);
  assert.equal(profile.status, "rated");
  assert.ok(profile.score > 0);

  const retry = parseTool(await client.callTool({
    name: "learn_usage_report",
    arguments: { receiptId: prepared.usageReceiptId, appliedMemoryIds: [memory.id] },
  }));
  assert.equal(retry.changed, false, "reporting one receipt twice must not double-count");

  const next = parseTool(await client.callTool({
    name: "learn_prepare",
    arguments: { query: "Check machine paths for the task", limit: 8 },
  }));
  assert.ok(next.usageReceiptId);
  // OpenAI optimizes tool calls by registering only the named tool.
  // The report must still execute in that narrowed MCP server.
  const [hintClientTransport, hintServerTransport] = InMemoryTransport.createLinkedPair();
  const hintServer = createMcpServer(env, user, "learn_usage_report");
  const hintClient = new Client({ name: "hinted-learn-test", version: "1.0.0" });
  await hintServer.connect(hintServerTransport);
  await hintClient.connect(hintClientTransport);
  let unused;
  try {
    const hintedTools = (await hintClient.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(hintedTools, ["learn_usage_report"]);
    unused = parseTool(await hintClient.callTool({
      name: "learn_usage_report",
      arguments: { receiptId: next.usageReceiptId, appliedMemoryIds: [] },
    }));
  } finally {
    await hintClient.close();
    await hintServer.close();
  }
  assert.deepEqual([unused.evaluated, unused.applied, unused.verified], [1, 0, 0]);
  const final = (await post("/profile", { limit: 10 })).items[0].usage;
  assert.deepEqual([final.retrieved, final.evaluated, final.applied, final.verified],
    [2, 2, 1, 1]);
  assert.equal(calls.filter((path) => path === "/usage/prepare").length, 2);
  assert.equal(calls.filter((path) => path === "/usage/report").length, 3);

  const [emptyClientTransport, emptyServerTransport] = InMemoryTransport.createLinkedPair();
  const emptyServer = createMcpServer(env, { ...user, id: "user-empty" });
  const emptyClient = new Client({ name: "empty-learn-test", version: "1.0.0" });
  await emptyServer.connect(emptyServerTransport);
  await emptyClient.connect(emptyClientTransport);
  try {
    const empty = parseTool(await emptyClient.callTool({
      name: "learn_prepare",
      arguments: { query: "Task without stored memory", limit: 8 },
    }));
    assert.equal(empty.usageReceiptId, null);
    assert.match(empty.guidance, /Do not call learn_usage_report/);
    assert.equal(empty.preparedContext.items.length, 0);
  } finally {
    await emptyClient.close();
    await emptyServer.close();
  }
} finally {
  await client.close();
  await server.close();
  db.close();
}
console.log("PASS MCP catalog, prepare -> report -> score and idempotent retries");
