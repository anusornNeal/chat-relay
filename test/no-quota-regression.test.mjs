import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const worker = await read("src/worker-app.ts");
const usage = await read("src/usage.ts");
const admin = await read("src/admin.ts");
const env = await read("src/env.ts");

for (const marker of ["enforceMcpQuota", "/quota/check", "quota_unavailable"]) {
  assert.equal(worker.includes(marker), false, `MCP hot path must not contain ${marker}`);
}

for (const marker of ["/quota/check", "/quota/policy", "quota:user:"]) {
  assert.equal(usage.includes(marker), false, `Usage DO must not contain ${marker}`);
}

for (const marker of ["/admin/api/limits", "policy.quota."]) {
  assert.equal(admin.includes(marker), false, `Admin API must not contain ${marker}`);
}

for (const marker of [
  "USER_RATE_LIMIT_PER_WINDOW",
  "USER_RATE_WINDOW_SECONDS",
  "USER_DAILY_CALL_QUOTA",
]) {
  assert.equal(env.includes(marker), false, `Runtime env must not contain ${marker}`);
}

console.log("no-quota regression test passed");
