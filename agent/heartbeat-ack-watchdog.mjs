export const HEARTBEAT_ACK_TIMEOUT_REASON = "heartbeat_ack_timeout";

export function heartbeatAckDecision({ now, deadlineAt }) {
  const currentTime = Number(now);
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(currentTime) || !Number.isFinite(deadline)) {
    return { timedOut: false, remainingMs: null, overdueMs: 0 };
  }
  if (currentTime <= deadline) {
    return { timedOut: false, remainingMs: deadline - currentTime, overdueMs: 0 };
  }
  return { timedOut: true, remainingMs: 0, overdueMs: currentTime - deadline };
}

export class HeartbeatAckWatchdog {
  constructor(options) {
    this.timeoutMs = Number(options.timeoutMs);
    this.onTimeout = options.onTimeout;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.timer = null;
    this.active = false;
    this.lastAckAt = null;
    this.deadlineAt = null;
    this.lastTimeout = null;
  }

  start(now = this.now()) {
    this.active = true;
    this.lastAckAt = Number(now);
    this.#arm();
  }

  acknowledge(now = this.now()) {
    if (!this.active) return;
    this.lastAckAt = Number(now);
    this.#arm();
  }

  stop() {
    this.active = false;
    this.deadlineAt = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  snapshot(now = this.now()) {
    const decision = heartbeatAckDecision({ now, deadlineAt: this.deadlineAt });
    return {
      active: this.active,
      timeoutMs: this.timeoutMs,
      lastAckAt: this.lastAckAt === null ? null : new Date(this.lastAckAt).toISOString(),
      deadlineAt: this.deadlineAt === null ? null : new Date(this.deadlineAt).toISOString(),
      remainingMs: this.active ? decision.remainingMs : null,
      lastTimeoutReason: this.lastTimeout?.reason ?? null,
      lastTimedOutAt: this.lastTimeout ? new Date(this.lastTimeout.detectedAt).toISOString() : null,
      lastTimeoutOverdueMs: this.lastTimeout?.overdueMs ?? null,
    };
  }

  #arm() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.deadlineAt = this.lastAckAt + this.timeoutMs;
    const delay = Math.max(1, this.deadlineAt - this.now() + 1);
    this.timer = this.setTimer(() => this.#check(), delay);
    this.timer?.unref?.();
  }

  #check() {
    this.timer = null;
    if (!this.active) return;
    const detectedAt = Number(this.now());
    const decision = heartbeatAckDecision({ now: detectedAt, deadlineAt: this.deadlineAt });
    if (!decision.timedOut) {
      this.#arm();
      return;
    }
    this.active = false;
    this.lastTimeout = {
      reason: HEARTBEAT_ACK_TIMEOUT_REASON,
      lastAckAt: this.lastAckAt,
      deadlineAt: this.deadlineAt,
      detectedAt,
      overdueMs: decision.overdueMs,
    };
    this.onTimeout({ ...this.lastTimeout, timeoutMs: this.timeoutMs });
  }
}
