# Chat Relay — E2E Performance Hardening Results
Date: 2026-10-29 (Asia/Bangkok). Parent: Flowly REL-21; scope REL-22 through REL-28.
Implementation is **local only** on `main` after published `v1.4.0`. It is not a deployed `v1.4.1` or production performance claim.

## Measurement discipline
- **MCP E2E** is the complete *local test client* HTTP MCP -> local Wrangler Worker -> Relay Durable Object -> WebSocket -> local test agent -> response, **excluding** ChatGPT inference, production Cloudflare network/CPU, and ChatGPT plugin/connector scheduling.
- **Search handler** benchmarks the same 1,600 deterministic files, same search pattern and Windows machine, 30 trials after three warmups, alternating the v1.4.0 baseline implementation and candidate. This is a real handler measurement, not MCP E2E.
- Wall durations, p50 and p95 are per completed scenario. A change to instructions alone does not prove agents will always choose batch. Results are conditional on the same workflow using the batch tool.
- Uninstrumented metrics (model generation, Cloudflare DO SQLite reads/writes and production Worker CPU per call) are marked **not measured**, never estimated from source.
- All fixtures are temporary and removed from the ignored `.workspace/`; existing unrelated `run-chat-relay.cmd` is preserved.

## Results: eight independent 4-line file reads through local MCP Worker (30 samples)

| Mode | Calls/scenario | p50 | p95 | Correctness |
|---|---:|---:|---:|---|
| Sequential read_file | 8 | 174.399 ms | 219.348 ms | PASS |
| Parallel read_file | 8 | 155.747 ms | 190.249 ms | PASS |
| fs_batch | 1 | 26.706 ms | 37.069 ms | PASS |
| read_multiple_files | 1 | 24.840 ms | 32.871 ms | PASS |

**Conditional optimization:** fs_batch instead of 8 sequential calls: **84.69% lower p50** and **87.50% fewer calls**. These are mode comparisons under the same updated code, **not** proof of a 84.69% release-to-release speedup. The previous production/host tool orchestration study also found eight serial reads ~6.0–7.3 seconds vs a single fs_batch ~0.42–1.29 seconds, but those small-sample wall measurements include extra host scheduling and are not directly comparable to the 30-trial local MCP benchmark.

In-process FileManager baseline (30 samples): serial p50 3.577 ms vs batch p50 3.691 ms. Thus the major savings come from fewer MCP/Worker/connector invocations rather than raw disk scan speed. The descriptions for `read_file`, `read_multiple_files`, `fs_batch`, `terminal_exec`, `terminal_batch_start`, `terminal_start` now recommend the appropriate method and continuation semantics. Client adoption is not guaranteed by descriptions alone.

## Results: content search through FileManager (30 matched samples)

| Same 1,600-file content-miss fixture | p50 | p95 |
|---|---:|---:|
| v1.4.0 baseline | 433.047 ms | 443.951 ms |
| bounded concurrency 8, new code | 95.279 ms | 98.046 ms |

**p50 improvement 78.00%**, exact parity: 1,616 entries scanned, zero matches, no unexpected incomplete flag. BFS file order, 20-result first page, `maxResults`, 5,000-item scan cap, generated/binary skips, session bound and TTL passed focused 5/5 regression tests. Max speculative content reads beyond the logical cap are bounded to one window of eight (no payload leakage); avoid increasing this concurrency without FD/memory evidence.

An earlier live read-only Android repository scan visited 4,445 entries with baseline warm handler ~1.025 seconds. The latest candidate has **not** been installed on the running v1.4.0 agent, so no production Android after value is claimed. Native `rg` timings were not used as the baseline because ignore/filtering semantics differ.

## Learn preflight and context overhead
- Before hardening, changing to project `buddy-android` without preparation caused two `LEARN_PREPARE_REQUIRED` responses; a subsequent `learn_prepare` had a 6.55-second caller-wall observation (single sample). This is not evidence that Learning DO computation consumed 6.55 seconds; most work is outside the measurable local context ranking (~2.97 ms p50 from 60 Node/SQLite iterations).
- The old per-isolate gate allowed the third repeated unprepared request to bypass the mandatory gate. The new gate **never treats ordinary repeated rejections as preparation**; it still explicitly fails open when Learning DO is unavailable per existing resilience policy.
- A local MCP Worker integration test verified **three repeated unprepared tool calls all blocked**, preparation then unblocked, scope switch to another project blocked until that scope was prepared.
- Reflection advisory is now eligible at a deliberate Git commit/push checkpoint rather than after every file write. No additional per-tool Learning DO writes were introduced.
- Scope-switch work requires an explicit `learn_prepare` before the first project-specific action; a model can still incur a rejected call if it ignores that guidance. **No verified quantified preflight speedup** is claimed.

