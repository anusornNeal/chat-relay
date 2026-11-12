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
  assert.match(app, /encodeURIComponent\(overviewUserId\)/);
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
  assert.match(usage, /data-ledger-timeline/);
  assert.match(usage, /if \(sequence !== loadSequence\) return/);
});

test("Overview is first, normal users have no redundant Usage page", () => {
  assert.match(app, /\[\["overview", "Overview", "overview"\], \["usage", "Usage", "activity"\]/);
  assert.match(app, /\[\["overview", "Overview", "overview"\], \["learn", "My Learn", "info"\]\]/);
  assert.match(app, /if \(!navItems\(\)\.some\(\(\[id\]\) => id === activeView\)\) activeView = "overview"/);
  assert.doesNotMatch(usage, /SHARE OF LISTED|100% of listed Tool Calls/);
  assert.match(usage, /daily-bars/);
  assert.match(usage, /daily-table/);
});
