import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { provisionOperatorFixture } from "./operator-fixture.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const base = (process.env.TEST_RELAY_URL || "").replace(/\/$/, "");
const target = process.env.BUDDY_ONBOARDING_ROOT || path.join(
  path.dirname(repo), "buddy-android", "app", "src", "main", "java",
  "com", "qchang", "buddy", "compose", "ui", "onboarding_menu"
);
const samples = Math.min(100, Math.max(3, Number(
  process.argv.find((arg) => arg.startsWith("--samples="))?.split("=")[1] || 30
)));
const warmups = 3;
const pattern = "ViewModel";
const maxResults = 8;
const previewLines = 20;
const tick = () => performance.now();
const pct = (arr, n) => {
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.ceil(n * s.length) - 1].toFixed(3));
};
const stats = (arr) => ({
  samples: arr.length, p50Ms: pct(arr, .5), p95Ms: pct(arr, .95),
  minMs: Number(Math.min(...arr).toFixed(3)),
  maxMs: Number(Math.max(...arr).toFixed(3)),
});
let agent = null;
let url = "";
let nextId = 0;
let output = "";
async function connect() {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
    throw Error("Use TEST_RELAY_URL=http://127.0.0.1:<local-worker-port>, never production");
  }
  const info = await fs.stat(target);
  assert(info.isDirectory(), "Buddy onboarding root must be a directory");
  const name = randomUUID().slice(0, 8);
  const creds = await provisionOperatorFixture(base, {
    userId: "preview-" + name, name: "Preview Performance Test",
    agentId: "preview-" + name, agentName: "Preview Fixture Agent",
  });
  agent = spawn(process.execPath, ["agent/local-agent.mjs"], {
    cwd: repo,
    env: {
      ...process.env,
      RELAY_URL: base, AGENT_ID: creds.agent.id,
      AGENT_NAME: creds.agent.name, AGENT_TOKEN: creds.agentToken,
      ALLOWED_ROOTS: target, TERMINAL_ENABLED: "0", DESKTOP_ENABLED: "0",
      CHAT_RELAY_UI: "plain",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [agent.stdout, agent.stderr]) {
    stream.on("data", (chunk) => { output = (output + String(chunk)).slice(-6000); });
  }
  for (let i = 0; i < 100 && !output.includes("Agent connected"); i++) {
    if (agent.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!output.includes("Agent connected")) {
    throw Error("fixture agent failed to connect: " + output.slice(-1200));
  }
  url = base + "/mcp?key=" + encodeURIComponent(creds.userToken);
}
async function rpc(name, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++nextId, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.text();
  assert(response.ok, "MCP HTTP " + response.status);
  const line = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const result = JSON.parse(line ? line.slice(6) : body);
  assert(!result.error && !result.result?.isError, "MCP " + name + " failed");
  const envelope = JSON.parse(result.result.content[0].text);
  assert(envelope.payload?.ok !== false, "agent " + name + " failed");
  return envelope;
}
const searchArgs = { path: target, pattern, searchType: "files", maxResults };
async function runScenario(kind) {
  const start = tick();
  const found = await rpc("start_search", {
    ...searchArgs, ...(kind === "combined" ? { previewLines } : {}),
  });
  assert.equal(found.payload.status, "COMPLETED");
  assert(found.payload.results.length > 0, "no matching Buddy ViewModels");
  const paths = found.payload.results.map((item) => item.path);
  let contents;
  let relayMs = found.meta?.relayRoundTripMs || 0;
  if (kind === "legacy") {
    const read = await rpc("read_multiple_files", {
      paths: paths.map((file) => ({ path: file, offset: 0, length: previewLines, maxBytes: 4096 })),
      maxTotalBytes: 49152,
    });
    assert.equal(read.payload.files.length, paths.length);
    assert.equal(read.payload.nextIndex, null);
    contents = read.payload.files.map((file) => {
      assert.equal(file.ok, true); return file.content;
    });
    relayMs += read.meta?.relayRoundTripMs || 0;
  } else {
    contents = found.payload.results.map((item) => {
      assert.equal(typeof item.preview?.content, "string", "missing bounded preview");
      return item.preview.content;
    });
  }
  return { elapsedMs: tick() - start, relayMs, paths, contents };
}
function compare(reference, current) {
  assert.deepEqual(current.paths, reference.paths, "search path parity");
  assert.deepEqual(current.contents, reference.contents, "preview content parity");
}
try {
  await connect();
  const times = { legacy: [], combined: [] };
  const relayTimes = { legacy: [], combined: [] };
  let filesMatched = 0;
  for (let i = 0; i < warmups + samples; i++) {
    const order = i % 2 ? ["combined", "legacy"] : ["legacy", "combined"];
    const results = {};
    for (const kind of order) results[kind] = await runScenario(kind);
    compare(results.legacy, results.combined);
    filesMatched = results.legacy.paths.length;
    if (i >= warmups) {
      for (const kind of order) {
        times[kind].push(results[kind].elapsedMs);
        relayTimes[kind].push(results[kind].relayMs);
      }
    }
  }
  const legacy = stats(times.legacy);
  const combined = stats(times.combined);
  console.log(JSON.stringify({
    kind: "buddy-onboarding-search-preview-e2e",
    mode: "local-worker-mcp",
    target: "HTTP MCP -> Worker -> Durable Object -> WebSocket -> fixture agent",
    workload: { pattern, maxResults, filesMatched, previewLines },
    warmups, samples,
    cases: {
      legacy: { calls: 2, ...legacy, relay: stats(relayTimes.legacy) },
      combined: { calls: 1, ...combined, relay: stats(relayTimes.combined) },
    },
    callsReductionPct: 50,
    p50ImprovementPct: Number((100 * (1 - combined.p50Ms / legacy.p50Ms)).toFixed(2)),
    resultParity: true,
    excludes: ["ChatGPT model reasoning", "ChatGPT connector/host scheduling", "Cloudflare production CPU"],
  }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({
    kind: "buddy-onboarding-search-preview-e2e", ok: false,
    error: error instanceof Error ? error.message : "unknown",
  }));
} finally {
  if (agent && agent.exitCode === null) agent.kill("SIGTERM");
}
