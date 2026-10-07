const QUOTA_DISABLED_CACHE_TTL_MS = 5_000;

let quotaDisabledUntil = 0;

export function quotaDisabledFastPathActive(now = Date.now()) {
  return quotaDisabledUntil > now;
}

export function noteQuotaDisabled(now = Date.now()) {
  quotaDisabledUntil = now + QUOTA_DISABLED_CACHE_TTL_MS;
}

export function invalidateQuotaDisabledFastPath() {
  quotaDisabledUntil = 0;
}

export function quotaDisabledFastPathTtlMs() {
  return QUOTA_DISABLED_CACHE_TTL_MS;
}
