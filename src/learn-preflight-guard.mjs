const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1024;
export const LEARN_PREPARE_ADVISORY = Object.freeze({
  code: "learn_prepare_recommended",
  message: "Relay Learn is available even for a fresh account. If prior context matters, call learn_prepare once per task. If the user gives a durable correction or establishes a reusable preference or workflow, consider learn_put proactively without waiting to be asked. Skip one-off details; do not call Learn for every tool.",
});
function boundedPositiveInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}
export class LearnPreflightGuard {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = boundedPositiveInt(ttlMs, DEFAULT_TTL_MS, 1_000, 24 * 60 * 60 * 1000);
    this.maxEntries = boundedPositiveInt(maxEntries, DEFAULT_MAX_ENTRIES, 1, 8192);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.states = new Map();
  }
  key(userId, activityId) {
    const user = String(userId || "");
    const activity = String(activityId || "");
    if (!user || !activity) return "";
    return user + "\u0000" + activity;
  }
  prune(now = this.now()) {
    for (const [key, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(key);
    }
    while (this.states.size > this.maxEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
  touch(userId, activityId) {
    const key = this.key(userId, activityId);
    if (!key) return null;
    const now = this.now();
    this.prune(now);
    let state = this.states.get(key);
    if (!state) {
      state = { prepared: false, reminderSent: false, expiresAt: now + this.ttlMs };
    } else {
      state.expiresAt = now + this.ttlMs;
      this.states.delete(key);
    }
    this.states.set(key, state);
    this.prune(now);
    return state;
  }
  markPrepared(userId, activityId) {
    const state = this.touch(userId, activityId);
    if (!state) return false;
    state.prepared = true;
    return true;
  }
  claimReminder(userId, activityId) {
    const state = this.touch(userId, activityId);
    if (!state || state.prepared || state.reminderSent) return false;
    state.reminderSent = true;
    return true;
  }
  size() {
    this.prune();
    return this.states.size;
  }
}
export function attachLearnPrepareAdvisory(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.content)) {
    return { value, attached: false };
  }
  return {
    value: {
      ...value,
      content: [
        ...value.content,
        {
          type: "text",
          text: JSON.stringify({ relayAdvisory: LEARN_PREPARE_ADVISORY }),
        },
      ],
    },
    attached: true,
  };
}