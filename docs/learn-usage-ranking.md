# Learn Usage Ranking

## Scope and semantics
The **Usage Score** is derived from actual Learn context usage, not from memory
`confidence`. Confidence remains a ranking tie-breaker but cannot exclude
a memory from index discovery or establish factual content validity. Existing memories start with usage `New`, and after
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


## Learn Engine v2 — requirement-first retrieval and lifecycle (REL-16–20)

### Indexed prepare contract
- Each account has its own `Learning` Durable Object. The canonical `learning_memory_v1` table retains full content; `learning_metadata_index_v1` holds key, scope, kind, phase mask, required/core flags, content length, 120-character preview and update time. It is NOT a second content store.
- SQLite INSERT/UPDATE/DELETE triggers synchronize metadata atomically with source updates, including direct SQL project merges and project-context compaction. A versioned rebuild backfills legacy data and can be explicitly rerun; routine tools do not touch Learn.
- `/candidates` enumerates up to 512 metadata rows before selection and hydrates 48 records (64 for explicit project + agent, in one combined request). Keys `required-`, `required:`, `core-`, `core:` and `flowly-implementation-workflow` take precedence over confidence, negative usage feedback, recency and per-kind mix. Coding standards are prioritized in implement/review/test.
- Required rules are delivered in full or their keys appear in `preparedContext.coverage.missingKeys`; no silent truncation. `coverage.status` is `complete`, `needs-review` or `incomplete`. `previouslyLoadedIds` distinguishes a previously delivered required rule from a miss on later phase preparations. A medium/large Flowly planning task without the workflow rule surfaces a missing checkpoint. Advisory coverage never bypasses security, approves a plan or executes work.
- Scope resolution: explicit global/project/agent scopes can be fetched together in **one Learning DO request**. Inferred project/agent routes may require subsequent bounded reads. Shared Learn remains permission-filtered and approval-gated. Optional usage receipt still costs one additional request. No per-tool automatic Learn reads, cron, polling or quota enforcement.
- Content budget: 12,000 characters for general/read/plan and up to 16,000 for implement/review/test. Ordinary records may be shortened with `contentTruncated`; mandatory records cannot. `loadedMemoryIds` filters previously delivered context on phase transitions.

### Validity, revisions and provenance
- Factual validity is stored independently from `usage.score` and retrieval relevance: `valid`, `needs-review`, or `deprecated`. Retrieved-but-unused reports change usage telemetry only, never factual validity.
- `learn_lifecycle_review` requires explicit status, reason (at least eight characters), evidence reference and optional source fingerprint. Stale-source evidence must be genuinely checked before changing status; no automatic code or URL scanner runs.
- Content mutations save prior revisions. `learn_lifecycle_get` returns state, history and audit; `learn_lifecycle_restore` reverses earlier content only with an explicit reason/evidence. A normal content edit does not silently certify a `needs-review` record.
- Deprecated required records remain visible to coverage discovery, but cannot count toward complete coverage. Intentional delete clears the memory and its lifecycle history.

### Benchmark: local synthetic test, NOT Cloudflare production
Measured using `node test/learn-perf-benchmark.mjs`, Node.js 24.16.0 and in-memory SQLite, 151 stored records, 60 alternating iterations, 3 explicit scopes, 10 returned Learn items. One local run on 29 Oct 2026:

| Metric | Legacy per-kind | Indexed v2 |
| --- | ---: | ---: |
| Scoped Learning DO calls per explicit prepare (logical) | 3 | 1 |
| Optional usage receipt calls | 1 | 1 |
| Discoverable candidate records | 121 | 151 |
| Hydrated full-content records | 121 | 64 |
| Mandatory low-confidence workflow | Missing | Included |
| Coverage status | Not checked | Complete |
| Local median execution | 3.261 ms | 2.854 ms |
| Local p95 execution | 3.712 ms | 3.520 ms |
| Median internal response bytes | 119,154 | 133,014 |
| Returned context characters | 5,151 | 4,676 |
| Estimated context tokens (chars / 4) | 1,288 | 1,169 |

Interpretation: mandatory-rule coverage improved and explicit-scope requests decrease 3→1. Synthetic median improved slightly; the internal metadata reply is approximately **12% larger** because all 151 metadata entries are returned. Token counts are rough estimates, not tokenizer measurements. No network, Cloudflare binding dispatch, request billing, production CPU or realistic Worker load were measured. Actual Cloudflare Free plan CPU and Durable Object costs remain **unverified** pending separately authorized deployment and measurement. One-request batching applies to explicit project + agent; inferred routes can need additional scoped reads.

### Verification
- `node test/learn-index.test.mjs`: index CRUD/rebuild, 111 candidates, required priority, isolation.
- `node test/learn-lifecycle.test.mjs`: evidence-backed validity, stale fingerprint, revision restoration, ACL and delete.
- `node test/learn-phase-coverage.test.mjs`: 122 candidates, read→plan→implement, coding/loaded coverage, budgets, stale/deprecated and isolation.
- `npm run test:learn`, `npm run test:learn-bootstrap`, `npx wrangler deploy --dry-run`: regression, routing and Worker bundling. Dry-run does **not deploy**.
- `npm run test:hardening`: wider verification (record the actual exit code separately). This repository does not define `npm run typecheck`.

No push, publication, Cloudflare deployment or production configuration changes are part of REL-16.
