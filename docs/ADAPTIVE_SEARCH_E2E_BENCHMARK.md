# Adaptive Search: Buddy Onboarding MCP E2E Benchmark

Date: 2026-10-29 (Asia/Bangkok). Local source commit `34676da` on `main`; not a production deployment.

## Goal
Reduce **host-visible MCP tool calls** needed for long-task code exploration. Compare:
- Legacy: `start_search` + `read_multiple_files` (2 calls)
- Candidate: `start_search(previewLines=20)` (1 call)

The one-call optimization is optional, bounded, and caller-driven. It is not automatic batch planning, dependency tracing, or a general 50% reduction across arbitrary tasks.

## Workload and control
Real read-only Buddy Android `app/src/main/java/com/qchang/buddy/compose/ui/onboarding_menu` source. Search filenames for `ViewModel`, limited to eight matching source files. Read their first 20 lines. Both paths use identical scope and results, and the test asserts path/content parity in every paired iteration. Alternate execution order, three warmups + 30 measured paired samples per run. Repeat the whole benchmark twice.

E2E route: Node HTTP MCP client -> local Wrangler Worker -> Durable Object -> WebSocket -> isolated, read-only fixture Local Agent -> response. No production account, Cloudflare network, or real user Agent is used. Caller-wall timing is from Node client (not ChatGPT host).

## Results

| Run | Workflow | MCP calls | p50 ms | p95 ms | Workflow Relay round-trip p50 ms | Parity |
|---|---|---:|---:|---:|---:|---|
| 1 | Search + Read | 2 | 50.118 | 60.547 | 11 | PASS |
| 1 | Search + Preview | 1 | 28.568 | 35.631 | 9 | PASS |
| 2 | Search + Read | 2 | 50.368 | 60.176 | 11 | PASS |
| 2 | Search + Preview | 1 | 28.166 | 36.291 | 9 | PASS |

- 50% fewer MCP calls **for this specific discovery/read workflow**.
- p50 end-to-end reduction **43.00%** (run 1) and **44.08%** (run 2).
- No file mutations; content parity PASS in 60 measured paired comparisons.
- Small local Relay round-trip does **not** imply equally small host/model overhead.

## How to reproduce
1. From `chat-relay` start the local test Worker: `npm run dev:test`.
2. Run `$env:TEST_RELAY_URL='http://127.0.0.1:8790'; npm run bench:search-preview:e2e` from PowerShell.
3. Optional: `$env:BUDDY_ONBOARDING_ROOT='<actual/onboarding_menu/path>'` to choose a different Buddy checkout.
4. The test itself connects a temporary authorized fixture agent with its allowed root strictly constrained to the onboarding directory and terminates it on exit.

## Important exclusions and next verification gates
- **Not included:** ChatGPT model inference/reasoning, ChatGPT host tool-selection/scheduling, production network, Cloudflare Worker CPU/DO billing, actual changes to whole long-task completion time.
- The published agent/Worker at v1.5.0 cannot be used as the **new preview** candidate until a separately authorized release/upgrade makes the added tool schema available.
- Actual full-task A/B must compare equivalent tasks, including reasoning, tool selection, completion quality, errors and retries. No evidence yet supports applying this percent improvement to entire long tasks.
- The preview is bounded (60 lines/file maximum and an aggregate budget); when a snippet is unavailable/partial, callers must continue with targeted reads. The benchmark uses eight files that fit within the budget.

No production push, deploy, publish, or tag was performed for this benchmark.
