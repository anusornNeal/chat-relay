# Relay Reliability and Performance Playbook

## Scope

The worker, Durable Objects, local agents and monitoring dashboard have
separate failure domains. This playbook describes existing diagnostic fields
and safe fault isolation without adding per-tool storage requests or polling.

## Diagnosing connection failures

Inspect per-agent state through the existing admin/agent status:
`lastCloseCode`, `lastSocketError`, `lastDisconnectReason`,
`lastDisconnectCategory`, `lastConnectionDurationMs`,
`reconnectCount`, `nextReconnectAt`, and `serverConnectionGeneration`.

| Category | Meaning | Check |
| --- | --- | --- |
| `dns` | Resolver failure such as ENOTFOUND | Local DNS/network resolution and service hostname |
| `network` | ECONNRESET, ECONNREFUSED, EPIPE | Proxy/router/firewall and transient internet connectivity |
| `timeout` | Missing WebSocket pong, heartbeat ACK or socket timeout | Event-loop blocking, network loss, sleeping laptop |
| `abnormal_transport` | WebSocket 1006 with no more specific cause | NAT, proxy, network switching, Worker disconnect |
| `authorization` | Credential rejected or revoked | Account agent authorization |
| `restart` | Worker/server lifecycle or intentional upgrade | Deploy and agent upgrade timestamps |

A high reconnect count alone does not establish a software defect. Compare
the categories, connection durations and process epoch, and distinguish
repeated short-lived failures from periodic network changes. The agent already
uses bounded exponential backoff plus jitter; avoid adding high-frequency
status polling in response to transient disconnects.

### Unknown tool outcomes

When an in-flight call times out or the agent disconnects after a request was
sent, the Worker returns `executionStatus: "unknown"` and
`retrySafe: false`. The command **may already have succeeded**. Before
repeating a write, inspect the resulting file, Git state or target system.
Reading current state is safer than automatically resubmitting a side-effecting
operation. Unsent requests (agent offline before send) are a different case.

## Latency breakdown

On successful tools with timing metadata the existing Relay result provides
`relayRoundTripMs`, `transportMs`, `agentQueueWaitMs` and
`agentHandlerMs`. Differentiate network transport from local scheduler queue
wait and execution time before optimizing code. Legacy/rolling-deploy results
can lack these headers. Tool usage aggregates record duration histograms and
approximate p95; they do not persist raw requests or sensitive command output.

In the dashboard, compare Avg / p95 latency, operational errors, call volumes
and active agents. A high p95 with a low average often indicates isolated
slow operations. Use the actual per-call timing breakdown for root cause
instead of adding SQL columns or Durable Object reads speculatively.

## Cloudflare and SQL budget

- Usage is optional and never enforces a per-user quota.
- Usage events are buffered (96 per batch, normally up to 3 seconds).
- Hourly SQL aggregates coalesce events sharing one user/agent/hour into one
  bucket upsert. Idempotent batches also insert one small receipt row per
  **batch**, not per tool call.
- Receipt cleanup is bounded and opportunistic (128 old entries examined
  every 512 accepted batches, after seven days). The retention window
  limits deduplication of very old replays.
- Transient HTTP failures and ambiguous network acknowledgements retry up
  to three total attempts with the same idempotency key.
- Avoid periodic Learn/Registry/Usage reads for metrics that already exist.
  Diagnostic changes should be checked against Worker CPU, DO requests and
  SQL rows written, not latency alone.

## Verification

Run `npm run test:agent-state` for deterministic reconnect and classification
scenarios, `npm run test:usage-storage` for receipt/replay behavior,
`npm run test:dashboard-timers` for dashboard event behavior and
`npm run test:hardening` for the broader regression baseline. A Worker
`wrangler deploy --dry-run` builds the artifact but does **not** validate
production traffic or deploy any changes.

For production reliability, observe actual reconnect diagnostics and SQL costs
after an explicitly authorized deployment. Do not infer production success from
unit tests or dry-run alone.
