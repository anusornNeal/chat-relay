import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import { LearnPreflightGuard, attachLearnPrepareAdvisory } from "../src/learn-preflight-guard.mjs";

const bundled = await build({
  stdin: {
    contents: [
      'export * from "./src/context-routing";',
      'export * from "./src/project-identity";',
      'export * from "./src/learning-relevance";',
      'export * from "./src/learning-policy";',
      'export * from "./src/learn-phase";',
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
  canonicalLearnProjectKey,
  extractRoutingSignals,
  projectKeyForSignals,
  preferredAgentForContext,
  routingContext,
  buildLearnRelevanceContext,
  selectRelevantLearnRecords,
  buildRelevantLearnEnvelope,
  resolveLearnPhase,
  LEARN_BASELINE_VERSION,
  LEARN_BASELINE_POLICY,
  LEARN_BASELINE_CONTEXT,
  LEARN_WRITING_FORMAT,
  LEARN_USAGE_REPORT_INSTRUCTION,
} = mod;

assert.equal(canonicalLearnProjectKey("flowly"), "flowly");
assert.equal(canonicalLearnProjectKey("C:/Users/tatar/Projects/Flowly"), "flowly");
assert.equal(canonicalLearnProjectKey("C:/Users/tatar/Projects/flowly".replaceAll("/", "\\")), "flowly");
assert.equal(canonicalLearnProjectKey("/Users/tatar/Projects/flowly"), "flowly");
assert.equal(canonicalLearnProjectKey("C:/Users/tatar/Projects/buddy/android"), "C:/Users/tatar/Projects/buddy/android");
assert.equal(canonicalLearnProjectKey("/opt/repos/flowly"), "/opt/repos/flowly");
assert.equal(canonicalLearnProjectKey(null), null);

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
  console.log("PASS bounded relevance ranking and compaction");

  {
    // One chat starts reading a card and later switches to coding.
    const scopes = [{ scope: "global" }, { scope: "project", scopeKey: "chat-relay" }];
    const phaseRecords = [
      memory("read-workflow", "ticket-reading", "workflow", "project", "chat-relay", "Read acceptance criteria"),
      memory("read-context", "project-summary", "project_context", "project", "chat-relay", "Project architecture"),
      memory("read-style", "concise-response", "response_style", "global", null, "Summarize clearly"),
      memory("code-global", "maintainable-coding", "coding_style", "global", null, "SOLID Clean Architecture ".repeat(300)),
    ];
    const readCtx = buildLearnRelevanceContext("terminal_exec", { phase: "read" }, "chat-relay", null, "อ่านการ์ดก่อน");
    const reading = buildRelevantLearnEnvelope(phaseRecords, scopes, readCtx, 8);
    assert.equal(readCtx.phase, "read");
    assert.ok(reading?.items.some((item) => item.kind === "workflow"));
    assert.ok(reading?.items.every((item) => item.kind !== "coding_style"));

    const loaded = new Set(reading.items.map((item) => item.id));
    const codingCtx = buildLearnRelevanceContext("learn_prepare", { phase: "implement" }, "chat-relay", null, "ลงมือ implement และแก้โค้ด");
    const coding = buildRelevantLearnEnvelope(phaseRecords.filter((record) => !loaded.has(record.id)), scopes, codingCtx, 1);
    assert.equal(codingCtx.phase, "implement");
    assert.equal(coding?.items[0].id, "code-global", "coding style must be reserved even at limit=1");
    assert.equal(coding?.items[0].content.length, 3600);
    for (const item of coding.items) loaded.add(item.id);
    assert.equal(buildRelevantLearnEnvelope(phaseRecords.filter((record) => !loaded.has(record.id)), scopes, codingCtx), null);

    assert.equal(resolveLearnPhase(undefined, "read Jira ticket"), "read");
    assert.equal(resolveLearnPhase(undefined, "Implement the feature"), "implement");
    assert.equal(resolveLearnPhase(undefined, "รีวิวโค้ดส่วนนี้"), "review");
    assert.equal(resolveLearnPhase(undefined, "อ่านโค้ดเดิม"), "review");
    assert.equal(resolveLearnPhase(undefined, "ทดสอบระบบ"), "test");
    assert.equal(resolveLearnPhase(undefined, "วางแผนงาน"), "plan");
    assert.equal(resolveLearnPhase("read", "Implement now"), "read");
    console.log("PASS lazy read -> implement -> repeat, Thai and English phases");
  }
}

{
  let now = 1_000;
  const guard = new LearnPreflightGuard({ ttlMs: 1_000, maxEntries: 2, now: () => now });

  assert.equal(guard.claimReminder("user-a", "activity-a"), true, "first ordinary call should claim one reminder");
  assert.equal(guard.claimReminder("user-a", "activity-a"), false, "same activity must not repeat the reminder");
  assert.equal(guard.claimReminder("user-b", "activity-a"), true, "guard state must remain account isolated");

  guard.markPrepared("user-a", "activity-b");
  assert.equal(guard.claimReminder("user-a", "activity-b"), false, "prepared activity must suppress reminders");

  const wrapped = attachLearnPrepareAdvisory({
    structuredContent: { ok: true },
    content: [{ type: "text", text: "{\"ok\":true}" }],
  });
  assert.equal(wrapped.attached, true);
  assert.match(wrapped.value.content.at(-1).text, /learn_prepare_recommended/);
  assert.equal(attachLearnPrepareAdvisory({ ok: true }).attached, false, "non-MCP results must not consume a reminder");

  now += 1_001;
  assert.equal(guard.claimReminder("user-a", "activity-a"), true, "expired activity state may remind again");
  guard.claimReminder("user-a", "activity-c");
  guard.claimReminder("user-a", "activity-d");
  assert.ok(guard.size() <= 2, "ephemeral guard state must remain bounded");
  console.log("PASS Relay-only Learn preflight reminder guard");
}

{
  const worker = fs.readFileSync("src/worker-app.ts", "utf8");
  const instrumentStart = worker.indexOf("async function instrumentTool");
  const instrumentEnd = worker.indexOf("function bearerToken", instrumentStart);
  assert.ok(instrumentStart >= 0 && instrumentEnd > instrumentStart);
  const instrumentBlock = worker.slice(instrumentStart, instrumentEnd);
  const guardSource = fs.readFileSync("src/learn-preflight-guard.mjs", "utf8");
  assert.doesNotMatch(guardSource, /learningCall|LEARNING|DurableObject|fetch\s*\(/, "preflight guard must stay Worker-local and must not touch Learn storage");

  assert.doesNotMatch(worker, /prepareAutoLearnContext/, "ordinary MCP calls must not auto-read Learn");
  assert.doesNotMatch(worker, /prepareAgentLearnContext/, "agent calls must not auto-read Learn");
  assert.doesNotMatch(worker, /attachLearnedContext/, "ordinary tool results must not receive implicit Learn payloads");
  assert.doesNotMatch(worker, /learnSessionId/, "MCP hot path must not hash a separate Learn session id");
  assert.doesNotMatch(instrumentBlock, /prepareLearnContext|buildLearnRelevanceContext/, "ordinary tools must not rank or inject Learn memories");
  assert.match(instrumentBlock, /"\/preflight-check"/, "cold gate must verify persistent state");
  assert.match(instrumentBlock, /"\/preflight-mark"/, "successful prepare must persist a checkpoint");
  assert.match(instrumentBlock, /learnPreflightGuard\.markPrepared\(user\.id, activityId\)/, "successful learn_prepare must mark the activity prepared");
  assert.match(instrumentBlock, /learnPreflightGuard\.claimReminder\(user\.id, activityId\)/, "ordinary tools must use the one-time reminder claim");
  assert.match(instrumentBlock, /!LEARN_ACTIVITY_TOOLS\.has/, "Learn tools must not recursively trigger the reminder");

  assert.match(worker, /"learn_prepare"/);
  assert.match(worker, /mode: args\.phase \|\| loadedIds\.size/);
  assert.match(worker, /"explicit-one-shot"/);
  assert.match(worker, /loadedMemoryIds: z\.array/);
  assert.match(worker, /remainingRecords = deduped\.filter/);
  assert.match(worker, /guidance: "Reuse all prior prepared context/);
  assert.match(worker, /usageReceiptId \? LEARN_USAGE_REPORT_INSTRUCTION/, "prepared receipts must carry the task-completion rule");
  assert.match(worker, /Do not repeat for the same phase or before every tool/);
  assert.match(worker, /readLearnPrepareScopes\(env, user, \[globalScope\]\)/);
  assert.match(worker, /preferredAgentForContext\(records, projectKey\)/, "explicit project keys must still use project-scoped preferred-agent routing");
  assert.match(worker, /buildLearnRelevanceContext\([\s\S]*args\.query/);
  assert.match(worker, /"learn_prepare", "learn_get"/, "learn_prepare and learn_get must be read-only tools");
  assert.match(worker, /only when Chat decides durable learning is warranted/);
  assert.match(worker, /Never write memory merely because an ordinary MCP tool ran/);
  assert.match(worker, /noteRecentLearnAgent\(user\.id, outcome\.agentId\)/);
  assert.match(worker, /automatically canonicalized\/compacted/);

  const policy = fs.readFileSync("src/learning-policy.ts", "utf8");
  assert.match(policy, /LEARN_BASELINE_VERSION = 9/);
  assert.match(policy, /call learn_prepare again/);
  assert.match(policy, /Ordinary Relay tools do not read or write Learn automatically/);
  assert.match(policy, /direct user correction or explicit enduring preference/);
  assert.match(policy, /do not wait for the user to explicitly say learn/);
  assert.match(policy, /use global for cross-project behavior, project for project-specific behavior/);
  assert.match(policy, /Do not learn one-off situational details/);
  assert.match(policy, /Keep project_context project-level and canonical/);
  assert.match(policy, /compacted into bounded canonical buckets/);
  assert.equal(LEARN_BASELINE_VERSION, 9);
  assert.equal(LEARN_BASELINE_POLICY.version, 9);
  assert.ok(LEARN_BASELINE_POLICY.rules.includes(LEARN_WRITING_FORMAT));
  assert.ok(LEARN_BASELINE_POLICY.rules.includes(LEARN_USAGE_REPORT_INSTRUCTION));
  assert.ok(LEARN_BASELINE_CONTEXT.includes(LEARN_USAGE_REPORT_INSTRUCTION));
  assert.doesNotMatch(LEARN_BASELINE_CONTEXT, /Call learn_prepare once/, "baseline must not tell chat to skip new phases");
  assert.match(LEARN_USAGE_REPORT_INSTRUCTION, /learn_usage_report exactly once/);
  assert.match(LEARN_USAGE_REPORT_INSTRUCTION, /Evaluates every prepared private memory/);
  assert.match(LEARN_USAGE_REPORT_INSTRUCTION, /If the receipt or reporting tool is unavailable/);
  assert.ok(LEARN_BASELINE_CONTEXT.includes(LEARN_WRITING_FORMAT), "tool descriptions must expose writing guidelines to all accounts");
  assert.match(LEARN_WRITING_FORMAT, /kebab-case key/);
  assert.match(LEARN_WRITING_FORMAT, /scannable Markdown/);
  assert.match(LEARN_WRITING_FORMAT, /machine-environment/);
  assert.match(LEARN_WRITING_FORMAT, /Preserve the existing.*source-key.*project_context/);
  assert.ok(LEARN_BASELINE_POLICY.rules.some((rule) => rule.includes("Verify learned paths")));
  assert.ok(LEARN_BASELINE_POLICY.rules.some((rule) => rule.includes("Never store tokens")));
  console.log("PASS lazy phase-aware Learn MCP architecture contract");
}

console.log("learning prepare/routing tests passed");


{
  const relevant = memory("thai-relevant", "image-gallery", "problem_solving", "project", "buddy2",
    "แก้ปัญหารูปภาพไม่แสดงในแกลเลอรีและซิงก์รูปภาพ", 90);
  const unrelated = memory("thai-unrelated", "connection-status", "problem_solving", "project", "buddy2",
    "ตรวจสอบสถานะการเชื่อมต่อเครือข่าย", 90);
  const ctx = buildLearnRelevanceContext("learn_prepare", {}, "buddy2", null, "รูปภาพไม่แสดง");
  const ranked = selectRelevantLearnRecords([unrelated, relevant], ctx, 2);
  assert.equal(ranked[0].id, "thai-relevant",
    "continuous Thai words should contribute to relevance ranking");
  console.log("PASS bounded Thai substring ranking");
}
