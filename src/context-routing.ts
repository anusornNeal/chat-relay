import type { LearnRecord } from "./learning";

const SIGNAL_KEYS = new Set([
  "path",
  "cwd",
  "root",
  "rootPath",
  "repoPath",
  "repositoryPath",
  "workspacePath",
]);

const AGENT_ID = /^[a-z0-9_-]{1,64}$/;

export function normalizeRoutingPath(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) return null;
  let normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(normalized)) normalized = normalized.toLowerCase();
  return normalized;
}

export function extractRoutingSignals(args: unknown, maxSignals = 24): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number, key?: string) => {
    if (output.length >= maxSignals || depth > 4 || value == null) return;
    if (typeof value === "string") {
      if (!key || !SIGNAL_KEYS.has(key)) return;
      const normalized = normalizeRoutingPath(value);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        output.push(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1, key);
      return;
    }
    if (typeof value !== "object") return;
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SIGNAL_KEYS.has(entryKey) && typeof entryValue === "string") {
        visit(entryValue, depth + 1, entryKey);
      } else if (entryKey === "paths") {
        visit(entryValue, depth + 1, "path");
      } else if (entryKey === "operations" || entryKey === "jobs") {
        visit(entryValue, depth + 1);
      } else if (typeof entryValue === "object" && entryValue !== null && depth < 3) {
        visit(entryValue, depth + 1);
      }
    }
  };
  visit(args, 0);
  return output;
}

type ProjectRootHint = {
  projectKey: string;
  root: string;
};

export function projectRootHints(records: LearnRecord[]): ProjectRootHint[] {
  const hints: ProjectRootHint[] = [];
  for (const record of records) {
    if (record.scope !== "global" || record.kind !== "project_context") continue;
    const key = String(record.key || "");
    if (!key?.startsWith("project-root:")) continue;
    const projectKey = key.slice("project-root:".length).trim().slice(0, 200);
    const root = normalizeRoutingPath(record.content);
    if (!projectKey || !root) continue;
    hints.push({ projectKey, root });
  }
  return hints.sort((a, b) => b.root.length - a.root.length || a.projectKey.localeCompare(b.projectKey));
}

function pathWithin(signal: string, root: string) {
  return signal === root || signal.startsWith(root + "/");
}

export function projectKeyForSignals(signals: string[], records: LearnRecord[]): string | null {
  const hints = projectRootHints(records);
  let best: ProjectRootHint | null = null;
  for (const signal of signals) {
    const normalized = normalizeRoutingPath(signal);
    if (!normalized) continue;
    for (const hint of hints) {
      if (!pathWithin(normalized, hint.root)) continue;
      if (!best || hint.root.length > best.root.length) best = hint;
    }
  }
  return best?.projectKey ?? null;
}

function preferredAgentRecord(records: LearnRecord[], scope: "project" | "global", scopeKey?: string) {
  return records
    .filter((record) =>
      record.scope === scope &&
      (scope === "global" || record.scopeKey === scopeKey) &&
      (record.kind === "agent_context" || record.kind === "preference") &&
      String(record.key || "") === "preferred-agent"
    )
    .sort((a, b) =>
      b.confidence - a.confidence ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.id.localeCompare(b.id)
    )[0];
}

export function preferredAgentForContext(
  records: LearnRecord[],
  projectKey?: string | null,
): { agentId: string; source: "project" | "global" } | null {
  const project = projectKey ? preferredAgentRecord(records, "project", projectKey) : undefined;
  const global = preferredAgentRecord(records, "global");
  const selected = project ?? global;
  if (!selected) return null;
  const agentId = String(selected.content ?? "").trim().toLowerCase();
  if (!AGENT_ID.test(agentId)) return null;
  return { agentId, source: project ? "project" : "global" };
}

export function routingContext(
  args: unknown,
  records: LearnRecord[],
) {
  const signals = extractRoutingSignals(args);
  const projectKey = projectKeyForSignals(signals, records);
  const preferredAgent = preferredAgentForContext(records, projectKey);
  return { signals, projectKey, preferredAgent };
}
