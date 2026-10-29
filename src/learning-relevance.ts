import type { LearnKind, LearnRecord, LearnScope } from "./learning";
import { extractRoutingSignals } from "./context-routing";
import { usageRoutingAdjustment } from "./learn-usage";
import { resolveLearnPhase, isRequiredLearnKey, learnPhaseMask, type LearnPhase } from "./learn-phase";
import type { LearnIndexEntry } from "./learn-index-store";

export type LearnScopeSelector = {
  scope: LearnScope;
  scopeKey?: string;
};

export type LearnedContextItem = Pick<
  LearnRecord,
  "id" | "key" | "kind" | "scope" | "scopeKey" | "content" | "confidence" | "updatedAt" | "origin" | "groupId" | "approvedBy" | "validity"
>;

type PreparedLearnContent = LearnedContextItem & { contentTruncated?: boolean };

export type LearnedContextEnvelope = {
  version: 1;
  authority: "advisory";
  instructionPolicy: "non-authoritative";
  activated: LearnScopeSelector[];
  items: PreparedLearnContent[];
  conflicts?: Array<{ key: string; kind: string; groupId: string; personalId: string }>;
  coverage?: {
    status: "complete" | "incomplete" | "needs-review";
    requiredKeys: string[];
    missingKeys: string[];
    needsReviewKeys: string[];
    previouslyLoadedIds: string[];
    discovered: number;
    hydrated: number;
  };
};

const DEFAULT_TOP_K = 16;
const MAX_CONTENT_CHARS = 12_000;
const MAX_ITEM_CONTENT_CHARS = 1_200;
const MAX_CANONICAL_PROJECT_CONTEXT_CHARS = 2_400;
const MAX_CODING_STYLE_CONTENT_CHARS = 3_600;

const DEFAULT_KIND_PRIORITY: LearnKind[] = [
  "work_style",
  "workflow",
  "problem_solving",
  "preference",
  "response_style",
  "project_context",
  "tool_pattern",
  "coding_style",
  "agent_context",
  "correction",
];

const CODE_TOOL_HINTS = [
  "file", "read", "write", "edit", "patch", "terminal", "exec", "batch",
  "process", "git", "code", "test", "build",
];
const DESKTOP_TOOL_HINTS = ["desktop", "screen", "screenshot", "mouse", "keyboard", "click"];

function kindPriorityForTool(tool: string): LearnKind[] {
  const name = String(tool || "").toLowerCase();
  if (DESKTOP_TOOL_HINTS.some((hint) => name.includes(hint))) {
    return [
      "work_style",
      "tool_pattern",
      "problem_solving",
      "workflow",
      "agent_context",
      "preference",
      "response_style",
      "project_context",
      "coding_style",
      "correction",
    ];
  }
  if (CODE_TOOL_HINTS.some((hint) => name.includes(hint))) {
    return [
      "coding_style",
      "workflow",
      "problem_solving",
      "tool_pattern",
      "project_context",
      "work_style",
      "preference",
      "response_style",
      "agent_context",
      "correction",
    ];
  }
  return DEFAULT_KIND_PRIORITY;
}

function kindPriorityForPhase(phase: LearnPhase, tool: string): LearnKind[] {
  switch (phase) {
    case "read":
      return ["workflow", "project_context", "tool_pattern", "agent_context", "problem_solving",
        "preference", "work_style", "response_style", "correction", "coding_style"];
    case "plan":
      return ["workflow", "project_context", "coding_style", "problem_solving", "work_style",
        "correction", "tool_pattern", "agent_context", "preference", "response_style"];
    case "implement":
    case "review":
    case "test":
      return ["coding_style", "workflow", "problem_solving", "project_context", "correction",
        "tool_pattern", "agent_context", "work_style", "preference", "response_style"];
    default:
      return kindPriorityForTool(tool);
  }
}

function tokenize(value: unknown, maxTokens = 40): string[] {
  const raw = String(value ?? "").toLowerCase();
  const tokens = raw
    .replace(/[\\/_.:\-]+/g, " ")
    .replace(/[^a-z0-9\u0E00-\u0E7F ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 48);
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    // Thai words are not always separated by spaces. Bounded trigrams improve
    // matching without an external tokenizer or another Durable Object read.
    if (/[\u0e00-\u0e7f]/.test(token) && token.length >= 4) {
      for (let index = 0; index <= token.length - 3 && expanded.length < maxTokens * 3; index++) {
        expanded.push(token.slice(index, index + 3));
      }
    }
  }
  return [...new Set(expanded)].slice(0, maxTokens);
}

