import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const html = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../dashboard/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const usage = readFileSync(new URL("../dashboard/usage-workspace.js", import.meta.url), "utf8");

test("dashboard has one small, self-contained design system", () => {
  assert.match(css, /--accent:#5263dc/);
  assert.match(css, /--line:#e2e8f3/);
  assert.match(css, /font-family:"Segoe UI"/);
  assert.doesNotMatch(css, /@import|cdn.jsdelivr.net/);
  assert.equal((css.match(/^\.ux-usage-workspace\{/gm) || []).length, 1, "one base investigation layout");
  assert(!css.includes(".learn-detail-more{"), "remove styling for an inert control");
  assert(Buffer.byteLength(css, "utf8") < 51_000, "prevent uncompressed CSS bloat");
  assert(gzipSync(css).length < 12_000, "keep CSS transfer lightweight");
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
  assert.match(usage, /const totalCalls = accounts\.reduce/);
});

test("Review and investigation handlers cannot retain stale selection after DOM patch", () => {
  assert.match(app, /if \(refineMemory\) refineMemory\.onclick/);
  assert.match(app, /const current = \(learnProfileSnapshot\?\.items \|\| \[\]\)\.find/);
  assert.doesNotMatch(app, /learnRefineMemory"\)\?\.addEventListener/);
  assert.match(usage, /if \(inspectMetrics\) inspectMetrics\.onclick/);
  assert.match(usage, /if \(openTimeline\) openTimeline\.onclick/);
  assert.match(usage, /if \(sequence !== loadSequence\) return/);
});
