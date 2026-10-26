import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { humanizeToolCall } from "../agent/toolcall-summary.mjs";
import { RemoteTui, formatBytes, formatTransactionRow, formatTransactionRows, formatTwoColumnHeader, shouldUseColor, shouldUseTui, terminalCellWidth } from "../cli/tui.mjs";

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

test("formats transfer sizes for transaction telemetry", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(842), "842 B");
  assert.equal(formatBytes(1638), "1.6 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");

  const row = formatTransactionRow({
    at: "2026-10-07T04:15:35.000Z",
    summary: "Run node task",
    status: "done",
    ok: true,
    requestBytes: 842,
    responseBytes: 1638,
    durationMs: 355,
  }, 100);

  assert.match(row, /↑ 842 B/);
  assert.match(row, /↓ 1.6 KB/);
  assert.match(row, /355ms$/);
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
    root: "C:\\Users\\tatar\\Projects",
    uptimeMs: 3_723_000,
    reconnects: 12,
    terminal: true,
    desktop: true,
    learn: true,
  }, 118);

  const lines = output.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^Account\s+Anusorn Hankasemsak\s+Agent\s+DESKTOP-5IQPSSC/);
  assert.match(lines[1], /^Status\s+○ Offline\s+Relay\s+chat-relay\.anusorn-hank\.workers\.dev/);
  assert.match(lines[2], /^Root\s+C:\\Users\\tatar\\Projects\s+Reconnects\s+12/);
  assert.match(lines[3], /^Session up\s+01:02:03\s+Terminal\s+enabled/);
  assert.match(lines[4], /^Desktop\s+enabled\s+Learn\s+enabled/);
  assert.doesNotMatch(output, /Checked|Agent link|Relay API/);
});

