import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";

const bundled = await build({
  stdin: {
    contents: [
      'export * from "./src/context-routing";',
      'export * from "./src/learning-relevance";',
    ].join("\n"),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  plugins: [{
    name: "host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }",
      }));
    },
  }],
});

const mod = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const {
  extractRoutingSignals,
  projectKeyForSignals,
  preferredAgentForContext,
  routingContext,
  buildLearnRelevanceContext,
  selectRelevantLearnRecords,
  buildRelevantLearnEnvelope,
} = mod;

const now = new Date().toISOString();
const memory = (id, key, kind, scope, scopeKey, content, confidence = 100) => ({
  id, key, kind, scope, scopeKey, content, confidence,
  positiveFeedback: 0, negativeFeedback: 0, createdAt: now, updatedAt: now,
});

const globalRecords = [
  memory("mem-root-relay", "project-root:chat-relay", "project_context", "global", null, "C:\\Users\\tatar\\Projects\\chat-relay"),
  memory("mem-root-buddy", "project-root:buddy2", "project_context", "global", null, "C:\\Users\\tatar\\Projects\\buddy-android"),
  memory("mem-agent-global", "preferred-agent", "agent_context", "global", null, "desktop-global"),
];
const projectRecords = [
  memory("mem-agent-project", "preferred-agent", "agent_context", "project", "chat-relay", "desktop-project"),
];
const agentRecords = [
  memory("mem-machine", "machine", "agent_context", "agent", "desktop-project", "Windows primary"),
];

{
  const signals = extractRoutingSignals({
    path: "C:\\Users\\tatar\\Projects\\chat-relay\\src\\worker-app.ts",
    operations: [{ path: "C:\\Users\\tatar\\Projects\\chat-relay\\README.md" }],
    paths: ["C:\\Users\\tatar\\Projects\\chat-relay\\package.json"],
    content: "C:\\should-not-be-treated-as-path",
  });
  assert.equal(signals.length, 3);
  assert.equal(projectKeyForSignals(signals, globalRecords), "chat-relay");
  assert.equal(projectKeyForSignals(["C:/elsewhere/repo"], globalRecords), null);
  assert.equal(preferredAgentForContext([...globalRecords, ...projectRecords], "chat-relay")?.agentId, "desktop-project");
  assert.equal(preferredAgentForContext(globalRecords, "unknown")?.agentId, "desktop-global");
  const ctx = routingContext({ cwd: "C:\\Users\\tatar\\Projects\\chat-relay" }, [...globalRecords, ...projectRecords]);
  assert.equal(ctx.projectKey, "chat-relay");
  assert.equal(ctx.preferredAgent.agentId, "desktop-project");
  console.log("PASS deterministic project and preferred-agent routing");
}