function contentTokenSet(record: LearnRecord) {
  return new Set(tokenize(record.content, 80));
}

function normalizedKey(record: LearnRecord) {
  return tokenize(record.key, 20).join("-");
}

function tokenOverlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let same = 0;
  for (const token of a) if (b.has(token)) same += 1;
  return same;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  const same = tokenOverlap(a, b);
  return same / (a.size + b.size - same);
}

export type LearnRelevanceContext = {
  phase: LearnPhase;
  tool: string;
  terms: string[];
  preferredKinds: LearnKind[];
  projectKey?: string | null;
  agentId?: string | null;
};

export function buildLearnRelevanceContext(
  tool: string,
  args: unknown,
  projectKey?: string | null,
  agentId?: string | null,
  query?: unknown,
): LearnRelevanceContext {
  const phase = resolveLearnPhase((args as { phase?: LearnPhase } | null)?.phase, query, tool);
  const terms = new Set<string>(tokenize(tool, 12));
  for (const token of tokenize(query, 40)) terms.add(token);
  for (const signal of extractRoutingSignals(args, 12)) {
    for (const token of tokenize(signal, 20)) terms.add(token);
  }
  if (projectKey) for (const token of tokenize(projectKey, 8)) terms.add(token);
  if (agentId) for (const token of tokenize(agentId, 8)) terms.add(token);
  return {
    tool,
    terms: [...terms].slice(0, 48),
    preferredKinds: kindPriorityForPhase(phase, tool),
    phase,
    projectKey: projectKey || null,
    agentId: agentId || null,
  };
}

function recordScore(record: LearnRecord, ctx: LearnRelevanceContext, nowMs: number) {
  let score = Math.max(0, Math.min(100, Number(record.confidence) || 0));
  if (record.origin === "shared") score += 55;
  // Usage supports relevance only after enough evaluated reports; new memories
  // keep equal access to retrieval and never start with a negative penalty.
  score += usageRoutingAdjustment(record.usage);
  score += Math.min(24, Math.max(-24, (record.positiveFeedback || 0) * 5 - (record.negativeFeedback || 0) * 7));

  if (record.scope === "agent") {
    score += record.scopeKey && ctx.agentId && record.scopeKey === ctx.agentId ? 34 : 10;
  } else if (record.scope === "project") {
    score += record.scopeKey && ctx.projectKey && record.scopeKey === ctx.projectKey ? 28 : 8;
  } else {
    score += 6;
  }

  const kindIndex = ctx.preferredKinds.indexOf(record.kind);
  if (kindIndex >= 0) score += Math.max(4, 40 - kindIndex * 4);

  const query = new Set(ctx.terms);
  const keyTokens = new Set(tokenize(record.key, 24));
  const contentTokens = contentTokenSet(record);
  score += Math.min(36, tokenOverlap(query, keyTokens) * 12);
  score += Math.min(16, tokenOverlap(query, contentTokens) * 4);

  const updatedMs = Date.parse(record.updatedAt);
  if (Number.isFinite(updatedMs)) {
    const ageDays = Math.max(0, (nowMs - updatedMs) / 86_400_000);
    score += Math.max(0, 10 - Math.min(10, ageDays / 14));
  }

  return score;
}

type RankedRecord = { record: LearnRecord; score: number; contentTokens: Set<string> };

function scopeCap(scope: LearnRecord["scope"]) {
  if (scope === "agent") return 4;
  if (scope === "project") return 8;
  return 6;
}

