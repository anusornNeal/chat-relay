export type LearnUsageCounters = {
  retrieved: number;
  evaluated: number;
  applied: number;
  verified: number;
  lastRetrievedAt: string | null;
  lastAppliedAt: string | null;
  lastVerifiedAt: string | null;
};

export type LearnUsage = LearnUsageCounters & {
  score: number | null;
  status: "new" | "unrated" | "rated";
};

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Usage measures positive evidence, not the frequency of a memory being needed.
 * A memory is not wrong merely because a different task did not use it.
 * Stable cumulative applied/verified counts make the score non-decreasing
 * under passive retrieval, completed empty reports, and elapsed time.
 * Explicit negative feedback and factual validity remain separate signals.
 */
export function calculateLearnUsage(
  counters: LearnUsageCounters,
  _nowMs = Date.now(),
): LearnUsage {
  const retrieved = count(counters.retrieved);
  const evaluated = Math.min(retrieved, count(counters.evaluated));
  const applied = Math.min(evaluated, count(counters.applied));
  const verified = Math.min(applied, count(counters.verified));
  const base = {
    retrieved, evaluated, applied, verified,
    lastRetrievedAt: counters.lastRetrievedAt || null,
    lastAppliedAt: counters.lastAppliedAt || null,
    lastVerifiedAt: counters.lastVerifiedAt || null,
  };
  if (!evaluated) return {
    ...base, score: null, status: retrieved ? "unrated" : "new",
  };

  // Neutral until useful evidence arrives; saturating bonuses avoid a single
  // applied/verified observation generating an unrealistically perfect score.
  const applicationBonus = 30 * applied / (applied + 3);
  const verificationBonus = 20 * verified / (verified + 3);
  return {
    ...base,
    score: Math.round(50 + applicationBonus + verificationBonus),
    status: "rated",
  };
}

/** Positive usage is a modest relevance tie-breaker, never a penalty for being unused. */
export function usageRoutingAdjustment(usage?: LearnUsage | null): number {
  if (!usage || usage.status !== "rated" || usage.score === null) return 0;
  const sampleWeight = Math.min(1, usage.applied / 3);
  return Math.round(((usage.score - 50) / 50) * 12 * sampleWeight);
}
