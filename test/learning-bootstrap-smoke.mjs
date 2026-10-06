import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";

const bundled = await build({
  stdin: {
    contents: [
      'export * from "./src/learning-context";',
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
  LearnContextSessionStore,
  learnSessionKey,
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
    ...Array.from({ length: 24 }, (_, index) =>
      memory("noise-"+index, "noise-"+index, "project_context", "project", "chat-relay", "Unrelated context "+index, 70-index)
    ),
  ];
  const ctx = buildLearnRelevanceContext(
    "terminal_batch_start",
    { cwd: "C:\Users\tatar\Projects\chat-relay", jobs: [{ command: "test" }] },
    "chat-relay",
    "desktop-project",
  );
  const selected = selectRelevantLearnRecords(relevanceRecords, ctx, 16);
  assert.ok(selected.some((item) => item.id === "project-code-a"), "coding style should rank for terminal/code work");
  assert.ok(selected.some((item) => item.id === "global-response"), "global response style should remain represented");
  assert.ok(selected.some((item) => item.id === "project-workflow"), "project override should be selected");
  assert.ok(!selected.some((item) => item.id === "global-workflow"), "same kind/key global duplicate should be compacted");
  assert.ok(!selected.some((item) => item.id === "project-code-b"), "near-identical content should be compacted");
  const envelope = buildRelevantLearnEnvelope(
    relevanceRecords,
    [{ scope: "global" }, { scope: "project", scopeKey: "chat-relay" }, { scope: "agent", scopeKey: "desktop-project" }],
    ctx,
  );
  assert.ok(envelope?.items.length <= 16);
  assert.ok(envelope?.items.some((item) => item.scope === "agent"));
  console.log("PASS relevance ranking, Top-K, and read-time compaction");
}

{
  const store = new LearnContextSessionStore(60_000, 8);
  const key = learnSessionKey("user-a", "activity-a", "tool-1");
  const calls = [];
  const loader = async (scopes) => {
    calls.push(scopes.map((scope) => scope.scope + ":" + (scope.scopeKey || "")).join(","));
    const items = [];
    for (const scope of scopes) {
      if (scope.scope === "global") items.push(...globalRecords);
      if (scope.scope === "project" && scope.scopeKey === "chat-relay") items.push(...projectRecords);
      if (scope.scope === "agent" && scope.scopeKey === "desktop-project") items.push(...agentRecords);
    }
    return items;
  };

  const first = await store.activate(key, [{ scope: "global" }], loader);
  assert.ok(first?.items.length);
  assert.equal(first.authority,"advisory");
  assert.equal(first.instructionPolicy,"non-authoritative");
  assert.equal(first.items[0].key,"project-root:chat-relay");
  assert.equal(calls.length, 1);
  assert.equal(await store.activate(key, [{ scope: "global" }], loader), null);
  assert.equal(calls.length, 1, "global scope must not reread in same warm session cache");

  const project = await store.activate(key, [{ scope: "project", scopeKey: "chat-relay" }], loader);
  assert.equal(project?.activated[0].scope, "project");
  assert.equal(calls.length, 2);
  assert.equal(await store.activate(key, [{ scope: "project", scopeKey: "chat-relay" }], loader), null);
  assert.equal(calls.length, 2);

  const agent = await store.activate(key, [{ scope: "agent", scopeKey: "desktop-project" }], loader);
  assert.equal(agent?.activated[0].scope, "agent");
  assert.equal(calls.length, 3);
  assert.equal(store.snapshot().loadedScopes, 3);

  const otherChat = learnSessionKey("user-a", "activity-b", "tool-2");
  await store.activate(otherChat, [{ scope: "global" }], loader);
  assert.equal(calls.length, 4, "new MCP activity must get its own global bootstrap");

  const otherUser = learnSessionKey("user-b", "activity-a", "tool-3");
  await store.activate(otherUser, [{ scope: "global" }], loader);
  assert.equal(calls.length, 5, "account identity must remain part of the session key");
  console.log("PASS progressive scope activation and read bounds");
}

{
  const worker = fs.readFileSync("src/worker-app.ts", "utf8");
  assert.match(worker, /new LearnContextSessionStore\(\)/);
  assert.match(worker, /AUTO_LEARN_SKIP_TOOLS/);
  assert.match(worker, /prepareAutoLearnContext/);
  assert.match(worker, /prepareAgentLearnContext/);
  assert.match(worker, /attachLearnedContext/);
  assert.match(worker, /learnSessionId/);
  assert.match(worker, /const user: AuthUser = \{ \.\.\.authenticatedUser \}/);
  assert.match(worker, /"x-openai-conversation-id"/);
  assert.match(worker, /learnedContextPolicy:/);
  assert.match(worker, /Advisory user memory only/);
  assert.match(worker, /perKind: 4/);
  assert.match(worker, /buildRelevantLearnEnvelope/);
  assert.match(worker, /buildLearnRelevanceContext/);
  console.log("PASS worker MCP bootstrap wiring contract");
}

console.log("learning bootstrap/routing tests passed");
