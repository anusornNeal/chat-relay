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
| Reuse the Overview chart for all ranges: Today shows 24 hours, Usage 7d shows **six four-hour averages per day across seven calendar days**, and 30d shows daily bars | Preserve one visual language while showing a useful, accurate hourly usage pattern over a full week | Confirmed user feedback + recorded hourly SQL data |
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

## Feedback round: 6 production-facing refinements

1. **Overview:** remove the admin User dropdown and selected-user state/API parameter entirely. This page is the system overview; per-user comparison belongs in Usage.
2. **Usage density:** keep the same three-column table, bound its maximum width and center it. Fill the numeric column with a subtle Tool Calls magnitude track (relative to the largest listed user, without a redundant percent). No added API requests.
3. **Agent online state:** display a small Online/Offline indicator only when the source returns an explicit boolean. A missing runtime status is shown as 'Status unavailable', not falsely labeled Offline. The admin API uses tri-state for agents excluded from bounded online lookups.
4. **Range consistency:** 30d keeps its 30 daily bars with sparse five-day labels; 7d now shows six 4-hour average bars calculated from real recorded hourly usage across seven days. Exact 4-hour totals and averages are available via accessible tooltip and labels.
5. **Linked details:** Agents and Performance expand or collapse together from either header. State is independent for each account and retained on time-range rerenders.
6. **My Learn:** remove the duplicate Name/Updated/Usage Score sort strip. Actual column headings are keyboard-accessible buttons with direction indicators; explicit sorting overrides default review-priority ordering. Folder Explorer remains visible on desktop.

Browser QA should verify 19 admin/user screens, Today/7d/30d values, linked detail panels, both known online/offline statuses, and absence of the Overview dropdown. All changes remain on the local REL-38 feature branch pending design review.

### Shared chart correction

All three range options (**Today**, **7 days**, **30 days**) in the Usage expansion now call the same `chartMarkup()` renderer used by Overview, via `renderActivityChart()`. Removed the separate `daily-bars` implementation entirely. X-axis labels adapt to the active interval (3-hour ticks, every day, or every five days). Fixed a CSS grid defect that assigned a second independent height to the expanded chart plot and bars, causing a visibly floating zero baseline. Headless Chrome measured the final bar-to-plot baseline gap at 1px and the zero tick gap at 0px for all three ranges, with 24, 7 and 30 slots originally; the reviewed 7d per-user view now uses 6 four-hour average slots. No new HTTP request or external charting library was added.

### 7-day average and trailing chevron

The 7-day **per-user Usage** drill-down groups recorded hourly SQL counts into six Bangkok-local 4-hour windows: 00:00–04:00 through 20:00–24:00. Each bar represents (the number of Tool Calls in that window across all seven calendar days) / 7. Today is included, so unelapsed hours today contribute zero. The overall 7-day Tool Calls total remains unchanged. Overview's existing 7d trend remains daily. One additional query parameter (`profile=4h`) on the **existing, authorized selected-user summary** requests the profile; it does not trigger another HTTP call. The SQL grouping reuses the existing detail aggregation scan, then reduces its six-window rows back into exact daily totals. Fallback/legacy data without recorded hourly detail shows 'Hourly averages unavailable' instead of inventing a distribution.

The user-row Chevron moved to the far-right cell after the Agents count; the entire row remains pointer-clickable with its name button as the keyboard control. The six wide bars deliberately use the same `chartMarkup` renderer and zero baseline as Today and 30d, with a wider bar style only for the six-window display.
