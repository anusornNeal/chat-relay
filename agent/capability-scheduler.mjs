const DEFAULT_QUEUE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_QUEUED = 64;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function queueError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export class BoundedLane {
  constructor(options = {}) {
    this.name = String(options.name || "lane");
    this.concurrency = boundedInteger(options.concurrency, 1, 1, 64);
    this.maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 1, 512);
    this.queueTimeoutMs = boundedInteger(options.queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, 100, 120_000);
    this.active = 0;
    this.queue = [];
  }

  run(work) {
    if (typeof work !== "function") return Promise.reject(queueError("invalid_work"));
    return new Promise((resolve, reject) => {
      const job = { work, resolve, reject, timer: null };
      if (this.active < this.concurrency) {
        this.#start(job);
        return;
      }
      if (this.queue.length >= this.maxQueued) {
        reject(queueError("queue_full"));
        return;
      }
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(queueError("queue_timeout"));
      }, this.queueTimeoutMs);
      this.queue.push(job);
    });
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      active: this.active,
      queued: this.queue.length,
      maxQueued: this.maxQueued,
      queueTimeoutMs: this.queueTimeoutMs,
    };
  }

  #start(job) {
    if (job.timer) clearTimeout(job.timer);
    this.active += 1;
    Promise.resolve()
      .then(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.#drain();
      });
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.#start(this.queue.shift());
    }
  }
}

export class CapabilityScheduler {
  constructor(options = {}) {
    const maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 1, 512);
    const queueTimeoutMs = boundedInteger(options.queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, 100, 120_000);
    const lane = (name, concurrency) => new BoundedLane({ name, concurrency, maxQueued, queueTimeoutMs });

    this.lanes = new Map([
      ["agent", lane("agent", options.agentConcurrency ?? 4)],
      ["filesystem", lane("filesystem", options.fileConcurrency ?? 8)],
      ["process", lane("process", options.processConcurrency ?? 4)],
      ["terminalExec", lane("terminalExec", options.terminalExecConcurrency ?? 4)],
      ["terminalControl", lane("terminalControl", options.terminalControlConcurrency ?? 8)],
      ["desktopRead", lane("desktopRead", options.desktopReadConcurrency ?? 2)],
    ]);
  }

  run(action, work) {
    const lane = this.#laneFor(action);
    return lane ? lane.run(work) : Promise.resolve().then(work);
  }

  snapshot() {
    return Object.fromEntries([...this.lanes.entries()].map(([name, lane]) => [name, lane.snapshot()]));
  }

  #laneFor(action) {
    const value = String(action || "unknown");
    if (value.startsWith("fs.")) return this.lanes.get("filesystem");
    if (value.startsWith("process.")) return this.lanes.get("process");
    if (value === "terminal.exec") return this.lanes.get("terminalExec");
    if (value.startsWith("terminal.")) return this.lanes.get("terminalControl");
    if (value === "desktop.screenshot") return this.lanes.get("desktopRead");
    if (value.startsWith("desktop.")) return null;
    return this.lanes.get("agent");
  }
}

export { boundedInteger };
