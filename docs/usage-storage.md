# Usage storage access

Usage counting is intentionally minimal. The dashboard only needs tool-call counts grouped by account and agent for Today, 7 days, and 30 days.

## Current write path

Each completed tool call sends only:

- `userId`
- `agentId` (or the synthetic `__relay__` agent for relay-local calls)
- completion `timestamp`

The Usage Durable Object stores that call with one SQLite upsert into `usage_hourly_v2`, keyed by `(hour_ms, user_id, agent_id)`.

This replaces the previous minute + hour + day aggregate writes. Normal usage accounting is therefore one aggregate row write per tool call. Failed calls use the same counter path and do not create raw error-history rows.

## Query path

`/window` is the only usage-count query used by the dashboard.

Filtering is performed in SQLite:

- time range
- optional `userId`
- optional `agentId`

The query groups with `SUM(calls) GROUP BY user_id, agent_id`. The dashboard receives already-grouped account/agent counts and does not filter raw usage rows in the browser.

For pre-cutover data, the Usage Durable Object reads the old BKK daily `agg:v1:day:...` buckets in one batched storage read. If a legacy day was marked overflow, one additional batched hourly read is used for that day. Legacy reads never backfill or rewrite storage. Once a requested range is entirely after the SQL cutover day, the legacy read path is skipped.

## Registry metadata

Dashboard Overview performs one Usage query and one Registry state query. Registry state is cached in-memory for 30 seconds and invalidated by user/agent/grant mutations, avoiding repeated storage-list reads while the Durable Object is hot.

## Removed paths

The detailed usage/history system is intentionally gone:

- raw successful/error event history
- Tool Calls history
- Errors history
- usage SQL event index/backfill
- minute/hour/day triple-write aggregation
- rolling `/summary`
- compatibility `/query`
- usage raw-retention cleanup

Run `npm run test:usage-storage` for storage/query access-pattern regression tests. Local tests validate code behavior and write-call counts; Cloudflare billing metrics remain the source of truth for deployed row accounting.

## Current Worker batching and failure semantics

The Worker buffers up to 96 usage events per batch and normally flushes after 3 seconds.
The Usage DO collapses repeated events in the same account/agent/hour bucket
into one SQL upsert for each distinct bucket within a batch.
Each event still contributes to exact call counts if successfully delivered.

Explicit transient HTTP errors (429/502/503/504) are retried up to three total
attempts with bounded 150/300 ms backoff. Non-retryable HTTP errors do not replay.
An exception while sending is *ambiguous*: the remote DO may have already
committed the batch. Therefore, it is **not retried automatically**, to avoid
silently double-counting calls. The Worker health response exposes cumulative
`usageBatch.failedEvents` and `usageBatch.uncertainEvents` for the current
isolate. These are diagnostics, not durable counters.

This behavior is best-effort rather than exactly-once. A future durable
idempotency key + receiver-side deduplication would be needed to provide
reliable retries across uncertain acknowledgements. That design must first be
measured for added Cloudflare SQL writes and DO CPU cost.

The existing hourly aggregate supports optional detailed latency summaries and
approximate p95 from histogram bins; raw commands, payloads and request history
are not stored. Neither batch telemetry nor diagnostic counters enforce quotas.