export function selectRelevantLearnRecords(
  records: LearnRecord[],
  ctx: LearnRelevanceContext,
  limit = DEFAULT_TOP_K,
): LearnRecord[] {
  const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit) || DEFAULT_TOP_K));
  // Capture time once so identical timestamps have stable ordering.
  const nowMs = Date.now();
  const ranked: RankedRecord[] = records
    // Card reading does not pre-load coding rules that become relevant in implementation.
    .filter((record) => ctx.phase !== "read" || record.kind !== "coding_style")
    .map((record) => ({ record, score: recordScore(record, ctx, nowMs), contentTokens: contentTokenSet(record) }))
    .sort((a, b) =>
      b.score - a.score ||
      b.record.confidence - a.record.confidence ||
      b.record.updatedAt.localeCompare(a.record.updatedAt) ||
      a.record.id.localeCompare(b.record.id)
    );

  const selected: RankedRecord[] = [];
  const selectedByScope = new Map<LearnRecord["scope"], number>();
  const canonical = new Set<string>();

  const canAdd = (candidate: RankedRecord, enforceScopeCap: boolean) => {
    const key = candidate.record.kind + "|" + normalizedKey(candidate.record);
    if (key !== candidate.record.kind + "|" && canonical.has(key)) return false;

    for (const existing of selected) {
      if (existing.record.kind !== candidate.record.kind) continue;
      if (jaccard(existing.contentTokens, candidate.contentTokens) >= 0.88) return false;
    }

    if (enforceScopeCap) {
      const used = selectedByScope.get(candidate.record.scope) || 0;
      if (used >= scopeCap(candidate.record.scope)) return false;
    }
    return true;
  };

  const add = (candidate: RankedRecord) => {
    selected.push(candidate);
    selectedByScope.set(candidate.record.scope, (selectedByScope.get(candidate.record.scope) || 0) + 1);
    const key = candidate.record.kind + "|" + normalizedKey(candidate.record);
    if (key !== candidate.record.kind + "|") canonical.add(key);
  };

  // Mandatory/core rules always outrank confidence, scope caps and deduplication.
  // If the count exceeds the caller limit, the envelope reports missing coverage.
  for (const candidate of ranked) {
    if (selected.length >= boundedLimit) break;
    if (isRequiredLearnKey(candidate.record.key)) add(candidate);
  }

  // Reserve a slot for coding standards when the same chat moves into code work.
  if (ctx.phase === "implement" || ctx.phase === "review" || ctx.phase === "test") {
    const codingStandard = ranked.find((candidate) => candidate.record.kind === "coding_style");
    if (selected.length < boundedLimit && codingStandard && canAdd(codingStandard, true)) add(codingStandard);
  }

  for (const candidate of ranked) {
    if (selected.length >= boundedLimit) break;
    if (selected.some((item) => item.record.id === candidate.record.id)) continue;
    if (canAdd(candidate, true)) add(candidate);
  }
  for (const candidate of ranked) {
    if (selected.length >= boundedLimit) break;
    if (selected.some((item) => item.record.id === candidate.record.id)) continue;
    if (canAdd(candidate, false)) add(candidate);
  }

  return selected.map((item) => item.record);
}

export function buildRelevantLearnEnvelope(
  records: LearnRecord[],
  activated: LearnScopeSelector[],
  ctx: LearnRelevanceContext,
  limit = DEFAULT_TOP_K,
): LearnedContextEnvelope | null {
  const ranked = selectRelevantLearnRecords(records, ctx, limit);
  if (!ranked.length) return null;

  const items: PreparedLearnContent[] = [];
  let chars = 0;
  const contentBudget = ["implement", "review", "test"].includes(ctx.phase) ? 16_000 : MAX_CONTENT_CHARS;
  for (const record of ranked) {
    if (chars >= contentBudget) break;
    if (record.validity?.status === "deprecated") continue;
    const itemLimit = isRequiredLearnKey(record.key) ? 4_000 : record.kind === "project_context" && record.key.startsWith("project-context:")
      ? MAX_CANONICAL_PROJECT_CONTEXT_CHARS
      : record.kind === "coding_style" && ["implement", "review", "test"].includes(ctx.phase)
        ? MAX_CODING_STYLE_CONTENT_CHARS
        : MAX_ITEM_CONTENT_CHARS;
    const fullContent = String(record.content || "");
    const content = fullContent.slice(0, Math.min(itemLimit, contentBudget - chars));
    // Mandatory content is all-or-missing: never silently truncate a required rule.
    if (isRequiredLearnKey(record.key) && content.length !== fullContent.length) continue;
    if (!content) continue;
    chars += content.length;
    items.push({
      id: record.id,
      key: record.key,
      kind: record.kind,
      scope: record.scope,
      scopeKey: record.scopeKey,
      content,
      confidence: record.confidence,
      updatedAt: record.updatedAt,
      ...(record.validity ? { validity: record.validity } : {}),
      ...(content.length < fullContent.length ? { contentTruncated: true } : {}),
      ...(record.origin === "shared" ? { origin: "shared" as const, groupId: record.groupId, approvedBy: record.approvedBy } : {}),
    });
  }

  return items.length
    ? {
        version: 1,
        authority: "advisory",
        instructionPolicy: "non-authoritative",
        activated,
        items,
        conflicts: items.filter(item => item.origin === "shared").flatMap(shared =>
          records.filter(personal => !personal.origin && personal.kind === shared.kind &&
            personal.key === shared.key && personal.content !== shared.content)
            .slice(0, 1).map(personal => ({
              key: shared.key, kind: shared.kind, groupId: shared.groupId || "", personalId: personal.id,
            }))
        ).slice(0, 8),
      }
    : null;
}


