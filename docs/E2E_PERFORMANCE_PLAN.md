# Chat Relay v1.4.0 — E2E Performance Hardening Plan
Status: in progress; source of truth for task state is the Chat Relay Flowly board. This file records measurable contracts and observed engineering evidence; it is not a completion claim.

## Goal and boundaries
Reduce time from a user's coding request to a **verified** result without compromising correctness, security, approval/review or Cloudflare Free-tier limits. Chat Relay remains a model-agnostic transport; Flowly owns task orchestration. No automatic LLM thinking, background agent or context snapshot runtime will be added to Relay.
Non-goals: artificially increasing allowedRoots, bypassing Learn/Auth, hiding errors, skipping required tests, caching stale filesystem reads, replacing Flowly, introducing background Durable Object polling or quotas.

## Baseline observed on production v1.4.0 (29 Oct 2026, Windows DESKTOP-5IQPSSC)
- Eight 12-line filesystem reads: **sequential** 6.04 / 6.26 / 7.27 sec wall clock (8 MCP tool invocations); aggregated agent relay round trips ~0.31 sec. **Parallel** 1.60 / 1.72 / 2.67 sec (8 calls). **fs_batch** 0.42–1.29 sec (1 call). These measurements include the caller/tool orchestration; not model inference.
- Read/search filename individual relay p50 ~36–37ms; short warmed terminal ~42ms; first shell ~284ms, and some external shell commands ~3s.
- Android repo no-match content search scans ~4,445 entries: native FileManager handler ~1.0–1.9 sec; ripgrep shell total ~0.4s (rg ~0.16–0.17s), but different ignore rules and therefore **not directly comparable**.
- Scope change for buddy-android caused two LEARN_PREPARE_REQUIRED tool attempts. Follow-up learn_prepare wall clock 6.55 sec (single sample).
- Agent reconnect count 3 with WebSocket close 1006; root cause and user-task impact unverified.
- Single-call agent queue wait 0ms in sampled tests. No trustworthy model inference latency or Cloudflare CPU/DO daily aggregates measured yet.
- Existing unrelated untracked run-chat-relay.cmd is protected.

## Measurement contract
Collect independent timings by boundary:
1. **Client/tool-invocation wall time** including connector/control overhead (not model token generation).
2. Worker entry -> auth/permission -> routing/preflight -> Relay DO -> WebSocket -> Agent queue/handler -> response, using bounded timing fields that never expose payloads or secrets.
3. End-to-end coding workflow wall time: discover + read relevant files + search + run test + validate result; separately annotate ChatGPT reasoning time as **unmeasured** unless an instrumented host exposes it.
4. p50/p95/p99 for >=30 trials after a small warmup, and cold cases; errors/timeouts, invocations per completed task, returned bytes, Cloudflare CPU/DO request/rows where observability is available. Never treat self-generated traffic as zero-cost.
5. Test same machine, repository snapshot, search scope, test content, and concurrency. Record jitter, Windows antivirus and CLI overhead as confounders.
6. Compare baseline/current on identical scenarios: one-shot file read, 8-file sequential/parallel/batch, filename/content not-found, large Android repository, preflight initial/warm/scope change, short terminal cold/warm, >20s build via sessions, reconnect during idle/in-flight, 5-chat contention, auth/allowedRoots errors.

## Acceptance gates
- P0 eight-file workflow total caller wall p50 improves >=30% against sequential baseline, without falsely attributing reduction to Worker execution. Target batch <=2 calls; maintain ordered/partial error behavior.
- Native content-search p50 on same fixture improves >=25% OR document why an alternative is safer; preserve deterministic ordering, bounds, explicit generated-directory search, binary filtering and incomplete flags.
- No added Learning DO request on warm ordinary tool path; project-scoped preflight cannot silently bypass a required prepare; no unnecessary repeated `LEARN_PREPARE_REQUIRED` retries after valid preparation.
- No erroneous retries of non-idempotent writes or terminal commands on reconnect; bounded retry and liveness diagnostics; no unauthorized access.
- Long-running commands use terminal_start/read and do not get killed at 20 seconds due to routing error; maintain cancellation/cleanup.
- p95 single tool warm time no worse than 10% from a comparable baseline (noise-aware); error rate does not rise; memory bounded and Worker Free-tier costs not increased without evidence.
- All tests pass (focused tests, npm run test:hardening, CI-equivalent tests and local E2E where available); no data leakage; report incomplete Cloudflare/model metrics transparently.

