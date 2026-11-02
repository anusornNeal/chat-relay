import test from "node:test";
import assert from "node:assert/strict";
import { AgentDesktopAdapter } from "../agent/agent-desktop-adapter.mjs";
import { DesktopManager } from "../agent/desktop-manager.mjs";

const ok = (command, data = {}) => ({
  stdout: JSON.stringify({ version: "2.5", ok: true, command, data }),
});

test("native CLI is invoked without shell, headed mode or new process service", async () => {
  const calls = [];
  const adapter = new AgentDesktopAdapter({ execute: async (binary, args, options) => {
    calls.push({ binary, args, options });
    return ok(args[0], args[0] === "snapshot"
      ? { app: "Notepad", ref_count: 1, snapshot_id: "s123", complete: true, tree: { role: "button", ref_id: "@s123:e1" } }
      : args[0] === "status" ? { version: "1.0.2", platform: "windows", state_root: "PRIVATE" } :
        { action: args[0], disposition: { delivery: "delivered_unverified", retry: "unsafe" } });
  }, executable: "native-test.exe" });

  assert.equal((await adapter.snapshot({ app: "Notepad" })).data.ref_count, 1);
  assert.equal((await adapter.click({ ref: "@s123:e8" })).ok, true);
  assert.equal((await adapter.setValue({ ref: "@s123:e9", value: "test" })).ok, true);
  assert.equal((await adapter.status()).data.version, "1.0.2");
  assert.ok(!JSON.stringify(await adapter.status()).includes("PRIVATE"));
  assert.deepEqual(calls.slice(0, 4).map((c) => c.args), [
    ["snapshot", "--app", "Notepad", "--interactive-only", "--compact", "--max-depth", "6"],
    ["click", "@s123:e8"],
    ["set-value", "@s123:e9", "test"],
    ["status"],
  ]);
  assert.ok(calls.every((c) => c.binary === "native-test.exe" &&
    c.options.shell === false && c.options.windowsHide === true &&
    !c.args.includes("--headed")));
});

test("flags, oversized values and malformed refs fail before execution", async () => {
  const adapter = new AgentDesktopAdapter({ execute: () => { throw Error("must not execute"); } });
  assert.equal((await adapter.click({ ref: "@e1" })).error.code, "INVALID_REF");
  assert.equal((await adapter.snapshot({ app: "--headed" })).error.code, "INVALID_APP");
  assert.equal((await adapter.snapshot({ app: "Notepad", maxDepth: 42 })).error.code, "INVALID_INPUT");
  assert.equal((await adapter.snapshot({ app: "Notepad", root: "--headed" })).error.code, "INVALID_REF");
  assert.equal((await adapter.setValue({ ref: "@s1:e1", value: "a".repeat(8193) })).error.code, "INVALID_INPUT");
  assert.equal((await adapter.executeAction({ operation: "mouse-click" })).error.code, "INVALID_OPERATION");
});

test("CLI failures preserve structured codes without leaking private messages", async () => {
  const adapter = new AgentDesktopAdapter({ execute: async () => {
    const error = Object.assign(new Error("PRIVATE STDERR"), {
      code: 2,
      stdout: JSON.stringify({
        ok: false, command: "click",
        error: { code: "STALE_REF", message: "PRIVATE DESKTOP CONTENT",
          disposition: { delivery: "not_delivered", retry: "safe" } },
      }),
    });
    throw error;
  } });
  const result = await adapter.click({ ref: "@s123:e8" });
  assert.deepEqual(result, { ok: false, error: { code: "STALE_REF", retry: "safe", delivery: "not_delivered" } });
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("missing native binary, bad output and dense tree fail closed", async () => {
  const missing = new AgentDesktopAdapter({ execute: async () => {
    throw Object.assign(new Error("private"), { code: "ENOENT" });
  } });
  assert.equal((await missing.status()).error.code, "NOT_INSTALLED");
  const malformed = new AgentDesktopAdapter({ execute: async () => ({ stdout: "PRIVATE" }) });
  assert.deepEqual(await malformed.status(), { ok: false, error: { code: "INVALID_OUTPUT" } });
  const huge = new AgentDesktopAdapter({ execute: async () => ok("snapshot", {
    app: "Notepad", ref_count: 999, snapshot_id: "s123", complete: true, tree: { name: "x".repeat(55_000) },
  }) });
  assert.equal((await huge.snapshot({ app: "Notepad" })).error.code, "RESULT_TOO_LARGE");
});

test("desktop_step semantic action is opt-in, isolated and still queued", async () => {
  let nativeCalls = 0;
  let physicalCalls = 0;
  const accessibilityAdapter = {
    executeAction: async (action) => {
      nativeCalls += 1;
      return { ok: true, backend: "agent-desktop", data: { action: action.operation } };
    },
  };
  const physicalRunner = async () => {
    physicalCalls += 1;
    return { ok: true };
  };
  const denied = new DesktopManager({ enabled: true, platform: "win32", runner: physicalRunner, accessibilityEnabled: false });
  assert.equal((await denied.step({ actions: [{ type: "accessibility", operation: "status" }] })).error, "accessibility_disabled");
  denied.close();

  const manager = new DesktopManager({
    enabled: true, platform: "win32", runner: physicalRunner,
    accessibilityEnabled: true, accessibilityAdapter,
  });
  const result = await manager.step({ actions: [{ type: "accessibility", operation: "snapshot", app: "Notepad" }] });
  assert.equal(result.ok, true);
  assert.equal(result.data.action, "snapshot");
  assert.equal(typeof result.timing.totalMs, "number");
  assert.equal(nativeCalls, 1);
  assert.equal(physicalCalls, 0);
  assert.equal((await manager.step({ actions: [
    { type: "accessibility", operation: "click", ref: "@s123:e1" },
    { type: "click", x: 10, y: 10 },
  ] })).error, "invalid_accessibility_step");
  assert.equal((await manager.step({ actions: [
    { type: "accessibility", operation: "status" },
  ], captureAfter: true })).error, "invalid_accessibility_step");
  assert.equal(nativeCalls, 1);
  assert.equal((await manager.step({ actions: [{ type: "wait", ms: 5 }] })).ok, true);
  assert.equal(physicalCalls, 1);
  manager.close();
});

test("desktop disabled still blocks semantic backend regardless of opt-in", async () => {
  const manager = new DesktopManager({
    enabled: false, platform: "win32", runner: async () => ({ ok: true }),
    accessibilityEnabled: true, accessibilityAdapter: { executeAction: () => ({ ok: true }) },
  });
  assert.equal((await manager.step({ actions: [{ type: "accessibility", operation: "status" }] })).error, "desktop_disabled");
  manager.close();
});
