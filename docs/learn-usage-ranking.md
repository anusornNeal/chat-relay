# Learn Usage Ranking

## Scope and semantics
The **Usage Score** is derived from actual Learn context usage, not from memory
`confidence`. Confidence remains internal for eligibility, quality and legacy
routing compatibility. Existing memories start with usage `New`, and after
retrieval but before a use report they show `Unrated`.

| Counter | What increments it | What does not increment it |
| --- | --- | --- |
| Retrieved | Private memory ID actually delivered by `learn_prepare` in the bounded context envelope | Raw `learn_get` inspection, filtered-out memories, Shared Learn |
| Evaluated | A single completed `learn_usage_report` for a previously created receipt; counts each prepared memory | Missing reports (no negative inference) |
| Applied | The report lists the memory as materially used for a decision or task | Merely reading the context |
| Verified | A reported applied memory has a non-empty verifiable evidence reference | No evidence or merely using the memory |

**Verification is currently evidence-referenced self-report**, not an independent
audit: an agent must not invent evidence or claim a passing test that did not run.
Receipts are account-local, unguessable UUIDs, accepted exactly once, and expire
after 24 hours. The report may include an empty applied list to indicate
evaluated-but-not-used. No report means **unrated**, not failed.

After `learn_prepare` returns `usageReceiptId`, report once at the end of the
task with `learn_usage_report({receiptId, appliedMemoryIds, verified})`.
Use only selected memory IDs from that preparation. Do not report raw logs or
private credentials. A task may leave receipt unused if it was interrupted.

## Task-completion reporting and troubleshooting

1. Call `learn_prepare` once for a context-sensitive task, keeping the returned
   `usageReceiptId` and the exact private memory IDs from `preparedContext`.
2. Immediately before the final answer for a completed task, when a receipt
   exists and the tool is available, call `learn_usage_report` **once**.
   Use `appliedMemoryIds: []` if none of the prepared memories materially
   influenced the task. Attach `verified: [{ memoryId, evidenceRef }]` only
   for an applied memory with a real checkable test, result, commit, or explicit
   user confirmation of that use. A normal retrieval is not an application.
3. After a successful report all prepared private memories gain **Evaluated**,
   only specified IDs gain **Applied**, and only evidence-backed applied IDs
   gain **Verified**. A retry of the same receipt cannot count again.

If the receipt is null, the work was interrupted, or the caller cannot see
`learn_usage_report`, **do not guess, backfill, or use a different tool to
simulate a report**. The memory remains `Unrated`. In the Dashboard,
`Retrieved > 0` with `Evaluated = 0` means no completed report has been
received, not that the memory was unused. Receipts expire after 24 hours.

**Plugin tool sync:** The Worker registers both Learn tools, but clients can
keep a stale MCP tool catalog until the connector is synced. After an
authorized Worker deployment, refresh/sync the connector once and check that
`tools/list` contains `learn_usage_report` with required `receiptId` and
`appliedMemoryIds` fields. A successful local `npm run test:learn-usage`
covers the MCP catalog and the complete prepare -> report -> profile counters
path; it does not prove the user-facing ChatGPT tool catalog is refreshed.

## Score

For evaluated memories:

- Application: 60% × `(applied + 2)/(evaluated + 4)` (Bayesian smoothing).
- Verified: 30% × `(verified + 1)/(applied + 2)`; zero if nothing applied.
- Recency: 10% × `exp(-daysSinceLastApplied/30)`.

The score is rounded to a 0–100 integer. A single positive report cannot
yield a perfect score. Without evaluated usage there is no score, only
`New` or `Unrated`. The existing Learn relevance scorer treats usage as a
bounded ±12-point signal, weighted by at least 10 evaluated observations,
so new memories are not locked out by a low sample size.

## Storage and Cloudflare costs

- A migration adds seven aggregate fields to existing `learning_memory_v1`
  records. Existing memory IDs/content/feedback/confidence are retained.
- A small account-scoped receipt table stores an opaque UUID and up to 32
  private memory IDs. Only a bounded number of expired receipts are removed
  opportunistically, not on a periodic task.
- One additional Learning DO request per successful private `learn_prepare`
  plus one request if the task reports usage. The hot path of ordinary tools
  does not fetch or update Learn.
- Receipt creation writes one receipt and one batched memory update; completed
  reports update receipt + up to three aggregate categories. Writes are atomic
  where Durable Object storage supports transactionSync.
- There is **no historical backfill** from confidence/feedback values.
  Production cost/latency needs measurement after an authorized deployment.

## Dashboard

The private Learn Library lists `Usage Score` instead of `Confidence`.
Items without a computed score show `New` or `Unrated`.
Details show Retrieved, Evaluated, Applied, Verified, and a note clarifying the
verification caveat. Explicit Useful/Not useful feedback remains separate.

Usage aggregates are not exposed through Shared Learn project proposals.
No per-tool Learning DO read/write, polling or new quota enforcement is added.
