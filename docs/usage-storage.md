# Usage storage access

Usage counting is intentionally minimal. The dashboard only needs tool-call counts grouped by account and agent for Today, 7 days, and 30 days.

## Current write path

Each completed tool call sends only:

- `userId`
- `agentId` (or the synthetic `__relay__` agent for relay-local calls)
- completion `timestamp`

The Usage Durable Object stores that call with one SQLite upsert into `usage_hourly_v2`, keyed by `(hour_ms, user_id, agent_id)`.

This replaces the previous minute + hour + day aggregate writes. Normal usage accounting is therefore one aggregate row write per tool call. Failed calls use the same counter path and do not create raw error-history rows.

Disabled quota policy checks are read-only and do not create per-user quota rows.

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