{
  const relevanceRecords = [
    memory("global-response", "response-style", "response_style", "global", null, "Prefer concise high-level answers first", 100),
    memory("global-workflow", "review-flow", "workflow", "global", null, "Implement test review fix", 95),
    memory("project-workflow", "review-flow", "workflow", "project", "chat-relay", "Implement test review fix", 100),
    memory("project-code-a", "small-patches", "coding_style", "project", "chat-relay", "Prefer small focused code patches with tests", 99),
    memory("project-code-b", "focused-patches", "coding_style", "project", "chat-relay", "Prefer small focused code patches with tests", 90),
    memory("agent-tool", "terminal-batch", "tool_pattern", "agent", "desktop-project", "Batch independent terminal reads when practical", 98),
    memory("query-hit", "cpu-regression", "problem_solving", "project", "chat-relay", "Investigate CPU regression before changing infrastructure", 92),
    ...Array.from({ length: 24 }, (_, index) =>
      memory("noise-"+index, "noise-"+index, "project_context", "project", "chat-relay", "Unrelated context "+index, 70-index)
    ),
  ];
  const ctx = buildLearnRelevanceContext(
    "terminal_batch_start",
    { cwd: "C:\\Users\\tatar\\Projects\\chat-relay", jobs: [{ command: "test" }] },
    "chat-relay",
    "desktop-project",
    "fix CPU regression and review Learn architecture",
  );
  const selected = selectRelevantLearnRecords(relevanceRecords, ctx, 16);
  assert.ok(selected.some((item) => item.id === "project-code-a"), "coding style should rank for terminal/code work");
  assert.ok(selected.some((item) => item.id === "global-response"), "global response style should remain represented");
  assert.ok(selected.some((item) => item.id === "project-workflow"), "project override should be selected");
  assert.ok(selected.some((item) => item.id === "query-hit"), "explicit task query must influence relevance");
  assert.ok(!selected.some((item) => item.id === "global-workflow"), "same kind/key global duplicate should be compacted");
  assert.ok(!selected.some((item) => item.id === "project-code-b"), "near-identical content should be compacted");
  const envelope = buildRelevantLearnEnvelope(
    relevanceRecords,
    [{ scope: "global" }, { scope: "project", scopeKey: "chat-relay" }, { scope: "agent", scopeKey: "desktop-project" }],
    ctx,
  );
  assert.ok(envelope?.items.length <= 16);
  assert.ok(envelope?.items.some((item) => item.scope === "agent"));
  assert.equal(envelope?.authority, "advisory");
  assert.equal(envelope?.instructionPolicy, "non-authoritative");
  const longCanonical = memory("canonical-project", "project-context:architecture", "project_context", "project", "chat-relay", "x".repeat(2200), 100);
  const canonicalEnvelope = buildRelevantLearnEnvelope([longCanonical], [{ scope: "project", scopeKey: "chat-relay" }], ctx);
  assert.equal(canonicalEnvelope?.items[0].content.length, 2200);
  console.log("PASS explicit one-shot relevance ranking and compaction");
}

{
  const worker = fs.readFileSync("src/worker-app.ts", "utf8");
  const instrumentStart = worker.indexOf("async function instrumentTool");
  const instrumentEnd = worker.indexOf("function bearerToken", instrumentStart);
  assert.ok(instrumentStart >= 0 && instrumentEnd > instrumentStart);
  const instrumentBlock = worker.slice(instrumentStart, instrumentEnd);

  assert.doesNotMatch(worker, /prepareAutoLearnContext/, "ordinary MCP calls must not auto-read Learn");
  assert.doesNotMatch(worker, /prepareAgentLearnContext/, "agent calls must not auto-read Learn");
  assert.doesNotMatch(worker, /attachLearnedContext/, "ordinary tool results must not receive implicit Learn payloads");
  assert.doesNotMatch(worker, /learnSessionId/, "MCP hot path must not hash a separate Learn session id");
  assert.doesNotMatch(instrumentBlock, /learningCall|prepareLearnContext|buildLearnRelevanceContext/, "instrumentTool must remain free of Learn reads/ranking");

  assert.match(worker, /"learn_prepare"/);
  assert.match(worker, /mode: "explicit-one-shot"/);
  assert.match(worker, /Reuse this prepared context for the current task/);
  assert.match(worker, /Do not call learn_prepare before every tool/);
  assert.match(worker, /readLearnPrepareScopes\(env, user, \[globalScope\]\)/);
  assert.match(worker, /preferredAgentForContext\(records, projectKey\)/, "explicit project keys must still use project-scoped preferred-agent routing");
  assert.match(worker, /buildLearnRelevanceContext\([\s\S]*args\.query/);
  assert.match(worker, /"learn_prepare", "learn_get"/, "learn_prepare and learn_get must be read-only tools");
  assert.match(worker, /only when Chat decides durable learning is warranted/);
  assert.match(worker, /Never write memory merely because an ordinary MCP tool ran/);
  assert.match(worker, /noteRecentLearnAgent\(user\.id, outcome\.agentId\)/);
  assert.match(worker, /automatically canonicalized\/compacted/);

  const policy = fs.readFileSync("src/learning-policy.ts", "utf8");
  assert.match(policy, /LEARN_BASELINE_VERSION = 3/);
  assert.match(policy, /Call learn_prepare once/);
  assert.match(policy, /Ordinary Relay tools do not read or write Learn automatically/);
  assert.match(policy, /Keep project_context project-level and canonical/);
  assert.match(policy, /compacted into bounded canonical buckets/);
  console.log("PASS explicit Learn MCP architecture contract");
}

console.log("learning prepare/routing tests passed");
