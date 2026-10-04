import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { AgentConnectionState } from "../agent/connection-state.mjs";
import { RemoteTui, terminalCellWidth } from "../cli/tui.mjs";
import { DailyOptionalBudget } from "../src/usage-budget.mjs";

const requestedIterations = Number(process.env.CHAT_RELAY_SOAK_ITERATIONS) || 2_000;
const iterations = Math.min(Math.max(Math.trunc(requestedIterations), 100), 1_000_000);
const renderEvery = Math.max(1, Math.floor(iterations / 100));

const state = new AgentConnectionState({
  baseReconnectMs: 100,
  maxReconnectMs: 5_000,
  heartbeatMs: 5_000,
});

for (let index = 0; index < iterations; index += 1) {
  const base = 1_000_000 + index * 10;
  state.markConnecting(base);
  state.markConnected(base + 1);
  assert.equal(state.markServerConnectionGeneration(index + 1), true);
  state.markHeartbeat(base + 2);
  state.markDisconnected(1006, "socket_closed", base + 3);
  const delay = state.nextDelay(() => 0.5);
  state.scheduleReconnect(delay, base + 3);
  assert.ok(delay >= 100 && delay <= 5_000);
}
assert.equal(state.snapshot().reconnectCount, iterations);

const budget = new DailyOptionalBudget();
const budgetLimit = Math.max(1, Math.floor(iterations / 2));
const budgetNow = Date.parse("2026-10-04T12:00:00Z");
let allowed = 0;
let suppressed = 0;
for (let index = 0; index < iterations; index += 1) {
  const decision = budget.consume(budgetLimit, budgetNow + index);
  if (decision.allowed) allowed += 1;
  else suppressed += 1;
}
assert.equal(allowed, budgetLimit);
assert.equal(suppressed, iterations - budgetLimit);

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.paused = true;
  }
  setRawMode(value) { this.isRaw = Boolean(value); }
  isPaused() { return this.paused; }
  resume() { this.paused = false; }
  pause() { this.paused = true; }
}

let latestFrame = "";
const output = {
  isTTY: true,
  columns: 80,
  rows: 20,
  write(value) {
    latestFrame = String(value);
    return true;
  },
};
const input = new FakeInput();
const tui = new RemoteTui({
  config: {
    user: { name: "Soak User" },
    agentName: "SOAK-AGENT",
    relayUrl: "https://relay.example",
    terminalEnabled: true,
    desktopEnabled: true,
  },
  version: "soak",
  output,
  input,
  env: { NO_COLOR: "1" },
  onInterrupt() {},
});

tui.start();
for (let index = 0; index < iterations; index += 1) {
  tui.handleMessage({
    type: "chat-relay-ui",
    event: "system",
    at: new Date(budgetNow + index).toISOString(),
    message: "Soak event " + index,
    level: index % 97 === 0 ? "error" : "info",
  });
  if (index % renderEvery === 0 || index === iterations - 1) {
    output.columns = 22 + (index % 100);
    output.rows = 7 + (index % 25);
    tui.render();
    const visible = latestFrame.replace(/^\x1b\[2J\x1b\[H/, "");
    const lines = visible.split("\n");
    assert.ok(lines.length <= Math.max(1, output.rows - 1));
    assert.ok(lines.every((line) => terminalCellWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= Math.max(1, output.columns - 1)));
  }
}
assert.equal(tui.transactions.length, 100, "transaction retention must remain bounded");
assert.equal(input.listenerCount("data"), 1);
tui.stop();
assert.equal(input.listenerCount("data"), 0);
assert.equal(input.isRaw, false);
assert.equal(input.paused, true);

console.log(`soak smoke passed: ${iterations} reconnect/telemetry/TUI iterations`);