## Workstream plan / dependency ordering
**A. PERF baseline + reproducible harness (foundation):** add deterministic perf workload and structured JSON reporting to test/ and docs/. Measure controlled protocol through existing local Worker integration environment and actual production tool client; no auth token persistence in reports.
**B. Tool-call reduction (P0):** make Relay tool contracts/tool descriptions and Flowly caller guidance favor fs_batch/read_multiple_files, inline first-page search, and bounded terminal_batch_start for independent operations. No forced parallelization of dependent writes. Add contract tests and verify real 8-file workload.
**C. Learn routing/preflight (P0):** audit project-scope identity and cold-DO path, minimize retriable rejections by explicit preparation guidance and coherent project key propagation while retaining mandatory scope isolation; avoid per-call Learn reads/writes. Add cold/warm/scope-switch, alias, auth tests.
**D. Native search engine (P1):** evaluate bounded concurrent content scans, byte-level binary checks, scan-limit correctness and deterministic ordering. Do not implicitly require ripgrep to be installed; optional acceleration only with feature-detection and exact parity tests.
**E. Terminal execution (P1):** improve short-command selection, warm-shell behavior and long-job routing docs; run real >20 sec test with terminal_start/read and process cleanup. Preserve destructive-command security rules.
**F. Reconnect/resiliency (P1):** test abort/1006/heartbeat timeout, classify cause and correlate tool-call IDs; no side-effect retries when executionStatus unknown. Bound logs and avoid periodic Worker/DO work.
**G. Integration/QA/performance report (depends A–F):** stable warm/cold benchmark across 1/5 chats, Cloudflare usage, CPU/DO metrics if accessible, verify regression suite, publish before/after deltas and remaining limitations. Do not claim E2E model-speed change without model latency measurements.

## Engineering risks and architecture options
Option A (recommended): preserve Relay transport and improve orchestration hints, efficient native tools, preflight and resilience with bounded tracing. Pros: low overhead and direct fixes; cons: some ChatGPT/connector time remains unobservable.
Option B: add autonomous coding/runtime/scheduler inside Relay. Pros: can centralize sessions; cons: high complexity/DO load, duplicate Flowly, changes security surface. Rejected.
Option C: blanket cache or bypass Learn/security to reduce latency. Pros: initial speed; cons: stale permissions, scope leaks and correctness regressions. Rejected.

## Test matrix (persisted Flowly cards own execution)
- Positive: 8 reads same results for sequential/parallel/batch; pagination 20+N; exact search hits; warm-shell correct outputs.
- Negative: permission denied/path_not_allowed, missing path, invalid agent/secret; preflight unprepared; socket disconnect in-flight; malformed/oversized data; tool timeout.
- Edge: 5,000-file traversal; 64 search sessions/TTL; UTF-8/CRLF/binary with NUL; generated directory explicit root; concurrent 5 chats; start/read long job, cancel and orphan cleanup.
- Security/perf: auth revision freshness, zero optional DO per warm tool, bounded payload, no secret persistence, no unauthorized automatic retries.

## Evidence, release and cleanup
For each task record branch/commit, exact test command, exit code, benchmark scenario/sample size, p50/p95, CPU/DO if available and caveats. Preserve untracked files, other active processes and external worktrees. Commit locally on task boundaries after verification. **No push, tag, npm publish or Worker deploy without a separate explicit user instruction.**