import assert from "node:assert/strict";
import test from "node:test";

import { DailyOptionalBudget, normalizeOptionalBudget } from "../src/usage-budget.mjs";

test("optional budget is disabled by default without consuming capacity", () => {
  const budget = new DailyOptionalBudget();
  const first = budget.consume(undefined, Date.parse("2026-10-04T00:00:00Z"));
  const second = budget.consume("0", Date.parse("2026-10-04T00:01:00Z"));
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.enabled, false);
  assert.equal(second.used, 0);
  assert.equal(second.suppressed, 0);
});

test("optional budget suppresses work after its configured daily limit", () => {
  const budget = new DailyOptionalBudget();
  const now = Date.parse("2026-10-04T10:00:00Z");
  assert.equal(budget.consume("2", now).allowed, true);
  assert.equal(budget.consume("2", now + 1).allowed, true);
  const blocked = budget.consume("2", now + 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 2);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.suppressed, 1);
});

test("optional budget resets on the next UTC day", () => {
  const budget = new DailyOptionalBudget();
  assert.equal(budget.consume(1, Date.parse("2026-10-04T23:59:59Z")).allowed, true);
  assert.equal(budget.consume(1, Date.parse("2026-10-04T23:59:59.500Z")).allowed, false);
  const nextDay = budget.consume(1, Date.parse("2026-10-05T00:00:00Z"));
  assert.equal(nextDay.allowed, true);
  assert.equal(nextDay.used, 1);
  assert.equal(nextDay.suppressed, 0);
});

test("budget normalization is bounded and opt-in", () => {
  assert.equal(normalizeOptionalBudget(undefined), 0);
  assert.equal(normalizeOptionalBudget(-1), 0);
  assert.equal(normalizeOptionalBudget("250"), 250);
  assert.equal(normalizeOptionalBudget(99_000_000), 10_000_000);
});
