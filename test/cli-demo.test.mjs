import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { renderDemoSnapshot, seedDemo, buildDemoConfig, runTuiDemo } from "../cli/demo.mjs";
import { RemoteTui, terminalCellWidth } from "../cli/tui.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = join(root, "bin", "chat-relay.js");

test("offline snapshot includes demo warning and varied project-aware activity", () => {
  const content = renderDemoSnapshot({ width: 120, height: 30, now: Date.parse("2026-10-26T12:00:00Z") });
  assert.match(content, /PREVIEW/);
  assert.match(content, /◈ DEMO/);
  assert.match(content, /◈ SAMPLE/);
  assert.match(content, /TIME\s+OPERATION\s+DURATION/);
  assert.match(content, /flowly · Filesystem/);
  assert.match(content, /chat-relay · Terminal/);
  assert.match(content, /Multiple projects · Filesystem/);
  assert.match(content, /buddy-android · Filesystem/);
  assert.match(content, /Review terminal batch results/);
  assert.match(content, /Error: Test failed/);
  assert.match(content, /running/);
  assert.match(content, /9 operations/);
  assert.match(content, /Offline preview/);
  assert.doesNotMatch(content, /● ONLINE|● Connected|● LIVE/);
  assert.doesNotMatch(content, /\x1b\[/);
});

test("snapshot is bounded across tiny, compact and wide terminal sizes", () => {
  for (const [width, height] of [[28, 7], [44, 12], [72, 18], [80, 24], [120, 30], [180, 36]]) {
    const screen = renderDemoSnapshot({ width, height, now: 1000 * 1000 * 1000 });
    const lines = screen.split("\n");
    assert.ok(lines.length <= height - 1, "rows overflowed at " + width + "x" + height);
    for (const line of lines) {
      assert.ok(terminalCellWidth(line) <= width - 1, "cells overflowed at " + width + "x" + height);
    }
    assert.match(screen, /DEMO/, "demo warning missing at " + width + "x" + height);
  }
});

test("sample events flow through the actual RemoteTui state machine", () => {
  const frames = [];
  const tui = new RemoteTui({
    config: buildDemoConfig(), demo: true, version: "demo-test",
    output: { isTTY: false, columns: 120, rows: 30, write: (text) => frames.push(text) },
    input: { isTTY: false }, env: { NO_COLOR: "1" },
  });
  seedDemo(tui, { now: Date.parse("2026-10-26T12:00:00Z") });
  assert.equal(tui.transactions.length, 9);
  assert.equal(tui.transactions.filter((item) => item.status === "running").length, 1);
  assert.equal(tui.transactions.filter((item) => item.ok === false).length, 1);
  assert.equal(tui.transactions.find((item) => item.operation === "Review terminal batch results")?.project, "flowly");
  assert.equal(tui.transactions.find((item) => item.project === "Multiple projects")?.category, "Filesystem");
  tui.render();
  assert.match(frames.at(-1), /SkillAdminOverview\.tsx/);
  tui.stop();
});

test("plain snapshots run via public CLI command from outside repo with no login", () => {
  const text = execFileSync(process.execPath, [command, "demo", "--snapshot", "--width=120", "--height=30"], {
    cwd: dirname(root), encoding: "utf8",
    timeout: 8000, windowsHide: true,
  });
  assert.match(text, /PREVIEW/);
  assert.match(text, /◈ DEMO/);
  assert.match(text, /Flowly|flowly/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("non-TTY demo is a one-shot plain snapshot without fetching network data", async () => {
  const chunks = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("demo must never fetch"); };
  try {
    const exitCode = await runTuiDemo({
      output: { isTTY: false, columns: 90, rows: 24, write: (value) => chunks.push(String(value)) },
      input: { isTTY: false },
    });
    assert.equal(exitCode, 0);
    assert.match(chunks.join(""), /◈ DEMO/);
    assert.doesNotMatch(chunks.join(""), /\x1b\[/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive demo supports scrolling and Q exit, restoring raw input and screen", async () => {
  class FakeInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.readableFlowing = false;
      this.paused = true;
    }
    setRawMode(value) { this.isRaw = value; }
    isPaused() { return this.paused; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
  }
  const input = new FakeInput();
  const writes = [];
  const output = { isTTY: true, columns: 120, rows: 30, write: (value) => writes.push(String(value)) };
  const running = runTuiDemo({ input, output, env: { NO_COLOR: "1" } });
  assert.equal(input.isRaw, true);
  input.emit("data", Buffer.from("\x1b[A"));
  input.emit("data", Buffer.from("\x1b[F"));
  input.emit("data", Buffer.from("q"));
  const result = await running;
  assert.equal(result, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.ok(writes.some((chunk) => chunk.includes("\x1b[?1049h")));
  assert.ok(writes.some((chunk) => chunk.includes("\x1b[?1049l")));
  assert.ok(writes.some((chunk) => chunk.includes("◈ DEMO")));
});