test("renders combined online status in green", () => {
  const output = formatTwoColumnHeader({
    account: "Anusorn",
    agent: "Work PC",
    status: "connected",
    relayHealth: { state: "unavailable", code: 200, checkedAt: Date.now() },
    relay: "chat-relay.example.dev",
    learn: true,
  }, 118, { color: true });

  assert.match(output, /\x1b\[32m● Online\x1b\[0m/);
  assert.match(output, /Learn[\s\S]*?\x1b\[32menabled\x1b\[0m/);
});

test("renders combined status offline when relay health fails", () => {
  const states = [
    { state: "unauthorized", code: 401 },
    { state: "unauthorized", code: 403 },
    { state: "reauthorize" },
    { state: "agent-disabled" },
    { state: "agent-access" },
  ];

  for (const relayHealth of states) {
    const output = formatTwoColumnHeader({
      account: "Anusorn",
      agent: "Work PC",
      status: "connected",
      relayHealth: { ...relayHealth, checkedAt: Date.now() },
      relay: "chat-relay.example.dev",
    }, 118);
    assert.match(output, /Status\s+○ Offline/);
    assert.doesNotMatch(output, /Relay API|Checked/);
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
  assert.match(row, /✅/);
  assert.match(row, /Read cli\/remote\.mjs/);
  assert.match(row, /34ms$/);

  const failedRow = formatTransactionRow({
    at: "2026-10-05T01:07:01.000Z",
    summary: "Run terminal UI tests · in chat-relay · Command failed with exit code 1",
    status: "done",
    ok: false,
    durationMs: 100,
  }, 100, { color: true });
  assert.match(failedRow, /^\x1b\[31m.*❌.*Command failed with exit code 1.*100ms\x1b\[0m$/);

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
  assert.match(frame, /\x1b\[38;2;93;218;203m/);
});

test("TUI Learn indicator follows Worker capability instead of local config defaults", () => {
  const tui = new RemoteTui({
    config: { relayUrl: "https://chat-relay.example.workers.dev", learnEnabled: true },
    version: "test",
    output: { isTTY: false, write() {} },
  });

  let header = formatTwoColumnHeader({ ...tui.state, uptimeMs: 0 }, 118);
  assert.match(header, /Learn\s+checking/);

  tui.setRelayHealth({ state: "reachable", features: { learn: true } });
  header = formatTwoColumnHeader({ ...tui.state, uptimeMs: 0 }, 118);
  assert.match(header, /Learn\s+enabled/);

  tui.setRelayHealth({ state: "reachable", features: { learn: false } });
  header = formatTwoColumnHeader({ ...tui.state, uptimeMs: 0 }, 118);
  assert.match(header, /Learn\s+disabled/);
});

test("TUI shows Learn activity pushed over the existing agent channel", () => {
  const tui = new RemoteTui({
    config: { relayUrl: "https://chat-relay.example.workers.dev" },
    version: "test",
    output: { isTTY: false, write() {} },
  });

  tui.handleMessage({
    type: "chat-relay-ui",
    event: "learn",
    change: {
      eventId: "lev-1",
      type: "created",
      key: "physical-device-test",
      summary: "Test on a physical device before commit",
      at: "2026-10-06T10:00:00.000Z",
    },
  });

  const item = tui.transactions.at(-1);
  assert.equal(item.action, "learn");
  assert.equal(item.ok, true);
  assert.match(item.summary, /^Learn \+ Test on a physical device before commit/);
});


test("TUI shows one ephemeral row for each Learn call", () => {
  const tui = new RemoteTui({
    config: { relayUrl: "https://chat-relay.example.workers.dev" },
    version: "test",
    output: { isTTY: false, write() {} },
  });

  tui.handleMessage({
    type: "chat-relay-ui",
    event: "learn",
    activity: {
      eventId: "learn-call-1",
      tool: "learn_get",
      ok: true,
      durationMs: 24,
      scopeSummary: "global/project",
      at: "2026-10-07T03:00:00.000Z",
    },
  });

  assert.equal(tui.transactions.length, 1);
  assert.equal(tui.transactions[0].action, "learn_get");
  assert.equal(tui.transactions[0].durationMs, 24);
  assert.equal(tui.transactions[0].ok, true);
  assert.match(tui.transactions[0].summary, /^🧠 Learn · read global\/project context/);

  tui.handleMessage({
    type: "chat-relay-ui",
    event: "learn",
    activity: {
      eventId: "learn-call-2",
      tool: "learn_put",
      ok: true,
      durationMs: 31,
      kind: "workflow",
      change: {
        type: "updated",
        key: "auto-commit-completed-work",
        kind: "workflow",
      },
      at: "2026-10-07T03:00:01.000Z",
    },
  });

  assert.equal(tui.transactions.length, 2, "changed mutations must still append exactly one call row");
  assert.match(tui.transactions[1].summary, /^🧠 Learn · updated workflow · auto-commit-completed-work/);
  assert.equal(tui.transactions[1].durationMs, 31);
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
  assert.match(header, /Status\s+○ Offline/);
  assert.doesNotMatch(header, /Agent link|Relay API|Checked/);
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
  assert.match(frame, /Chat Relay/);
  assert.match(frame, /Activity/);
  tui.stop();
});

test("terminalCellWidth treats relay emoji as wide glyphs", () => {
  assert.equal(terminalCellWidth("abc"), 3);
  assert.equal(terminalCellWidth("🚀"), 2);
  assert.equal(terminalCellWidth("⌨️"), 2);
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

test("compact monitor adapts to viewport and preserves cell bounds", () => {
  const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  for (const [columns, rows] of [[28, 7], [44, 12], [72, 18], [80, 24], [120, 30]]) {
    for (const noColor of [false, true]) {
      const frames = [];
      const output = { isTTY: true, columns, rows, write(value) { frames.push(String(value)); return true; } };
      const tui = new RemoteTui({
        config: {
          user: { name: "Anusorn" }, agentName: "DESKTOP-5IQPSSC",
          allowedRoots: "C:\\Users\\tatar\\Projects",
          relayUrl: "https://chat-relay.example.workers.dev",
          terminalEnabled: true, desktopEnabled: true,
        },
        version: "1.3.2", output, input: { isTTY: false },
        env: noColor ? { NO_COLOR: "1" } : {},
      });
      tui.start();
      tui.setRelayHealth({ code: 200, features: { learn: true } });
      tui.handleMessage({ type: "chat-relay-ui", event: "connection", state: "connected" });
      for (let i = 0; i < 25; i++) {
        tui.handleMessage({
          type: "chat-relay-ui", event: "tool:start",
          at: "2026-10-26T03:00:00Z", requestId: "req-" + i,
          action: "terminal.exec",
          summary: "Run git status and long Thai ภาษาไทย emoji ✅ command number " + i,
          requestBytes: 512,
        });
      }
      tui.render();
      const screen = frames.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
      const plain = strip(screen);
      const lines = plain.split("\n");
      assert.ok(lines.length <= rows - 1, columns + "x" + rows + " rows");
      assert.ok(lines.every((line) => terminalCellWidth(line) <= columns - 1), columns + "x" + rows + " cells");
      assert.match(plain, /Activity/);
      assert.match(plain, /ONLINE/);
      if (noColor) assert.doesNotMatch(screen, /\x1b\[[0-9;]*m/);
      tui.stop();
    }
  }
});

test("mock-inspired TUI shows project and humanized title on separate activity lines", () => {
  const frames = [];
  const output = { isTTY: true, columns: 120, rows: 28, write(value) { frames.push(String(value)); return true; } };
  const tui = new RemoteTui({
    config: {
      agentName: "DESKTOP-5IQPSSC", allowedRoots: "C:\\Users\\tatar\\Projects",
      relayUrl: "https://chat-relay.example.workers.dev",
      terminalEnabled: true, desktopEnabled: true,
    },
    version: "1.3.3-test", output, input: { isTTY: false }, env: { NO_COLOR: "1" },
  });
  tui.start();
  tui.setRelayHealth({ state: "reachable", code: 200, features: { learn: true } });
  tui.handleMessage({ type: "chat-relay-ui", event: "connection", state: "connected" });
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:start", requestId: "demo-write",
    at: "2026-10-26T04:40:00Z", action: "fs.write",
    summary: "Write apps/web/src/SkillAdmin.tsx · replace file · 11 KB",
    operation: "Write SkillAdmin.tsx", project: "flowly", category: "Filesystem",
    detail: "C:\\Users\\tatar\\Projects\\flowly\\apps\\web\\src\\SkillAdmin.tsx", requestBytes: 1000,
  });
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:end", requestId: "demo-write",
    ok: true, durationMs: 12, responseBytes: 340,
  });
  tui.render();

  const frame = frames.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  const lines = frame.split("\n");
  const header = lines.findIndex((line) => line.includes("TIME") && line.includes("OPERATION") && line.includes("DURATION"));
  const primary = lines.findIndex((line) => line.includes("✏️ SkillAdmin.tsx"));
  assert.ok(header >= 0, "table headings should be visible");
  assert.equal(primary, header + 2, "activity starts just below the divider, not at terminal bottom");
  assert.match(lines[primary], /12ms\s*$/);
  assert.match(lines[primary + 1], /flowly · 📁/);
  assert.match(frame, /1 operation/);
  assert.match(frame, /AGENT\s+SESSION\s+RECONNECTS/);
  assert.match(lines[primary + 2], /apps\/web\/src\/SkillAdmin\.tsx/);
  assert.doesNotMatch(frame, /Ctrl\+C Exit|● Connected|End Live/);
  assert.doesNotMatch(frame, /\x1b\[[0-9;]*m/, "NO_COLOR should omit styling");
  tui.stop();
});

test("activity uses General for unknown project and prioritizes context in narrow view", () => {
  const logs = [];
  const output = { isTTY: false, columns: 40, rows: 11, write(v) { logs.push(String(v)); return true; } };
  const tui = new RemoteTui({ config: { agentName: "DESKTOP", allowedRoots: "C:\\Projects" }, output, input: { isTTY: false } });
  tui.start();
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:start", requestId: "generic",
    action: "ping", operation: "Check agent connection", project: null, category: "Agent",
  });
  tui.render();
  let screen = logs.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  assert.match(screen, /General · Check agent/);
  assert.ok(screen.split("\n").every((line) => terminalCellWidth(line) <= 39));
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:start", requestId: "project",
    action: "terminal.exec", operation: "Run integration tests", project: "flowly", category: "Terminal",
  });
  tui.render();
  screen = logs.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
  assert.match(screen, /flowly · ⌨️ Run integration/);
  tui.stop();
});

test("successful and failed tool end preserve humanized text and project on TUI", () => {
  const writes = [];
  const tui = new RemoteTui({
    config: { agentName: "DESKTOP" },
    output: { isTTY: true, columns: 100, rows: 24, write(v) { writes.push(String(v)); } },
    input: { isTTY: false }, env: { NO_COLOR: "1" },
  });
  tui.start();
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:start", requestId: "a",
    action: "terminal.exec", summary: "Run Write-Output some raw command",
    project: "chat-relay", operation: "Check command availability", category: "Terminal",
  });
  tui.handleMessage({
    type: "chat-relay-ui", event: "tool:end", requestId: "a",
    durationMs: 8, responseBytes: 100, ok: false, error: "Command failed with exit code 1",
  });
  tui.render();
  const text = writes.at(-1);
  assert.match(text, /Check command availability/);
  assert.match(text, /chat-relay · ⌨️\n\s+Error: Command failed/);
  assert.doesNotMatch(text, /Run Write-Output some raw command/);
  assert.equal(tui.transactions.at(-1).status, "done");
  tui.stop();
});

test("Thai combining marks occupy no extra terminal cells", () => {
  assert.equal(terminalCellWidth("ก่า"), 2);
  assert.equal(terminalCellWidth("ภาษาไทย"), 7);
});

test("Learn activity displays the brain emoji with humanized text in wide and narrow TUI", () => {
  for (const columns of [44, 120]) {
    const frames = [];
    const output = { isTTY: false, columns, rows: 30, write(value) { frames.push(String(value)); } };
    const tui = new RemoteTui({
      config: { agentName: "DESKTOP-TEST" }, output, input: { isTTY: false }, env: { NO_COLOR: "1" },
    });
    tui.handleMessage({
      type: "chat-relay-ui", event: "learn",
      activity: {
        eventId: "learn-call", tool: "learn_get", projectKey: "chat-relay",
        scopeSummary: "project", durationMs: 24, ok: true,
      },
    });
    tui.handleMessage({
      type: "chat-relay-ui", event: "learn",
      change: { eventId: "learn-legacy", type: "updated", projectKey: "chat-relay" },
    });
    tui.handleMessage({
      type: "chat-relay-ui", event: "tool:start", requestId: "already-prefixed",
      action: "learn_prepare", category: "Learn", project: "chat-relay",
      operation: "🧠 Load relevant Learn context",
    });
    tui.render();
    const frame = frames.at(-1).replace(/^\x1b\[2J\x1b\[H/, "");
    assert.match(frame, /🧠 Read Learn/, columns + "-column Learn call emoji");
    assert.match(frame, /🧠 Update Learn/, columns + "-column legacy Learn emoji");
    assert.match(frame, /🧠 Load relevant Lea/, columns + "-column prefixed Learn emoji");
    assert.doesNotMatch(frame, /🧠 🧠/, "must not repeat the emoji");
    assert.ok(frame.split("\n").every((line) => terminalCellWidth(line) <= columns - 1));
    if (columns === 120) assert.match(frame, /chat-relay · 🧠/);
    tui.stop();
  }
});