/**
 * Explicit coverage contract. A ranking miss or content-budget cap is observable,
 * never interpreted as a content-quality failure and never silently accepted.
 */
export function withRequiredLearnCoverage(
  envelope: LearnedContextEnvelope | null,
  indexEntries: LearnIndexEntry[],
  availableRecords: LearnRecord[],
  activated: LearnScopeSelector[],
  ctx: LearnRelevanceContext,
  loadedMemoryIds: string[] = [],
  expectedKeys: string[] = [],
): LearnedContextEnvelope {
  const base: LearnedContextEnvelope = envelope ?? {
    version: 1,
    authority: "advisory",
    instructionPolicy: "non-authoritative",
    activated,
    items: [],
  };
  const loaded = new Set(loadedMemoryIds);
  const delivered = new Set(base.items.map(item => item.id));
  const requiredKeys = new Set<string>(expectedKeys);
  const missingKeys = new Set<string>();
  const needsReviewKeys = new Set<string>();
  const previouslyLoadedIds: string[] = [];

  for (const entry of indexEntries) {
    if (!entry.required_rule || !(entry.phase_mask & learnPhaseMask(ctx.phase))) continue;
    requiredKeys.add(entry.memory_key);
    if (entry.validity_status === "deprecated") {
      missingKeys.add(entry.memory_key);
      continue;
    }
    if (entry.validity_status === "needs-review") needsReviewKeys.add(entry.memory_key);
    if (loaded.has(entry.id)) previouslyLoadedIds.push(entry.id);
    else if (!delivered.has(entry.id)) missingKeys.add(entry.memory_key);
  }

  // Shared approved rules originate from the group service rather than the private index.
  for (const record of availableRecords) {
    if (!isRequiredLearnKey(record.key)) continue;
    requiredKeys.add(record.key);
    if (record.validity?.status === "needs-review") needsReviewKeys.add(record.key);
    if (record.validity?.status === "deprecated") missingKeys.add(record.key);
    else if (!delivered.has(record.id) && !loaded.has(record.id)) missingKeys.add(record.key);
  }

  for (const key of expectedKeys) {
    const exists = indexEntries.some(entry => entry.memory_key === key &&
      entry.validity_status !== "deprecated") ||
      availableRecords.some(record => record.key === key && record.validity?.status !== "deprecated");
    if (!exists) missingKeys.add(key);
  }

  if (["implement", "review", "test"].includes(ctx.phase)) {
    const codingIds = indexEntries.filter(entry => entry.kind === "coding_style" &&
      entry.validity_status !== "deprecated").map(entry => entry.id);
    const sharedCoding = availableRecords.filter(record => record.kind === "coding_style");
    if (codingIds.length || sharedCoding.length) {
      requiredKeys.add("coding_style");
      if (!base.items.some(item => item.kind === "coding_style") &&
          !codingIds.some(id => loaded.has(id)) &&
          !sharedCoding.some(record => loaded.has(record.id))) {
        missingKeys.add("coding_style");
      }
    }
  }

  for (const item of base.items) {
    if (item.validity?.status === "needs-review") needsReviewKeys.add(item.key);
    if (item.validity?.status === "deprecated") missingKeys.add(item.key);
  }

  base.coverage = {
    status: missingKeys.size ? "incomplete" : needsReviewKeys.size ? "needs-review" : "complete",
    requiredKeys: [...requiredKeys].sort(),
    missingKeys: [...missingKeys].sort(),
    needsReviewKeys: [...needsReviewKeys].sort(),
    previouslyLoadedIds,
    discovered: indexEntries.length,
    hydrated: availableRecords.length,
  };
  return base;
}
