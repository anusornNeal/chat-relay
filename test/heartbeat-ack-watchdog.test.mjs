import assert from "node:assert/strict";
import {
  HeartbeatAckWatchdog,
  heartbeatAckDecision,
} from "../agent/heartbeat-ack-watchdog.mjs";

assert.deepEqual(heartbeatAckDecision({ now: 1100, deadlineAt: 1100 }), {
  timedOut: false,
  remainingMs: 0,
  overdueMs: 0,
});
assert.equal(heartbeatAckDecision({ now: 1101, deadlineAt: 1100 }).timedOut, true);

function createHarness(timeoutMs = 100) {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();
  const timeouts = [];
  const watchdog = new HeartbeatAckWatchdog({
    timeoutMs,
    now: () => now,
    setTimer: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    onTimeout: (details) => timeouts.push(details),
  });
  return {
    watchdog,
    timeouts,
    advanceTo(value) {
      now = value;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAt <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const missingAck = createHarness();
missingAck.watchdog.start();
missingAck.advanceTo(1101);
assert.equal(missingAck.timeouts.length, 1);
assert.equal(missingAck.timeouts[0].reason, "heartbeat_ack_timeout");
assert.equal(missingAck.timeouts[0].overdueMs, 1);
assert.deepEqual(missingAck.watchdog.snapshot(), {
  active: false,
  timeoutMs: 100,
  lastAckAt: new Date(1000).toISOString(),
  deadlineAt: new Date(1100).toISOString(),
  remainingMs: null,
  lastTimeoutReason: "heartbeat_ack_timeout",
  lastTimedOutAt: new Date(1101).toISOString(),
  lastTimeoutOverdueMs: 1,
});
missingAck.advanceTo(1500);
assert.equal(missingAck.timeouts.length, 1, "one missed ACK must trigger only one reconnect");

const timelyAck = createHarness();
timelyAck.watchdog.start();
timelyAck.advanceTo(1090);
timelyAck.watchdog.acknowledge();
timelyAck.advanceTo(1101);
assert.equal(timelyAck.timeouts.length, 0);
timelyAck.advanceTo(1191);
assert.equal(timelyAck.timeouts.length, 1);

const delayedTimer = createHarness();
delayedTimer.watchdog.start();
delayedTimer.advanceTo(1100);
assert.equal(delayedTimer.timeouts.length, 0, "deadline boundary must not churn the socket");
delayedTimer.watchdog.acknowledge();
delayedTimer.advanceTo(1101);
assert.equal(delayedTimer.timeouts.length, 0, "a timely ACK must supersede the earlier timer");

const stopped = createHarness();
stopped.watchdog.start();
stopped.watchdog.stop();
stopped.advanceTo(1200);
assert.equal(stopped.timeouts.length, 0);

console.log("heartbeat ACK watchdog tests passed");
