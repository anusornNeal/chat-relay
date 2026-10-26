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
  assert.match(content, /🧠 Load relevant Learn context/);
  assert.match(content, /chat-relay · Learn/);
  assert.match(content, /Error: Test failed/);
  assert.match(content, /running/);
  assert.match(content, /9 operations/);
  assert.match(content, /Offline preview/);
  assert.match(content, /Ctrl\+C Exit/);
  assert.doesNotMatch(content, /Q Quit|↑\s*\d|↓\s*\d/);
  assert.doesNotMatch(content, /● ONLINE|● Connected|● LIVE/);
  assert.doesNotMatch(content, /\x1b\[/);
});

test("snapshot is bounded across tiny, compact and wide terminal sizes", () => {
  for (const [width, height] of [[28, 7], [44, 12], [72, 18], [80, 24], [120, 30], [180, 36], [220, 36], [320, 36], [480, 50]]) {
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
  // Transfer telemetry remains available to the agent but is not rendered.
  assert.equal(tui.transactions[0].requestBytes, 6800);
  assert.equal(tui.transactions[0].responseBytes, 330);
  assert.equal(tui.transactions.filter((item) => item.status === "running").length, 1);
  assert.equal(tui.transactions.filter((item) => item.ok === false).length, 1);
  assert.equal(tui.transactions.find((item) => item.operation === "Review terminal batch results")?.project, "flowly");
  assert.equal(tui.transactions.find((item) => item.project === "Multiple projects")?.category, "Filesystem");
  assert.equal(tui.transactions.find((item) => item.action === "learn_prepare")?.category, "Learn");
  tui.render();
  assert.match(frames.at(-1), /SkillAdminOverview\.tsx/);
  assert.doesNotMatch(frames.at(-1), /↑\s*\d|↓\s*\d/);
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

test("interactive demo ignores Q and exits with Ctrl+C, restoring input and screen", async () => {
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
  input.emit("data", Buffer.from("Q"));
  assert.equal(input.isRaw, true, "Q must not quit the preview accidentally");
  assert.equal(input.listenerCount("data"), 1);
  assert.ok(!writes.some((chunk) => chunk.includes("\x1b[?1049l")));
  input.emit("data", Buffer.from("\x03"));
  const result = await running;
  assert.equal(result, 0);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount("data"), 0);
  assert.ok(writes.some((chunk) => chunk.includes("\x1b[?1049h")));
  assert.ok(writes.some((chunk) => chunk.includes("\x1b[?1049l")));
  assert.ok(writes.some((chunk) => chunk.includes("◈ DEMO")));
});

test("styled demo uses muted project labels and hides transfer sizes", () => {
  const frames = [];
  const tui = new RemoteTui({
    config: buildDemoConfig(), demo: true, version: "demo-test",
    output: { isTTY: true, columns: 120, rows: 30, write: (text) => frames.push(String(text)) },
    input: { isTTY: false }, env: { TERM: "xterm-256color" },
  });
  seedDemo(tui, { now: Date.parse("2026-10-26T12:00:00Z") });
  tui.render();
  const styled = frames.at(-1);
  assert.match(styled, /\x1b\[38;2;128;145;164mflowly\x1b\[0m/, "project should use subdued slate");
  assert.doesNotMatch(styled, /\x1b\[38;2;93;218;203mflowly\x1b\[0m/, "project should not use bright accent");
  const plain = styled.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /flowly · Filesystem/);
  assert.doesNotMatch(plain, /↑\s*\d|↓\s*\d/, "transaction sizes must not clutter the display");
  assert.doesNotMatch(plain, /Q Quit/);
  assert.match(plain, /Ctrl\+C Exit/);
  tui.stop();
});

test("fullscreen snapshot fills available columns without a right-side blank strip", () => {
  for (const columns of [180, 220, 320, 480]) {
    const screen = renderDemoSnapshot({ width: columns, height: 36, now: Date.parse("2026-10-26T12:00:00Z") });
    const lines = screen.split("\n");
    const divider = lines.find((line) => line.startsWith("─"));
    const header = lines.find((line) => line.includes("TIME") && line.includes("OPERATION") && line.includes("DURATION"));
    assert.equal(terminalCellWidth(divider), columns - 1, "divider must reach the rightmost safe column");
    assert.equal(terminalCellWidth(lines[0]), columns - 1, "DEMO indicator must align with the right edge");
    assert.ok(header.indexOf("DURATION") >= columns - 12, "duration column should track viewport width");
    assert.ok(lines.some((line) => line.endsWith("9 operations")), "activity counter should align right");
    assert.ok(lines.at(-1).endsWith("◈ Offline preview"), "footer should align right");
    assert.ok(lines.every((line) => terminalCellWidth(line) <= columns - 1));
  }
});

test("resizing fullscreen TUI redraws across the entire new width", () => {
  const writes = [];
  const output = { isTTY: true, columns: 96, rows: 34, write: (value) => writes.push(String(value)) };
  const tui = new RemoteTui({
    config: buildDemoConfig(), version: "demo-test", demo: true, output,
    input: { isTTY: false }, env: { NO_COLOR: "1" },
  });
  seedDemo(tui, { now: Date.parse("2026-10-26T12:00:00Z") });
  tui.render();
  assert.equal(tui.viewportMetrics().width, 95);
  output.columns = 260;
  tui.render();
  assert.equal(tui.viewportMetrics().width, 259);
  const enlarged = writes.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  assert.ok(enlarged.split("\n").some((line) => terminalCellWidth(line) === 259));
  assert.match(enlarged, /Review Git status/);
  output.columns = 76;
  tui.render();
  assert.equal(tui.viewportMetrics().width, 75);
  const narrowed = writes.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  assert.ok(narrowed.split("\n").every((line) => terminalCellWidth(line) <= 75));
  tui.stop();
});
