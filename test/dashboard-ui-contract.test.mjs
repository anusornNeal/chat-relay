import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createUsageWorkspace } from "../dashboard/usage-workspace.js";

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
  assert.match(usage, /hasTimeline \? timeline\.buckets/);
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
  assert.match(app,/renderActivityChart: \(buckets, period, options = \{\}\) => chartMarkup/);
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
  assert.match(usage, /hasTimeline \? timeline\.buckets/);
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
  assert.equal((usage.match(/renderActivityChart\(/g) || []).length, 1);
  assert(usage.includes('renderActivityChart'), "Usage reuses the Overview renderer");
  assert.doesNotMatch(usage, /daily-bars|daily-column|renderHourlyChart|toolCallSeries/);
  assert(!css.includes(".ledger-activity-chart .chart-plot{height:"), "plot uses the grid height");
  assert(!css.includes(".ledger-activity-chart .chart-bars{height:"), "bars share the plot baseline");
});

test("clicking anywhere on a user row expands it exactly once, while the name remains keyboard-accessible", () => {
  assert.match(usage, /document\.querySelectorAll\("\.ledger-person-row"\)\.forEach\(\(row\) =>/);
  assert.match(usage, /row\.onclick = \(\) =>/);
  assert.match(usage, /row\.querySelector\("\[data-ledger-user\]"\)/);
  assert.doesNotMatch(usage, /document\.querySelectorAll\("\[data-ledger-user\]"\)\.forEach/);
  assert.match(usage, /aria-expanded/);
  assert.match(css, /\.ledger-person-row\{cursor:pointer\}/);
});

test("7d selected user chart retains all seven dates with six recorded four-hour buckets each", () => {
  const aggregates = readFileSync(new URL("../src/usage-aggregates.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(usage, /range === "7d" \? "&profile=4h"/);
  assert.match(usage, /timeline\.buckets\.length === 42/);
  assert.match(app, /profile4h \? items : chartDisplayBuckets/);
  assert.match(app, /chart-profile-4h/);
  assert.match(aggregates, /fourHourRows/);
  assert.match(aggregates, /profile4h \? \{/);
  assert.match(routes, /selectedUserId\)\)/);
  assert.match(css, /\.chart-profile-4h \.bar-fill/);
  assert.match(usage, /ledger-row-chevron/);
  assert.match(aggregates, /length: 42/);
  assert.match(app, /Array.from\(\{ length: 7 \}/);
  assert.match(css, /\.chart-tooltip\{top:14px;bottom:auto/);
  assert.doesNotMatch(app + usage, /avg calls\/day|hourlyAverage|averageProfile/);
  assert.doesNotMatch(usage, /icon\("chevron"\) \+ '<\/button>/);
});


test("Usage limits initial rows to ten, reveals more without refetching, and highlights only online agents", async () => {
  const accounts = Array.from({length: 12}, (_, i) => ({
    userId: "user-" + i,
    name: "Member " + String(i).padStart(2, "0"),
    login: "member" + i + "@example.test",
    calls: i * 10,
    agents: i === 11 ? [{agentId: "a11", online: true}] :
      i === 10 ? [{agentId: "a10", online: false}] :
      i === 9 ? [{agentId: "a09", online: null}] : [],
  }));
  let markup = "";
  let moreButton = null;
  let requests = 0;
  const search = {value: "", oninput: null};
  const sortName = {dataset: {ledgerSort: "name"}, onclick: null};
  const fakeDocument = {
    getElementById: (id) => id === "usageSearch" ? search : null,
    querySelector: (selector) => {
      if (selector !== "[data-ledger-show-more]" || !markup.includes("data-ledger-show-more")) return null;
      moreButton = {onclick: null};
      return moreButton;
    },
    querySelectorAll: (selector) => selector === "[data-ledger-sort]" ? [sortName] : [],
  };
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const workspace = createUsageWorkspace({
      api: async (url) => {
        assert.match(url, /^\/admin\/api\/overview\?/);
        requests++;
        return {period: {range: "today"}, accounts};
      },
      renderContent: (html) => { markup = html; },
      setHeader: () => {},
      setNotice: () => {},
      isAdmin: () => true,
      isActive: () => true,
      getCurrentUser: () => ({id: "admin"}),
      getRange: () => "today",
      setRange: () => {},
      setPeriod: () => {},
      periodChips: () => "",
      periodDisplayLabel: () => "Today",
      icon: () => "",
      esc: (value) => String(value ?? ""),
      fmtNum: (value) => String(value),
      fmtMs: () => "",
      fmtPct: () => "",
      renderActivityChart: () => "",
    });
    const names = () => [...markup.matchAll(/class="ledger-person-name"><strong>([^<]+)/g)].map((match) => match[1]);
    const rankClasses = () => [...markup.matchAll(/class="ledger-rank([^"]*)" aria-hidden="true"/g)].map((match) => match[1]);

    await workspace.load();
    assert.deepEqual(names(), Array.from({length: 10}, (_, i) => "Member " + String(11 - i).padStart(2, "0")));
    assert.deepEqual(rankClasses(), [" online", "", "", "", "", "", "", "", "", ""]);
    assert.match(markup, /aria-label="Show Tool Calls activity for Member 11 \(agent online\)"/);
    assert.match(markup, /Show more \(2\)/);
    assert.match(markup, /TOTAL · 12 users/);
    assert.equal(requests, 1);

    moreButton.onclick();
    assert.equal(names().length, 12);
    assert.equal(names().at(-1), "Member 00");
    assert.doesNotMatch(markup, /data-ledger-show-more/);
    assert.equal(requests, 1, "Show more must not request any additional data");

    search.value = "Member";
    search.oninput();
    assert.equal(names().length, 10, "Searching resets pagination");
    assert.match(markup, /Show more \(2\)/);

    sortName.onclick();
    assert.equal(names().length, 10, "Sorting resets pagination");
    assert.equal(names()[0], "Member 00");
    assert.equal(requests, 1);
    assert.match(css, /\.ledger-rank\.online\{/);
    assert.match(css, /\.ledger-person-row td:last-child/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
