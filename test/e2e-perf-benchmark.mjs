import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileManager } from "../agent/file-manager.mjs";
import { provisionOperatorFixture } from "./operator-fixture.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const workspace = path.join(repo, ".workspace");
const mode = process.argv.includes("--mcp") ? "mcp" : "handler";
const requested = process.argv.find((arg) => arg.startsWith("--samples="));
const samples = Math.min(100, Math.max(3, Number(requested?.split("=")[1] || 30)));
const warmups = 3;
const filesCount = 8;
const tick = () => performance.now();
const percentile = (values, p) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)].toFixed(3));
};
const summarize = (values) => ({
  samples: values.length,
  p50Ms: percentile(values, .5),
  p95Ms: percentile(values, .95),
  minMs: Number(Math.min(...values).toFixed(3)),
  maxMs: Number(Math.max(...values).toFixed(3)),
});
await fs.mkdir(workspace, { recursive: true });
const fixture = await fs.mkdtemp(path.join(workspace, "perf-e2e-"));
const paths = Array.from({ length: filesCount }, (_, index) => path.join(fixture, "file-" + index + ".kt"));
for (let i = 0; i < paths.length; i++) {
  await fs.writeFile(paths[i], "line 1\nneedle_" + i + "\nline 3\n", "utf8");
}
const manager = new FileManager(fixture);
let child = null;
let endpoint = null;
let invokeId = 1;
const expected = paths.map((_, index) => "line 1\nneedle_" + index + "\nline 3\n");
const base = (process.env.TEST_RELAY_URL || "").replace(/\/$/, "");
function cleanError(error) {
  return error instanceof Error ? error.message.replace(/(Bearer\s+)[^\s]+/g, "$1[redacted]") : "unexpected_error";
}
async function connect() {
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
    throw new Error("MCP benchmark requires TEST_RELAY_URL=http://127.0.0.1:<local-worker-port>; no production traffic.");
  }
  const suffix = randomUUID().slice(0, 8);
  const creds = await provisionOperatorFixture(base, {
    userId: "perf-" + suffix, name: "Performance Test",
    agentId: "perf-" + suffix, agentName: "Performance Test Agent",
  });
  let agentOutput = "";
  child = spawn(process.execPath, ["agent/local-agent.mjs"], {
    cwd: repo, env: {
      ...process.env, RELAY_URL: base, AGENT_ID: creds.agent.id,
      AGENT_NAME: creds.agent.name, AGENT_TOKEN: creds.agentToken,
      ALLOWED_ROOTS: fixture, TERMINAL_ENABLED: "1",
      DESKTOP_ENABLED: "0", CHAT_RELAY_UI: "plain",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => { agentOutput = (agentOutput + String(data)).slice(-6000); });
  }
  for (let i = 0; i < 100 && !agentOutput.includes("Agent connected"); i++) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!agentOutput.includes("Agent connected")) throw new Error("local fixture agent failed to connect");
  endpoint = base + "/mcp?key=" + encodeURIComponent(creds.userToken);
}
async function rpc(name, args = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++invokeId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error("MCP HTTP " + response.status);
  const dataLine = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine ? dataLine.slice(6) : body);
  if (parsed.error || parsed.result?.isError) throw new Error("MCP tool rejected " + name);
  const envelope = JSON.parse(parsed.result.content[0].text);
  if (envelope.payload?.ok === false) throw new Error("Local agent rejected " + name);
  return envelope.payload;
}
async function readOne(pathname) {
  return mode === "mcp"
    ? rpc("read_file", { path: pathname, offset: 0, length: 4 })
    : manager.read(pathname, 0, 4);
}
async function readBatch() {
  const operations = paths.map((p, i) => ({ id: String(i), op: "read", path: p, offset: 0, length: 4 }));
  return mode === "mcp" ? rpc("fs_batch", { operations }) : manager.batch(operations);
}
async function readMany() {
  const requests = paths.map((p) => ({ path: p, offset: 0, length: 4 }));
  return mode === "mcp" ? rpc("read_multiple_files", { paths: requests }) : manager.readMany(requests);
}
async function scenario(kind) {
  let output;
  if (kind === "sequential") {
    output = [];
    for (const pathname of paths) output.push((await readOne(pathname)).content);
  } else if (kind === "parallel") {
    output = (await Promise.all(paths.map(readOne))).map((r) => r.content);
  } else if (kind === "batch") {
    const response = await readBatch();
    assert.equal(response.results.length, filesCount);
    assert.equal(response.nextIndex, null);
    output = response.results.map((r) => {
      assert.equal(r.ok, true);
      return r.result.content;
    });
  } else {
    const response = await readMany();
    assert.equal(response.files.length, filesCount);
    assert.equal(response.nextIndex, null);
    output = response.files.map((r) => {
      assert.equal(r.ok, true);
      return r.content;
    });
  }
  // read() splits lines and normalizes trailing newline, so compare to its own reference.
  for (let i = 0; i < filesCount; i++) {
    assert.equal(output[i], expected[i]);
  }
}
async function main() {
  if (mode === "mcp") await connect();
  const cases = ["sequential", "parallel", "batch", "readMany"];
  const timings = Object.fromEntries(cases.map((kind) => [kind, []]));
  for (let i = 0; i < warmups + samples; i++) {
    // Alternate the order to control for warm caches and machine drift.
    const ordered = i % 2 ? [...cases].reverse() : cases;
    for (const kind of ordered) {
      const start = tick();
      await scenario(kind);
      if (i >= warmups) timings[kind].push(tick() - start);
    }
  }
  const results = Object.fromEntries(cases.map((kind) => [kind, {
    ...summarize(timings[kind]),
    callsPerScenario: kind === "sequential" || kind === "parallel" ? 8 : 1,
  }]));
  const improvementPct = Number((100 * (1 - results.batch.p50Ms / results.sequential.p50Ms)).toFixed(2));
  console.log(JSON.stringify({
    kind: "chat-relay-e2e-perf", version: 1, mode,
    target: mode === "mcp" ? "local HTTP MCP Worker -> Relay DO -> WebSocket -> fixture agent" : "in-process FileManager only",
    excludes: ["model inference", "ChatGPT connector/host scheduling", "Cloudflare production analytics"],
    fixtureFiles: filesCount, samples, warmups, callsPerWorkflow: results,
    batchVsSequentialP50ImprovementPct: improvementPct,
    resultParity: true, checkedSecurity: false,
  }, null, 2));
}
try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ kind: "chat-relay-e2e-perf", mode, ok: false, error: cleanError(error) }));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await fs.rm(fixture, { recursive: true, force: true });
}
