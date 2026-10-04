import assert from "node:assert/strict";
import test from "node:test";

import { humanizeToolCall } from "../agent/toolcall-summary.mjs";
import { formatTransactionRow, formatTwoColumnHeader, shouldUseTui } from "../cli/tui.mjs";

test("humanizes filesystem and terminal calls without file contents", () => {
  assert.equal(
    humanizeToolCall({ action: "fs.read", path: "C:\\Users\\tatar\\Projects\\chat-relay\\cli\\remote.mjs", offset: 0, length: 153 }),
    "Read C:/Users/tatar/Projects/chat-relay/cli/remote.mjs · lines 1–153",
  );

  const write = humanizeToolCall({ action: "fs.write", path: "dashboard/app.js", mode: "rewrite", content: "secret body" });
  assert.equal(write, "Write dashboard/app.js · rewrite · 11 B");
  assert.ok(!write.includes("secret body"));

  const command = humanizeToolCall({ action: "terminal.exec", command: "curl -H 'Authorization: Bearer abc123' https://example.com", cwd: "C:\\repo" });
  assert.ok(command.includes("[redacted]"));
  assert.ok(!command.includes("abc123"));
});

test("formats remote header as two columns", () => {
  const output = formatTwoColumnHeader({
    account: "Anusorn Hankasemsak",
    agent: "DESKTOP-5IQPSSC",
    status: "connected",
    relay: "chat-relay.anusorn-hank.workers.dev",
    uptimeMs: 3_723_000,
    reconnects: 12,
    terminal: true,
    desktop: true,
  }, 118);

  const lines = output.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Account\s+Anusorn Hankasemsak\s+Agent\s+DESKTOP-5IQPSSC/);
  assert.match(lines[1], /^Status\s+● Connected\s+Relay\s+chat-relay\.anusorn-hank\.workers\.dev/);
  assert.match(lines[2], /^Uptime\s+01:02:03\s+Reconnects\s+12/);
  assert.match(lines[3], /^Terminal\s+enabled\s+Desktop\s+enabled/);
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
});
