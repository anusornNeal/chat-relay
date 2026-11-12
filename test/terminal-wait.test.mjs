import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentCapabilities } from "../agent/protocol.mjs";
import { CapabilityScheduler } from "../agent/capability-scheduler.mjs";
import { TerminalManager } from "../agent/terminal-manager.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
const command = (delayMs, output, trailingMs = 0) => windows
  ? `Start-Sleep -Milliseconds ${delayMs}; Write-Output ${output}${trailingMs ? `; Start-Sleep -Milliseconds ${trailingMs}` : ""}`
  : `sleep ${delayMs / 1000}; echo ${output}${trailingMs ? `; sleep ${trailingMs / 1000}` : ""}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("wait-on-output uses a separate lane so terminal control remains responsive", async () => {
  const scheduler = new CapabilityScheduler({ terminalControlConcurrency: 1, terminalWaitConcurrency: 1 });
  assert.equal(scheduler.snapshot().terminalWait.maxQueued, 2);
  assert.equal(scheduler.snapshot().terminalWait.queueTimeoutMs, 1000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = scheduler.run("terminal.read.wait", async () => gate);
  try {
    await sleep(0);
    assert.equal(scheduler.snapshot().terminalWait.active, 1);
    const control = await Promise.race([
      scheduler.run("terminal.kill", () => "control-ready"),
      sleep(500).then(() => { throw new Error("terminal_control_starved_by_wait"); }),
    ]);
    assert.equal(control, "control-ready");
  } finally {
    release("wait-finished");
  }
  assert.equal(await waiting, "wait-finished");
  await sleep(0); // The lane releases its slot in a promise-finally microtask.
  assert.equal(scheduler.snapshot().terminalWait.active, 0);
});

test("terminal wait advertised only for terminal-enabled agents", () => {
  assert(getAgentCapabilities({ terminalEnabled: true }).includes("terminal.read.wait"));
  assert(!getAgentCapabilities({ terminalEnabled: false }).includes("terminal.read.wait"));
});

test("default read stays immediate and waiting rejects invalid values", async () => {
  const manager = new TerminalManager({ fastExec: false });
  const session = manager.start(command(1600, "TOO_LATE"), cwd);
  try {
    const started = Date.now();
    const result = await manager.readWithWait(session.sessionId, 0, 8192);
    assert.equal(result.status, "running");
    assert.equal(result.chunks.length, 0);
    assert(Date.now() - started < 400);
    for (const value of [-1, 15001, 1.2, Number.NaN, "100"]) {
      await assert.rejects(manager.readWithWait(session.sessionId, 0, 8192, value), /invalid_wait_ms/);
    }
    const missing = await manager.readWithWait("missing-session", 0, 8192, 500);
    assert.equal(missing.error, "session_not_found");
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
  } finally {
    await manager.kill(session.sessionId);
    manager.close();
  }
});

test("wait wakes on new stdout and then on session exit without stale listeners", async () => {
  const manager = new TerminalManager({ fastExec: false });
  const session = manager.start(command(450, "OUTPUT_ARRIVED", 500), cwd);
  try {
    const started = Date.now();
    const output = await manager.readWithWait(session.sessionId, 0, 8192, 3500);
    const text = output.chunks.map((chunk) => chunk.text).join("");
    assert.match(text, /OUTPUT_ARRIVED/);
    assert(Date.now() - started < 3400);
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
    let cursor = output.nextSeq;
    let exited;
    for (let attempt = 0; attempt < 6; attempt++) {
      exited = await manager.readWithWait(session.sessionId, cursor, 8192, 3500);
      cursor = exited.nextSeq;
      if (exited.status !== "running") break;
    }
    assert.equal(exited.status, "exited");
    assert.equal(exited.exitCode, 0);
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
    const immediate = await manager.readWithWait(session.sessionId, 0, 8192, 3500);
    assert(immediate.chunks.length > 0);
  } finally {
    await manager.kill(session.sessionId);
    manager.close();
  }
});

test("wait timeout returns a running snapshot and drops its listener", async () => {
  const manager = new TerminalManager({ fastExec: false });
  const session = manager.start(command(1600, "LATE_OUTPUT"), cwd);
  try {
    const started = Date.now();
    const result = await manager.readWithWait(session.sessionId, 0, 8192, 125);
    const elapsed = Date.now() - started;
    assert(elapsed >= 100 && elapsed < 1000, `elapsed=${elapsed}`);
    assert.equal(result.status, "running");
    assert.equal(result.chunks.length, 0);
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
  } finally {
    await manager.kill(session.sessionId);
    manager.close();
  }
});

test("waiters are bounded per session and close resolves outstanding waits", async () => {
  const manager = new TerminalManager({ fastExec: false });
  const session = manager.start(command(1700, "LATE_OUTPUT"), cwd);
  try {
    const waiters = Array.from({ length: 8 }, () => manager.readWithWait(session.sessionId, 0, 8192, 500));
    await assert.rejects(manager.readWithWait(session.sessionId, 0, 8192, 500), /too_many_terminal_waiters/);
    manager.close();
    const results = await Promise.all(waiters);
    assert.equal(results.length, 8);
    assert(results.every((result) => result.status === "running" || result.status === "exited"));
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
    await sleep(100);
    assert.equal(manager.sessions.get(session.sessionId).waiters.size, 0);
  } finally {
    await manager.kill(session.sessionId);
    manager.close();
  }
});
