function boundedBudget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), 10_000_000);
}

function utcDay(now) {
  return new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString().slice(0, 10);
}

export class DailyOptionalBudget {
  constructor() {
    this.day = null;
    this.used = 0;
    this.suppressed = 0;
  }

  resetIfNeeded(now = Date.now()) {
    const day = utcDay(now);
    if (this.day === day) return;
    this.day = day;
    this.used = 0;
    this.suppressed = 0;
  }

  consume(configuredLimit, now = Date.now()) {
    this.resetIfNeeded(now);
    const limit = boundedBudget(configuredLimit);
    if (limit === 0) {
      return { allowed: true, ...this.snapshot(limit, now) };
    }
    if (this.used >= limit) {
      this.suppressed += 1;
      return { allowed: false, ...this.snapshot(limit, now) };
    }
    this.used += 1;
    return { allowed: true, ...this.snapshot(limit, now) };
  }

  snapshot(configuredLimit, now = Date.now()) {
    this.resetIfNeeded(now);
    const limit = boundedBudget(configuredLimit);
    return {
      enabled: limit > 0,
      day: this.day,
      limit: limit || null,
      used: this.used,
      remaining: limit > 0 ? Math.max(0, limit - this.used) : null,
      suppressed: this.suppressed,
    };
  }
}

export function normalizeOptionalBudget(value) {
  return boundedBudget(value);
}
