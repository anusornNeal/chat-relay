import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const html = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../dashboard/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const usage = readFileSync(new URL("../dashboard/usage-workspace.js", import.meta.url), "utf8");

test("dashboard has one small, self-contained design system", () => {
  assert.match(css, /--accent:#4f46e5/);
  assert.match(css, /--line:#e5e7eb/);
  assert.match(css, /font-family:"Segoe UI"/);
  assert.doesNotMatch(css, /@import|cdn.jsdelivr.net/);
  assert.equal((css.match(/^\.ledger-table\{/gm) || []).length, 1, "one primary comparison table");
  assert(!css.includes(".learn-detail-more{"), "remove styling for an inert control");
  assert(Buffer.byteLength(css, "utf8") < 64_000, "prevent uncompressed CSS bloat");
  assert(gzipSync(css).length < 16_000, "keep CSS transfer lightweight");
});

test("navigation and content remain accessible without creating redundant live announcements", () => {
  assert.match(html, /<nav id="nav" aria-label="Dashboard navigation"/);
  assert.match(html, /<section id="content" aria-label="Dashboard content"/);
  assert.doesNotMatch(html, /id="content"[^>]*aria-live="polite"/);
  assert.match(app, /aria-current/);
  assert.match(app, /aria-pressed/);
  assert.match(css, /\.learn-detail-radio input\{[^}]*inline-size:1px/);
  assert.match(css, /\.learn-tree-row\{[^}]*align-items:start/);
});

test("mock data is isolated from production assets and all data actions use existing API", () => {
  assert.doesNotMatch(html, /mock-socket|LOCAL MOCK|overhaul\.css/);
  assert.doesNotMatch(app + usage, /mock-socket|LOCAL MOCK/);
  assert.match(html, /\/admin\/google\/start/);
  assert.match(app, /\/admin\/api\/summary/);
  assert.match(usage, /\/admin\/api\/overview/);
  assert.match(app, /\/admin\/api\/learn/);
  assert.doesNotMatch(app, /overview-user-filter|overviewUserId/);
  assert.match(app, /const esc = /);
  assert.match(app, /credentials: "same-origin"/);
  assert.match(app, /"x-csrf-token"/);
  assert.match(usage, /const total = accounts\.reduce/);
});

test("Review and investigation handlers cannot retain stale selection after DOM patch", () => {
  assert.match(app, /if \(refineMemory\) refineMemory\.onclick/);
  assert.match(app, /const current = \(learnProfileSnapshot\?\.items \|\| \[\]\)\.find/);
  assert.doesNotMatch(app, /learnRefineMemory"\)\?\.addEventListener/);
  assert.match(usage, /data-ledger-user/);
  assert.match(usage, /expandedIds\.has\(account\.userId\)/);
  assert.match(usage, /renderActivityChart\(summary\.buckets/);
  assert.doesNotMatch(usage, /data-ledger-refresh|data-ledger-timeline/);
  assert.match(usage, /if \(sequence !== loadSequence\) return/);
});

test("Overview is first, normal users have no redundant Usage page", () => {
  assert.match(app, /\[\["overview", "Overview", "overview"\], \["usage", "Usage", "activity"\]/);
  assert.match(app, /\[\["overview", "Overview", "overview"\], \["learn", "My Learn", "info"\]\]/);
  assert.match(app, /if \(!navItems\(\)\.some\(\(\[id\]\) => id === activeView\)\) activeView = "overview"/);
  assert.doesNotMatch(usage, /SHARE OF LISTED|100% of listed Tool Calls/);
  assert.match(usage, /renderActivityChart/);
  assert.doesNotMatch(usage, /daily-bars|daily-column/);
  assert.match(usage, /data-ledger-metrics/);
  assert.match(usage, /ledger-agent-status/);
});

test("independent Usage details reuse Overview's hourly chart without redundant controls", () => {
  assert.match(usage,/const expandedIds = new Set\(\)/);
  assert.match(usage,/expandedIds\.add\(nextId\)/);
  assert.match(usage,/expandedIds\.delete\(nextId\)/);
  assert.match(usage,/const loadingKeys = new Set\(\)/);
  assert.match(usage,/const detailErrors = new Map\(\)/);
  assert.match(app,/renderActivityChart: \(buckets, period\) => chartMarkup\(buckets, period, \{showStats:false\}\)/);
  assert.doesNotMatch(usage,/data-ledger-refresh|data-ledger-timeline|Open overview/);
  assert.match(css,/\.learn-review-board>\.learn-folder-tree\{[\s\S]*?position:static/);
  assert.doesNotMatch(app,/id="learnScopeToggle"|id="learnSearchTop"/);
});

test("usage status and linked account panels are grounded and the Learn sort strip is gone", () => {
  assert.doesNotMatch(app, /overview-user-filter|overviewUserId/);
  assert.match(usage, /const expandedMetricsIds = new Set\(\)/);
  assert.match(usage, /data-ledger-metrics/);
  assert.match(usage, /agent\.online === true/);
  assert.match(usage, /agent\.online === false/);
  assert.match(usage, /Status unavailable/);
  assert.match(usage, /renderActivityChart\(summary\.buckets/);
  assert.doesNotMatch(usage, /daily-bars|daily-column/);
  assert.match(app, /learn-column-sort/);
  assert.match(app, /learnSortDirection/);
  assert.doesNotMatch(app, /class="learn-folder-sort"/);
});

test("Overview and Usage render Today/7d/30d with one zero-baseline chart", () => {
  assert.match(app, /function chartMarkup\(/);
  assert.match(app, /function chartDisplayBuckets\(/);
  for (const range of ['"today"','"7d"','"30d"']) {
    assert(app.includes(range), "shared chart must support " + range);
  }
  assert.equal(usage.split('renderActivityChart(summary.buckets || [], period)').length - 1, 1);
  assert(usage.includes('renderActivityChart'), "Usage reuses the Overview renderer");
  assert.doesNotMatch(usage, /daily-bars|daily-column|renderHourlyChart|toolCallSeries/);
  assert(!css.includes(".ledger-activity-chart .chart-plot{height:"), "plot uses the grid height");
  assert(!css.includes(".ledger-activity-chart .chart-bars{height:"), "bars share the plot baseline");
});
