import type { LearnRecord, LearnScope } from "./learning";

export type LearnScopeSelector = {
  scope: LearnScope;
  scopeKey?: string;
};

export type LearnedContextItem = Pick<
  LearnRecord,
  "id" | "key" | "kind" | "scope" | "scopeKey" | "content" | "confidence" | "updatedAt"
>;

export type LearnedContextEnvelope = {
  version: 1;
  authority: "advisory";
  instructionPolicy: "non-authoritative";
  activated: LearnScopeSelector[];
  items: LearnedContextItem[];
};

export type LearnLoader = (scopes: LearnScopeSelector[]) => Promise<LearnRecord[]>;

type SessionState = {
  touchedAt: number;
  loaded: Set<string>;
  inflight: Map<string, Promise<void>>;
  records: Map<string, LearnRecord>;
};

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 512;
const MAX_CACHED_RECORDS = 128;
const MAX_ENVELOPE_ITEMS = 16;
const MAX_ENVELOPE_CONTENT_CHARS = 12_000;
const MAX_ITEM_CONTENT_CHARS = 1_200;

function scopeKeyOf(selector: LearnScopeSelector) {
  return selector.scope === "global"
    ? "global"
    : selector.scope + ":" + String(selector.scopeKey ?? "").trim();
}

function normalizeSelector(selector: LearnScopeSelector): LearnScopeSelector | null {
  if (selector.scope === "global") return { scope: "global" };
  const scopeKey = String(selector.scopeKey ?? "").trim().slice(0, 200);
  if (!scopeKey) return null;
  return { scope: selector.scope, scopeKey };
}

function compactEnvelope(scopes: LearnScopeSelector[], records: LearnRecord[]): LearnedContextEnvelope | null {
  if (!scopes.length || !records.length) return null;
  const items: LearnedContextItem[] = [];
  let contentChars = 0;
  for (const record of records) {
    if (items.length >= MAX_ENVELOPE_ITEMS || contentChars >= MAX_ENVELOPE_CONTENT_CHARS) break;
    const remaining = MAX_ENVELOPE_CONTENT_CHARS - contentChars;
    const content = String(record.content ?? "").slice(0, Math.min(MAX_ITEM_CONTENT_CHARS, remaining));
    contentChars += content.length;
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
  return items.length ? { version: 1, authority: "advisory", instructionPolicy: "non-authoritative", activated: scopes, items } : null;
}

export function learnSessionKey(userId: string, activityId?: string, toolCallId?: string) {
  const identity = String(activityId || toolCallId || "request").slice(0, 160);
  return String(userId).slice(0, 128) + "|" + identity;
}

export class LearnContextSessionStore {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {}

  private prune(now = Date.now()) {
    for (const [key, state] of this.sessions) {
      if (now - state.touchedAt > this.ttlMs) this.sessions.delete(key);
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  private state(sessionKey: string) {
    this.prune();
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = {
        touchedAt: Date.now(),
        loaded: new Set(),
        inflight: new Map(),
        records: new Map(),
      };
      this.sessions.set(sessionKey, state);
      this.prune();
    } else {
      state.touchedAt = Date.now();
      this.sessions.delete(sessionKey);
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  records(sessionKey: string): LearnRecord[] {
    const state = this.sessions.get(sessionKey);
    if (!state) return [];
    state.touchedAt = Date.now();
    return [...state.records.values()];
  }

  hasScope(sessionKey: string, selector: LearnScopeSelector) {
    const normalized = normalizeSelector(selector);
    if (!normalized) return false;
    return this.sessions.get(sessionKey)?.loaded.has(scopeKeyOf(normalized)) ?? false;
  }

  async activate(
    sessionKey: string,
    selectors: LearnScopeSelector[],
    loader: LearnLoader,
  ): Promise<LearnedContextEnvelope | null> {
    const state = this.state(sessionKey);
    const normalized: LearnScopeSelector[] = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      const value = normalizeSelector(selector);
      if (!value) continue;
      const key = scopeKeyOf(value);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(value);
    }

    const owned: LearnScopeSelector[] = [];
    const waitFor: Promise<void>[] = [];
    for (const selector of normalized) {
      const key = scopeKeyOf(selector);
      if (state.loaded.has(key)) continue;
      const pending = state.inflight.get(key);
      if (pending) waitFor.push(pending);
      else owned.push(selector);
    }

    if (waitFor.length) await Promise.allSettled(waitFor);
    if (!owned.length) return null;

    let loadedItems: LearnRecord[] = [];
    const load = (async () => {
      loadedItems = await loader(owned);
      for (const record of loadedItems) {
        state.records.set(record.id, record);
        if (state.records.size > MAX_CACHED_RECORDS) {
          const oldest = state.records.keys().next().value;
          if (oldest !== undefined) state.records.delete(oldest);
        }
      }
      for (const selector of owned) state.loaded.add(scopeKeyOf(selector));
      state.touchedAt = Date.now();
    })();

    for (const selector of owned) state.inflight.set(scopeKeyOf(selector), load);
    try {
      await load;
    } finally {
      for (const selector of owned) {
        const key = scopeKeyOf(selector);
        if (state.inflight.get(key) === load) state.inflight.delete(key);
      }
    }

    return compactEnvelope(owned, loadedItems);
  }

  clear(sessionKey?: string) {
    if (sessionKey) this.sessions.delete(sessionKey);
    else this.sessions.clear();
  }

  snapshot() {
    return {
      sessions: this.sessions.size,
      loadedScopes: [...this.sessions.values()].reduce((sum, state) => sum + state.loaded.size, 0),
    };
  }
}
