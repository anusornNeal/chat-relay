import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Execute the production scheduling functions with deterministic browser timers.
const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const names = ["dashboardAvailable", "scheduleDataRetry", "refreshActiveIncrementally", "queueLiveRefresh", "stopFallbackPolling", "scheduleFallbackPolling", "scheduleReconnect", "stopLiveChannel", "connectLiveChannel", "updateDashboardAvailability"];
const functions = names.map(name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = name === "dashboardAvailable" ? source.indexOf("\n", start) : source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}).join("\n");
const timers = new Map(); let sequence = 0; let now = 100000; let loads = 0; let sockets = 0;
const context = vm.createContext({
  document: { hidden: false, addEventListener() {} }, window: { addEventListener() {} }, navigator: { onLine: true }, location: { protocol: "https:", host: "test" },
  Date: { now: () => now },
  setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
  setInterval: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
  clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  WebSocket: class { static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; constructor() { sockets++; this.readyState = 0; } close() { this.readyState = 3; } },
  setLiveState() {}, $: () => null, topicsTouchActiveView: () => true,
  loadActive: async () => { loads++; return true; }, applyToolLifecycle() {},
});
vm.runInContext(`let currentUser = {}; let liveSocket = null; let reconnectTimer = null; let fallbackStartTimer = null; let fallbackPollTimer = null; let heartbeatTimer = null; let runningClockTimer = null; let liveRefreshTimer = null; let reconnectAttempt = 0; let socketEverOpened = false; let lastPongAt = 0; let refreshRunning = false; let refreshQueued = false; let dataRetryTimer = null; let dataRetryAttempt = 0; let lastLiveRefreshAt = 0; const DATA_RETRY_MAX_MS = 300000; const pendingLiveTopics = new Set();\n${functions}`, context);
const run = code => vm.runInContext(code, context);
run('queueLiveRefresh(["calls"]);');
const first = [...timers][0];
run('queueLiveRefresh(["calls"]);');
assert.equal(timers.size, 1, "busy invalidations retain the original timer");
timers.delete(first[0]); await first[1].fn(); assert.equal(loads, 1);
run('queueLiveRefresh(["calls"]);'); assert.equal([...timers.values()][0].delay, 30000);
run('stopLiveChannel(); scheduleFallbackPolling();'); assert.equal([...timers.values()][0].delay, 60000);
run('stopLiveChannel();');
for (let i = 0; i < 9; i++) run('scheduleReconnect();');
assert.equal(run('reconnectAttempt'), 9);
assert.equal(timers.get(run('reconnectTimer')).delay, 300000);
run('stopLiveChannel(); scheduleDataRetry();'); assert.equal(timers.get(run('dataRetryTimer')).delay, 60000);
run('clearTimeout(dataRetryTimer); dataRetryTimer = null; dataRetryAttempt = 9; scheduleDataRetry();');
assert.equal(timers.get(run('dataRetryTimer')).delay, 300000);
context.document.hidden = true; run('updateDashboardAvailability();'); assert.equal(timers.size, 0);
run('scheduleReconnect(); scheduleFallbackPolling(); scheduleDataRetry(); queueLiveRefresh(["calls"]);'); assert.equal(timers.size, 0);
assert.equal(sockets, 0);
context.document.hidden = false; context.navigator.onLine = false;
run('updateDashboardAvailability();'); assert.equal(timers.size, 0);
context.navigator.onLine = true; run('updateDashboardAvailability();');
await Promise.resolve(); assert.equal(sockets, 1); assert.equal(loads, 2);
context.document.hidden = true; run('updateDashboardAvailability();');
context.document.hidden = false;
context.loadActive = async () => { loads++; run('refreshQueued = true;'); return false; };
await run('refreshActiveIncrementally();'); assert.equal(loads, 3, "failed loads drop queued refreshes");
console.log("PASS dashboard coalescing, fallback/backoff, visibility/offline pause, resume and failure burst suppression");
