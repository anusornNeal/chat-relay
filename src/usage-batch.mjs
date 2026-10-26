export const USAGE_BATCH_MAX_ATTEMPTS = 3;
export const USAGE_BATCH_RETRY_BASE_MS = 150;

export async function deliverUsageBatch(events, send, {
  batchId = crypto.randomUUID(),
  maxAttempts = USAGE_BATCH_MAX_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await send(events, batchId);
    } catch {
      // Replaying the same idempotency key is safe even if the DO committed.
      if (attempt === maxAttempts) {
        return { delivered: false, attempts: attempt, uncertain: true };
      }
      await sleep(USAGE_BATCH_RETRY_BASE_MS * (2 ** (attempt - 1)));
      continue;
    }
    if (response?.ok) return { delivered: true, attempts: attempt, uncertain: false };
    // Retrying only explicit retryable server failures avoids replaying 4xx.
    if (![429, 502, 503, 504].includes(response?.status) || attempt === maxAttempts) {
      return { delivered: false, attempts: attempt, uncertain: false };
    }
    await sleep(USAGE_BATCH_RETRY_BASE_MS * (2 ** (attempt - 1)));
  }
  return { delivered: false, attempts: maxAttempts, uncertain: false };
}