## Terminal / reconnect / safety
- Production agent `terminal_start` ran a controlled 21.2-second command to completion with exact output and exit code 0; it was not subject to the 20-second synchronous `terminal_exec` cap. Automated short/persistent and terminal session tests 2/2 passed.
- WebSocket disconnects with code `1006` were observed three times on the running v1.4.0 agent. The cause and lost-task impact remain unknown. Do **not** assert that socket retry timers were optimized.
- The oversized-response Worker error now explicitly sets `executionStatus: unknown` and `retrySafe: false`, matching disconnected/time-out replies. No automatic retry of non-idempotent operations is introduced. Existing socket generation fencing, bounded diagnostics, 1006 classification and reconnect safety contracts are covered by 13/13 agent-state tests, generation and watchdog cases.
- The 5-chat soak reported peak concurrency=4, one queued, all five completed and zero duplicates; 2,000 simulated reconnect/telemetry iterations passed. This is **simulation**, not an independent live five-chat load test.

## Test and release gates
| Gate | Result | Evidence |
|---|---|---|
| Local MCP E2E, 30 samples | PASS | `node test/e2e-perf-benchmark.mjs --mcp --samples=30`, local Wrangler port 8798, isolated fixture agent |
| In-process baseline, 30 samples | PASS | `node test/e2e-perf-benchmark.mjs --samples=30` |
| Native Search parity/perf, 30 samples | PASS | `node test/file-search-perf.test.mjs --samples=30` |
| Search regression | PASS 5/5 | `npm run test:file-search` |
| Learn local MCP preflight integration | PASS | `node test/learn-preflight-live.test.mjs` with isolated test account |
| Batch contract and terminal session | PASS 2/2 each | `npm run test:batch-contract`, `npm run test:terminal-perf` |
| Full hardening/Soak | PASS | `npm run test:hardening`, exit 0 |
| Publish preflight | PASS | `npm run verify:publish`, Wrangler **dry-run only** |
| Production dependencies | PASS | npm audit reports 0 vulnerabilities |
| Cloudflare production DO/CPU | NOT MEASURED | Need dashboard telemetry/access and comparable production load |
| Real model reasoning and host connector latency | NOT MEASURED | Not exposed by Relay instrumentation |
| Real in-flight WebSocket fault injection on running agent | PARTIALLY COVERED | Unit/source contract checks only; production 1006 root cause unknown |

## Code/release status
- `936090b` [REL-22] Benchmark harness + measurement plan
- `a05e7d7` [REL-25] Bounded parallel content search + regression/perf test
- `f852995`, `fdc0762` [REL-23] Scoped preflight security and real local Worker tests
- `cf7e7fa` [REL-26] Short/long terminal tests
- `3f41f8f` [REL-24] Batch-first + long command MCP tool guidance and contract tests
- `7947f4c` [REL-27] Unknown-response retry safety and socket regression contracts
- This report is tracked under REL-28 with a separate commit.

## Follow-up / residual risks (do not mislabel as complete)
1. Inspect real Cloudflare Worker CPU/DO costs and production effects after a separately authorized release; no per-call DO/CPU values are currently observed.
2. Investigate intermittent 1006 with network traces/fault injection if recurrence affects live tasks; do not alter heartbeat/retries without evidence.
3. Measure actual ChatGPT request-to-verified-commit time (including model inference and connector scheduling) with host-side timings if a host telemetry integration becomes available. The local MCP speedup is not automatically the total coding task speedup.
4. Confirm clients actually adopt batch-first tool descriptions; tool discovery text cannot enforce caller strategy. Flowly should own workflow instruction adjustments.
5. Full cross-platform CI and production smoke require their own gate and access. Keep task cards **Ready for Review** until independent review/QA confirms the residual criteria.

No git push, npm publish, tag or Cloudflare production deploy was performed for these changes.
