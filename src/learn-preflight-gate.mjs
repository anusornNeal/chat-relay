// CPU-cheap Learn preflight helpers. Only explicit conversation IDs qualify for a hard gate.
// MCP transport session IDs are not conversation IDs and must never be used to force Learn.
export const PREFLIGHT_TTL_MS = 4 * 60 * 60 * 1000;
export const PREFLIGHT_SCOPE_GLOBAL = "global";
const MAX_CACHE = 1024;
const MAX_BLOCKS = 2;
const FALLBACK_MS = 5 * 60 * 1000;
const EXEMPT_TOOLS = new Set([
  "whoami", "list_agents", "learn_prepare", "learn_get", "learn_put",
  "learn_delete", "learn_feedback",
]);

export function preflightIdentity(meta, headers) {
  const fromMeta = meta && typeof meta === "object" ? meta["openai/session"] : null;
  if (typeof fromMeta === "string" && fromMeta.length > 0 && fromMeta.length <= 512) {
    return { source: "openai/session:" + fromMeta, reliable: true };
  }
  for (const key of ["x-openai-conversation-id", "x-chatgpt-conversation-id", "x-openai-chat-id"]) {
    const value = headers?.get(key)?.trim();
    if (value && value.length <= 512) return { source: key + ":" + value, reliable: true };
  }
  const session = headers?.get("mcp-session-id")?.trim();
  return session && session.length <= 512
    ? { source: "mcp-session-id:" + session, reliable: false }
    : { source: undefined, reliable: false };
}

// Prefer explicit project keys. Conservative fallback: a direct Projects workspace
// folder is a stable hint. Caller should provide cwd/path to learn_prepare when routed.
export function preflightScope(args) {
  if (!args || typeof args !== "object") return PREFLIGHT_SCOPE_GLOBAL;
  const key = typeof args.projectKey === "string" ? args.projectKey.trim() : "";
  if (key && key.length <= 200) return "project:" + key.toLowerCase();
  for (const property of ["cwd", "root", "rootPath", "repoPath", "workspacePath", "path"]) {
    const value = args[property];
    if (typeof value !== "string" || value.length > 2048) continue;
    const normalized = value.replace(/\\/g, "/");
    const match = normalized.match(/(?:^|\/)projects\/([^/]+)(?:\/|$)/i);
    if (match && match[1] && match[1] !== "." && match[1] !== "..") {
      return "project:" + match[1].toLowerCase();
    }
  }
  return PREFLIGHT_SCOPE_GLOBAL;
}

export function preflightPreparationScopes(args, resolvedProjectKey) {
  const scopes = new Set([PREFLIGHT_SCOPE_GLOBAL]);
  if (resolvedProjectKey) scopes.add(preflightScope({ projectKey: resolvedProjectKey }));
  const workspace = preflightScope({ cwd: args?.cwd, path: args?.path });
  if (workspace !== PREFLIGHT_SCOPE_GLOBAL) scopes.add(workspace);
  return [...scopes];
}
export function isPreflightExempt(tool) { return EXEMPT_TOOLS.has(tool); }
export function preflightRequired(tool, scope) {
  return {
    error: "learn_prepare_required",
    code: "LEARN_PREPARE_REQUIRED",
    tool,
    scope,
    retryable: true,
    instruction: "Call learn_prepare once with the task query and relevant projectKey plus cwd/path, then retry this tool. Do not repeat learn_prepare before every tool.",
  };
}

// Per-isolate LRU hot cache. A cold cache checks durable state once per scope;
// warm calls do not perform any storage reads, writes, hashing, or ranking.
export class LearnGateCache {
  constructor({ ttlMs = PREFLIGHT_TTL_MS, now = () => Date.now(), maxEntries = MAX_CACHE } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.maxEntries = maxEntries;
    this.states = new Map();
  }
  key(userId, activityId, scope) { return userId + "\u0000" + activityId + "\u0000" + scope; }
  get(userId, activityId, scope) {
    const key = this.key(userId, activityId, scope);
    const item = this.states.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.now()) { this.states.delete(key); return null; }
    this.states.delete(key);
    this.states.set(key, item);
    return item;
  }
  put(userId, activityId, scope, patch, ttlMs = this.ttlMs) {
    const key = this.key(userId, activityId, scope);
    const item = { ...this.get(userId, activityId, scope), ...patch, expiresAt: this.now() + ttlMs };
    this.states.delete(key);
    this.states.set(key, item);
    while (this.states.size > this.maxEntries) this.states.delete(this.states.keys().next().value);
    return item;
  }
  markPrepared(userId, activityId, scopes) {
    for (const scope of scopes) this.put(userId, activityId, scope, { prepared: true, blocks: 0 });
  }
  blockedOrFallback(userId, activityId, scope) {
    const previous = this.get(userId, activityId, scope);
    if (previous?.prepared || previous?.bypass) return false;
    const blocks = (previous?.blocks || 0) + 1;
    if (blocks > MAX_BLOCKS) {
      this.put(userId, activityId, scope, { bypass: true, blocks }, FALLBACK_MS);
      return false;
    }
    this.put(userId, activityId, scope, { blocks }, FALLBACK_MS);
    return true;
  }
  bypass(userId, activityId, scope) {
    this.put(userId, activityId, scope, { bypass: true }, FALLBACK_MS);
  }
}
