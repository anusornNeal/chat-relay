import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("disconnected or timed-out in-flight tool calls have explicit unknown execution state", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /pending\.resolve\(error\(status, code, \{ executionStatus: "unknown", retrySafe: false \}\)\)/);
  assert.match(src, /resolve\(error\(504, "agent_timeout", \{ executionStatus: "unknown", retrySafe: false \}\)\)/);
  assert.doesNotMatch(src, /agent\.send\([\s\S]*?\bcancel.*?retry\(/);
});
