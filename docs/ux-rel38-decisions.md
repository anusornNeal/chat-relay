# REL-38 UX decision record — Chat Relay

**Status:** Local feature-branch prototype for user review (not yet released).

## User research / requirements

The primary task is to compare **Tool Calls per person** for Today, the last 7 calendar days, and the last 30 calendar days. A user must be able to check the number used on each day. My Learn focuses on reviewing quality, using feedback and usage evidence. Admin and ordinary users matter equally. Desktop is the primary workspace, with mobile still functional.

These are user-provided requirements, not assumptions from analytics.

## Decisions and supporting reasons

| Decision | User task / rationale | Evidence or type |
|---|---|---|
| Open the workspace on **Usage**; put Usage, Learn, System in horizontal navigation | Prioritize the most frequently needed task, without a permanent 240px sidebar | Design hypothesis, validate with users; not a universal rule |
| Show **Tool Calls** explicitly and only | Avoid confusing tool invocations with HTTP requests, tokens, or Cloudflare compute | Confirmed requirement and existing Usage API metric |
| Show a large **period total** and a sortable **per-person numerical table** | Compare exact totals without opening N user details; right-aligned, tabular numerals aid scanning | Carbon data-table guidance; GOV.UK table guidance |
| Default sort: most Tool Calls first; offer name sorting and search | Answer “who used the most?” immediately, find a known person or agent quickly | User task and design hypothesis |
| Choose Today / 7 days / 30 days with visible BKK date boundaries | Prevent ambiguous rolling-window interpretations | Existing API semantics: Asia/Bangkok midnight; 7d includes today plus six preceding days |
| Reveal per-person **hourly/daily** counts inside an expanded table row | Numeric per-day breakdown without forcing everyone into separate views | Progressive disclosure; task-specific hierarchy |
| Hide Agent and Performance details behind named disclosures | These are useful but not the primary task | Progressive disclosure / focus on main task |
| Fetch selected-user summary **on demand**, cached per user+range | Avoid N+1 calls and unexpected Durable Object load | Verified endpoint contracts; performance constraint |
| Show personal user's own usage rather than every user | Do not expose other users' history | Existing backend role scoping; security requirement |
| Make the Learn default a **Review Desk**; show folders/groups only on request | Prioritize evaluation, feedback, refinement rather than browsing a directory | User task + design hypothesis, with review suggestions labeled as non-authoritative |
| Keep Learn Search visible; allow filtering by scope/group when needed | Find a memory without entering a permanent folder-tree hierarchy | Progressive disclosure and accessibility |
| Keep API mutation controls authenticated and use existing CSRF flow | UI changes must not expand client authority | Verified existing endpoints and auth behavior |
| Keep reduced-motion, focus states, escape-safe text rendering and mobile fallback | Usable keyboard/screen-reader/mobile interaction | WCAG 2.2 Focus Visible and robust UI practices |

## Existing API contract (verified in source)

- `GET /admin/api/overview?range=today|7d|30d` returns per-user `calls` and agent summaries. Non-admin callers receive only their own account.
- `GET /admin/api/summary?range=7d&userId=<selected-id>` returns selected user's aggregate and daily buckets (hourly when range = today). The backend ignores userId for non-admin callers and scopes to the current user.
- The SQL usage aggregator uses **Asia/Bangkok** day boundaries; missing elapsed day buckets are presented as zero, not invented.
- The comparison-table total includes the visible **account-status population**, not all historical accounts or unassigned usage. Filtering the table does not silently change that total.
- There is no new Durable Object, no new polling, and no new external dependency.

## Verification and still-open usability questions

Automated checks: function/unit and auth/smoke tests; Chrome screenshots and interactions across Admin/User and desktop/mobile; viewport overflow; console errors; per-user total versus 7 daily buckets; Node/Cloudflare dry-run, dependency audit, hardening. These verify correctness, **not** user preference or task ease.

In a user review, compare the old and new UI with the same three tasks: (1) identify the highest-usage person today; (2) find an individual person's total and each daily value for 7 days; (3) find and refine a memory with review evidence. Record task success, time, errors and comments. If any task is slower or less clear, revise before shipping.

## Sources

- IBM Carbon Design System, Data Table: https://carbondesignsystem.com/components/data-table/usage/
- GOV.UK Design System, Table: https://design-system.service.gov.uk/components/table/
- Nielsen Norman Group, Progressive Disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- W3C WCAG 2.2, Focus Visible: https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html

The navigation layout, color palette, exact density and scope drawer are design hypotheses; cited sources support general usability principles, **not** proof that this particular layout is superior to the previous one.
