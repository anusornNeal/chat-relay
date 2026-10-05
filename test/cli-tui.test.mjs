import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { humanizeToolCall } from "../agent/toolcall-summary.mjs";
import { RemoteTui, formatTransactionRow, formatTransactionRows, formatTwoColumnHeader, shouldUseColor, shouldUseTui, terminalCellWidth } from "../cli/tui.mjs";

test("humanizes filesystem and terminal calls without file contents", () => {
  assert.equal(
    humanizeToolCall({ action: "fs.read", path: "C:\\Users\\tatar\\Projects\\chat-relay\\cli\\remote.mjs", offset: 0, length: 153 }),
    "Read cli/remote.mjs · lines 1–153",
  );

  const write = humanizeToolCall({ action: "fs.write", path: "dashboard/app.js", mode: "rewrite", content: "secret body" });
  assert.equal(write, "Write dashboard/app.js · replace file · 11 B");
  assert.ok(!write.includes("secret body"));

  const command = humanizeToolCall({ action: "terminal.exec", command: "curl -H 'Authorization: Bearer abc123' https://example.com", cwd: "C:\\repo" });
  assert.ok(command.includes("[redacted]"));
  assert.ok(!command.includes("abc123"));
  assert.equal(
    humanizeToolCall({
      action: "terminal.exec",
      command: "git status --short; git branch --show-current; git log -3 --oneline",
      cwd: "C:\\Users\\tatar\\Projects\\chat-relay",
    }),
    "Check Git status, current branch, and recent commits · in chat-relay",
  );

  assert.equal(
    humanizeToolCall({
      action: "fs.edit",
      path: "C:\\Users\\tatar\\Projects\\chat-relay\\cli\\tui.mjs",
      expectedReplacements: 1,
    }),
    "Edit cli/tui.mjs · 1 change",
  );
});

test("wraps long transaction summaries onto continuation lines", () => {
  const rows = formatTransactionRows({
    at: "2026-10-04T02:15:35.000Z",
    summary: "Run a very long command that should continue on another line instead of being truncated at the terminal edge",
    status: "done",
    ok: true,
    durationMs: 378,
  }, 72);

  assert.ok(rows.length > 1);
  assert.ok(rows.length <= 3);
  assert.ok(rows.every((line) => line.length <= 72));
  assert.match(rows[0], /378ms$/);
  assert.match(rows[1], /^\s{13,}/);
});

test("formats remote header as two columns", () => {
  const output = formatTwoColumnHeader({
    account: "Anusorn Hankasemsak",
    agent: "DESKTOP-5IQPSSC",
    status: "connected",
    relayHealth: { state: "limited", code: 1027, checkedAt: Date.now() },
    relay: "chat-relay.anusorn-hank.workers.dev",
    uptimeMs: 3_723_000,
    reconnects: 12,
    terminal: true,
    desktop: true,
  }, 118);

  const lines = output.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^Account\s+Anusorn Hankasemsak\s+Agent\s+DESKTOP-5IQPSSC/);
  assert.match(lines[1], /^Agent link\s+● WebSocket open\s+Relay\s+chat-relay\.anusorn-hank\.workers\.dev/);
  assert.match(lines[2], /^Relay API\s+✕ Cloudflare 1027\s+Reconnects\s+12/);
  assert.match(lines[3], /^Session up\s+01:02:03\s+Terminal\s+enabled/);
  assert.match(lines[4], /^Desktop\s+enabled\s+Checked\s+just now/);
});

test("labels agent authorization states separately from sign-in failures", () => {
  const states = [
    [{ state: "unauthorized", code: 401 }, "Sign-in required"],
    [{ state: "unauthorized", code: 403 }, "Access denied"],
    [{ state: "reauthorize" }, "Agent reauthorization required"],
    [{ state: "agent-disabled" }, "Agent disabled"],
    [{ state: "agent-access" }, "Agent access required"],
  ];

  for (const [relayHealth, label] of states) {
    const output = formatTwoColumnHeader({
      account: "Anusorn",
      agent: "Work PC",
      status: "connected",
      relayHealth: { ...relayHealth, checkedAt: Date.now() },
      relay: "chat-relay.example.dev",
    }, 118);
    assert.ok(output.split("\n")[2].includes(label), `missing Relay API label: ${label}`);
  }
});

