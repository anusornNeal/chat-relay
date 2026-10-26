# Usage storage and data accuracy

## Production write path

The Worker buffers optional Usage events (up to 384 queued events in one
isolate, grouped into 96-event batches) and normally starts a flush within
3 seconds. The queue is bounded: overflow increments a non-durable failure
counter instead of allocating unbounded memory or blocking user tools.

Each batch POSTs `/record-batch` with `events[]` and one randomly generated
UUID `batchId`. Same-agent/user/hour events are folded into one aggregate
upsert per distinct bucket inside the Usage SQLite Durable Object. Current
table: `usage_hourly_v3`. It stores counts plus per-tool call details,
duration histogram and approximate p95 inputs; **no raw request history**.

Each newly accepted batch writes one short receipt to
`usage_batch_receipts` atomically with the aggregate update. Duplicate
`batchId` is accepted with `duplicate: true` without incrementing counts.
A failed transaction rolls back the receipt so a retry can succeed.
Legacy clients omitting `batchId` use the original non-deduplicated behavior.

Transient explicit statuses (429/502/503/504) and ambiguous transport failures
retry up to three total attempts with the **same** batch UUID and 150/300ms
backoff. Permanent validation/auth failures are not retried. A batch can still
be lost after all attempts fail; usage is deliberately best-effort and does
not gate ordinary tools. The Worker `/health` response exposes isolate-scoped
`usageBatch.pending`, `maxEvents`, `maxPendingEvents`, `delayMs`,
`failedEvents`, and `uncertainEvents`.

Receipt retention is seven days, with opportunistic bounded pruning (up to
128 old receipts every 512 accepted batches). An ancient replay after
expiration is not covered. This introduces **one SQL receipt row per batch**,
not a new DO request or write per tool call; SQL row costs should be
verified after deployment, not assumed from local tests.

The non-SQL test/runtime fallback uses transactional KV receipts. Production
runs the SQLite DO implementation. The optional dashboard publish budget is
independent of quota enforcement; per-user usage quotas remain disabled.

## Query path

The dashboard queries `/window` with server-side time, optional userId
and optional agentId filters. `SUM(calls) GROUP BY user_id, agent_id` produces
already-grouped totals; raw calls are never sent to the dashboard. Detail
queries can return aggregate durations, approximate p95, infrastructure
failure counts and tool summaries without exposing command contents.

Legacy `agg:v1:day` data is read in bounded batched operations, with hourly
fallback for legacy overflow days, and no backfill writes. When a window falls
entirely after SQL cutover the legacy reads are skipped. The Registry overview
uses an in-memory state cache with mutation invalidation rather than polling
persistent Registry rows for every dashboard refresh.

The previous minute/hour/day triple-write and raw Tool Calls/Errors history
are not part of this path. Removed legacy endpoints `/summary` and
`/query` are not supported.

## Verification

- `npm run test:usage-storage` tests counter accuracy, replay/UUID rejection,
  receipt transaction behavior and bucket write counts.
- `npm run test:budget` checks that optional telemetry does not reinstate
  usage quota gates.
- `npm run test:dashboard-timers` checks live dashboard timers and fallback.
- Cloudflare production DO requests, SQL rows written/read, CPU and p95
  should be measured only after explicitly authorized deployment.
