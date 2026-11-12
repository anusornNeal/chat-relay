# REL-38 UX decision record — Chat Relay

**Status:** Local feature-branch prototype for user review (not yet released).

## User research / requirements

The primary task is to compare **Tool Calls per person** for Today, the last 7 calendar days, and the last 30 calendar days. A user must be able to check the number used on each day. My Learn focuses on reviewing quality, using feedback and usage evidence. Admin and ordinary users matter equally. Desktop is the primary workspace, with mobile still functional.

These are user-provided requirements, not assumptions from analytics.

## Decisions and supporting reasons

| Decision | User task / rationale | Evidence or type |
|---|---|---|
| Start on **Overview**, with a compact persistent **left sidebar**: Overview → Usage → My Learn for admin | Preserve familiar navigation order, place the most frequently used destinations at stable left positions | User feedback + Vercel Feb 2026 navigation changelog; layout itself is a hypothesis |
| Show **Tool Calls** explicitly and only | Avoid confusing tool invocations with HTTP requests, tokens, or Cloudflare compute | Confirmed requirement and existing Usage API metric |
| Show a **compact period total** immediately followed by a sortable **per-person numerical table**, fully above the first desktop fold | Answer usage questions without scrolling past decorative headings or a large KPI hero | Explicit user correction + Carbon/GOV.UK data-table guidance |
| Default sort: most Tool Calls first; offer name sorting and search | Answer “who used the most?” immediately, find a known person or agent quickly | User task and design hypothesis |
| Choose Today / 7 days / 30 days with visible BKK date boundaries | Prevent ambiguous rolling-window interpretations | Existing API semantics: Asia/Bangkok midnight; 7d includes today plus six preceding days |
| Use **the exact Overview chart renderer** for Today by hour, **seven labeled bars** for 7 days, and an exact-value table for 30 days | Preserve chart consistency and legibility; avoid long hourly tables | Explicit user feedback, verified by real browser screenshot and UI test |
| Hide Agent and Performance details behind named disclosures | These are useful but not the primary task | Progressive disclosure / focus on main task |
| Fetch selected-user summary **on demand**, cached per user+range | Avoid N+1 calls and unexpected Durable Object load | Verified endpoint contracts; performance constraint |
| **Normal users see Overview + My Learn only**; their personal Tool Calls and trend are already on Overview, avoiding duplicate Usage | Remove redundant navigation and decisions without hiding their usage information | Explicit user feedback + existing backend role scoping |
| Make the Learn default a **Review Desk** while keeping the **Folder Explorer visible at all times** on desktop | Preserve project/global/agent context and Shared Learn discovery alongside feedback and refinement | Explicit user correction after reviewing the prior hidden drawer |
| Keep Learn Search visible; allow filtering by scope/group when needed | Find a memory without entering a permanent folder-tree hierarchy | Progressive disclosure and accessibility |
| Keep API mutation controls authenticated and use existing CSRF flow | UI changes must not expand client authority | Verified existing endpoints and auth behavior |
| Use **neutral surfaces with a restrained indigo accent**, less text and no `Share of listed` | Reduce competing emphasis and remove a metric the user said has no value | Explicit user feedback; palette is a testable design hypothesis |\n| Keep focus states, escape-safe text rendering and mobile fallback | Usable keyboard/screen-reader/mobile interaction | WCAG 2.2 Focus Visible and robust UI practices |

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

## Navigation and glanceability references

- Vercel, new navigation default (26 Feb 2026): https://vercel.com/changelog/dashboard-navigation-redesign-rollout
- Stripe, Connect Overview: https://docs.stripe.com/connect/dashboard/understand-your-connect-business
- NN/g, complex application design: https://www.nngroup.com/articles/complex-application-design/
- NN/g, charts and graphs on dashboards: https://www.nngroup.com/articles/dashboards-preattentive/

These are design references, not claims that copying their appearance guarantees better task performance. This round deliberately removes redundant controls and text rather than adding new dashboard features.
