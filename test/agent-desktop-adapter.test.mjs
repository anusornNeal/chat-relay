import test from "node:test";
import assert from "node:assert/strict";
import { AgentDesktopAdapter } from "../agent/agent-desktop-adapter.mjs";

test("headless adapter sends only scoped CLI commands", async () => {
  const seen = [];
  const adapter = new AgentDesktopAdapter({ execute: async (_binary, args, opts) => {
    seen.push({ args, opts });
    return { stdout: JSON.stringify({ ok: true, data: { done: true } }) };
  } });
  assert.equal((await adapter.snapshot({ app: "Notepad" })).ok, true);
  assert.equal((await adapter.click({ ref: "@s123:e8" })).ok, true);
  assert.equal((await adapter.setValue({ ref: "@s123:e9", value: "hello" })).ok, true);
  await adapter.status();
  assert.deepEqual(seen.map(x => x.args), [
    ["snapshot", "--app", "Notepad", "-i", "--compact"],
    ["click", "@s123:e8"],
    ["set-value", "@s123:e9", "hello"],
    ["status"],
  ]);
  assert.ok(seen.every(x => !x.args.includes("--headed")));
});
test("invalid input never executes a command", async () => {
  const adapter = new AgentDesktopAdapter({ execute: () => { throw Error("must not execute"); } });
  assert.equal((await adapter.click({ ref: "@e9" })).error.code, "INVALID_REF");
  assert.equal((await adapter.snapshot({ app: "--headed" })).error.code, "INVALID_APP");
  assert.equal((await adapter.setValue({ ref: "@s1:e1", value: 12 })).error.code, "INVALID_INPUT");
});
test("optional dependency missing fails closed", async () => {
  const adapter = new AgentDesktopAdapter({ execute: async () => { const error = Error("missing"); error.code = "ENOENT"; throw error; } });
  assert.equal((await adapter.status()).error.code, "NOT_INSTALLED");
});
test("invalid JSON never leaks private desktop output", async () => {
  const adapter = new AgentDesktopAdapter({ execute: async () => ({ stdout: "private information" }) });
  assert.deepEqual(await adapter.status(), { ok: false, error: { code: "EXECUTION_FAILED" } });
});
