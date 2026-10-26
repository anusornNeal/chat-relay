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

export function calculateLearnUsage(
  counters: LearnUsageCounters,
  nowMs = Date.now(),
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

  // Bayesian priors prevent one positive report from producing a perfect score.
  // Unreported retrievals are not evidence that a memory was unhelpful.
  const applicationRate = (applied + 2) / (evaluated + 4);
  const verifiedRate = applied ? (verified + 1) / (applied + 2) : 0;
  const age = Date.parse(base.lastAppliedAt || "");
  const recency = Number.isFinite(age)
    ? Math.exp(-Math.max(0, nowMs - age) / (30 * 86_400_000))
    : 0;
  return {
    ...base,
    score: Math.max(0, Math.min(100,
      Math.round(60 * applicationRate + 30 * verifiedRate + 10 * recency))),
    status: "rated",
  };
}

/** Keep usage as a modest relevance tie-breaker, not a replacement for context. */
export function usageRoutingAdjustment(usage?: LearnUsage | null): number {
  if (!usage || usage.status !== "rated" || usage.score === null) return 0;
  const sampleWeight = Math.min(1, usage.evaluated / 10);
  return Math.round(((usage.score - 50) / 50) * 12 * sampleWeight);
}