test("formats transaction rows and tui selection", () => {
  const row = formatTransactionRow({
    at: "2026-10-04T01:58:21.000Z",
    summary: "Read cli/remote.mjs · lines 1–153",
    status: "done",
    ok: true,
    durationMs: 34,
  }, 100);
  assert.match(row, /✓/);
  assert.match(row, /Read cli\/remote\.mjs/);
  assert.match(row, /34ms$/);

  assert.equal(shouldUseTui({ tuiEnabled: false }, { isTTY: true }), false);
  assert.equal(shouldUseTui({ tuiEnabled: true }, { isTTY: false }), true);
  assert.equal(shouldUseTui({}, { isTTY: true }), true);
  assert.equal(shouldUseTui({}, { isTTY: false }), false);
  assert.equal(shouldUseColor({ isTTY: true }, {}), true);
  assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(shouldUseColor({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(shouldUseColor({ isTTY: false }, {}), false);
});

test("tui redraw stays inside terminal bounds and uses alternate screen", () => {
  const writes = [];
  const output = {
    isTTY: true,
    columns: 72,
    rows: 18,
    write(value) {
      writes.push(String(value));
      return true;
    },
  };
  const tui = new RemoteTui({
    config: {
      user: { name: "Anusorn Hankasemsak" },
      agentName: "DESKTOP-5IQPSSC",
      relayUrl: "https://chat-relay.example.workers.dev",
      terminalEnabled: true,
      desktopEnabled: true,
    },
    version: "0.11.1-test",
    output,
    env: {},
  });

  tui.start();
  tui.stop();

  assert.match(writes[0], /\x1b\[\?1049h/);
  assert.match(writes.at(-1), /\x1b\[\?1049l/);

  const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  const frame = writes.find((value) => stripAnsi(value).includes("Chat Relay  v0.11.1-test"));
  assert.ok(frame);
  const visible = frame.replace(/^\x1b\[2J\x1b\[H/, "");
  const lines = visible.split("\n");
  assert.ok(lines.length <= output.rows - 1);
  assert.ok(lines.every((line) => stripAnsi(line).length <= output.columns - 1));
  assert.match(frame, /\x1b\[36m/);
});

test("TUI keeps agent socket state separate from Worker HTTP health", () => {
  const tui = new RemoteTui({
    config: { relayUrl: "https://chat-relay.example.workers.dev" },
    version: "test",
    output: { isTTY: false, write() {} },
  });
  tui.handleMessage({ type: "chat-relay-ui", event: "connection", state: "connected" });
  tui.setRelayHealth({ state: "limited", code: 1027 });

  const header = formatTwoColumnHeader({ ...tui.state, uptimeMs: 0 }, 118);
  assert.match(header, /Agent link\s+● WebSocket open/);
  assert.match(header, /Relay API\s+✕ Cloudflare 1027/);
  assert.match(header, /Checked\s+just now/);
});

test("TUI scrolls with mouse and keyboard and restores interactive stdin", () => {
  class FakeInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.paused = true;
      this.rawModes = [];
    }
    setRawMode(value) {
      this.isRaw = Boolean(value);
      this.rawModes.push(Boolean(value));
    }
    isPaused() { return this.paused; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
  }

  const writes = [];
  const output = {
    isTTY: true,
    columns: 80,
    rows: 16,
    write(value) {
      writes.push(String(value));
      return true;
    },
  };
  const input = new FakeInput();
  let interrupted = 0;
  const tui = new RemoteTui({
    config: {
      user: { name: "Anusorn" },
      agentName: "DESKTOP",
      relayUrl: "https://relay.example",
      terminalEnabled: true,
    },
    version: "test",
    output,
    input,
    env: { NO_COLOR: "1" },
    onInterrupt: () => { interrupted += 1; },
  });

  tui.start();
  for (let index = 0; index < 12; index += 1) {
    tui.handleMessage({
      type: "chat-relay-ui",
      event: "system",
      at: "2026-10-04T10:00:00.000Z",
      message: "Event " + index,
    });
  }

  assert.match(writes[0], /\x1b\[\?1000h/);
  assert.deepEqual(input.rawModes, [true]);
  assert.equal(input.paused, false);

  input.emit("data", Buffer.from("\x1b[<64;10;10M"));
  assert.ok(tui.scrollOffset > 0);
  const afterWheelUp = tui.scrollOffset;

  input.emit("data", Buffer.from("\x1b[<65;10;10M"));
  assert.ok(tui.scrollOffset < afterWheelUp);

  input.emit("data", Buffer.from("\x1b[5~"));
  assert.ok(tui.scrollOffset > 0);
  input.emit("data", Buffer.from("\x1b[F"));
  assert.equal(tui.scrollOffset, 0);

  input.emit("data", Buffer.from("\x03"));
  assert.equal(interrupted, 1);

  tui.stop();
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.paused, true);
  assert.match(writes.at(-1), /\x1b\[\?1000l/);
  assert.match(writes.at(-1), /\x1b\[\?1049l/);
});

test("TUI compact layout respects tiny terminal rows and cell width", () => {
  const writes = [];
  const output = {
    isTTY: true,
    columns: 28,
    rows: 7,
    write(value) {
      writes.push(String(value));
      return true;
    },
  };
  const input = { isTTY: false };
  const tui = new RemoteTui({
    config: {
      user: { name: "Anusorn Hankasemsak" },
      agentName: "DESKTOP-5IQPSSC",
      relayUrl: "https://chat-relay.example.workers.dev",
      terminalEnabled: true,
    },
    version: "0.11.3-test",
    output,
    input,
    env: { NO_COLOR: "1" },
  });

  tui.start();
  tui.handleMessage({
    type: "chat-relay-ui",
    event: "system",
    at: "2026-10-04T10:00:00.000Z",
    message: "A long transaction summary that must fit inside a very narrow terminal",
  });
  tui.render();

  assert.doesNotMatch(writes[0], /\x1b\[\?1000h/);
  const frame = writes.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  const lines = frame.split("\n");
  assert.ok(lines.length <= output.rows - 1);
  assert.ok(lines.every((line) => terminalCellWidth(line) <= output.columns - 1));
  assert.match(frame, /🚀 Chat Relay/);
  assert.match(frame, /📜/);
  tui.stop();
});

test("terminalCellWidth treats relay emoji as wide glyphs", () => {
  assert.equal(terminalCellWidth("abc"), 3);
  assert.equal(terminalCellWidth("🚀"), 2);
  assert.equal(terminalCellWidth("📜 Transactions"), 15);
});

test("TUI restores an initially non-flowing stdin without pausing a pre-existing flowing stream", () => {
  const output = { isTTY: true, columns: 80, rows: 20, write() { return true; } };

  class Input extends EventEmitter {
    constructor(readableFlowing) {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.readableFlowing = readableFlowing;
      this.pauseCalls = 0;
    }
    setRawMode(value) { this.isRaw = Boolean(value); }
    isPaused() { return this.readableFlowing === false; }
    resume() { this.readableFlowing = true; }
    pause() {
      this.pauseCalls += 1;
      this.readableFlowing = false;
    }
  }

  const initiallyNeutral = new Input(null);
  const neutralTui = new RemoteTui({
    config: { relayUrl: "https://relay.example" },
    version: "test",
    output,
    input: initiallyNeutral,
    env: { NO_COLOR: "1" },
  });
  neutralTui.start();
  neutralTui.stop();
  assert.equal(initiallyNeutral.pauseCalls, 1);

  const initiallyFlowing = new Input(true);
  const flowingTui = new RemoteTui({
    config: { relayUrl: "https://relay.example" },
    version: "test",
    output,
    input: initiallyFlowing,
    env: { NO_COLOR: "1" },
  });
  flowingTui.start();
  flowingTui.stop();
  assert.equal(initiallyFlowing.pauseCalls, 0);
});
