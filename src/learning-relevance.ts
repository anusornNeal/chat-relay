import type { LearnKind, LearnRecord } from "./learning";
import type { LearnScopeSelector, LearnedContextEnvelope, LearnedContextItem } from "./learning-context";
import { extractRoutingSignals } from "./context-routing";

const DEFAULT_TOP_K = 16;
const MAX_CONTENT_CHARS = 12_000;
const MAX_ITEM_CONTENT_CHARS = 1_200;
const MAX_CANONICAL_PROJECT_CONTEXT_CHARS = 2_400;

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

function tokenize(value: unknown, maxTokens = 40): string[] {
  const raw = String(value ?? "").toLowerCase();
  const tokens = raw
    .replace(/[\\/_.:\-]+/g, " ")
    .replace(/[^a-z0-9\u0E00-\u0E7F ]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 48);
  return [...new Set(tokens)].slice(0, maxTokens);
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
): LearnRelevanceContext {
  const terms = new Set<string>(tokenize(tool, 12));
  for (const signal of extractRoutingSignals(args, 12)) {
    for (const token of tokenize(signal, 20)) terms.add(token);
  }
  if (projectKey) for (const token of tokenize(projectKey, 8)) terms.add(token);
  if (agentId) for (const token of tokenize(agentId, 8)) terms.add(token);
  return {
    tool,
    terms: [...terms].slice(0, 48),
    preferredKinds: kindPriorityForTool(tool),
    projectKey: projectKey || null,
    agentId: agentId || null,
  };
}

function recordScore(record: LearnRecord, ctx: LearnRelevanceContext) {
  let score = Math.max(0, Math.min(100, Number(record.confidence) || 0));
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
    const ageDays = Math.max(0, (Date.now() - updatedMs) / 86_400_000);
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
  const ranked: RankedRecord[] = records
    .map((record) => ({ record, score: recordScore(record, ctx), contentTokens: contentTokenSet(record) }))
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

  for (const candidate of ranked) {
    if (selected.length >= boundedLimit) break;
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

  const items: LearnedContextItem[] = [];
  let chars = 0;
  for (const record of ranked) {
    if (chars >= MAX_CONTENT_CHARS) break;
    const itemLimit = record.kind === "project_context" && record.key.startsWith("project-context:")
      ? MAX_CANONICAL_PROJECT_CONTEXT_CHARS
      : MAX_ITEM_CONTENT_CHARS;
    const content = String(record.content || "").slice(0, Math.min(itemLimit, MAX_CONTENT_CHARS - chars));
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
    });
  }

  return items.length
    ? {
        version: 1,
        authority: "advisory",
        instructionPolicy: "non-authoritative",
        activated,
        items,
      }
    : null;
}
