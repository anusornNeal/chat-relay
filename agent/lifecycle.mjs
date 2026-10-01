const ALLOWED_WHILE_DRAINING = new Set([
  "ping",
  "agent.config",
  "agent.recentCalls",
  "agent.lifecycle.status",
  "agent.lifecycle.drain",
  "agent.lifecycle.resume",
  "agent.lifecycle.restart",
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.readMany",
  "fs.batch",
  "fs.artifact",
  "fs.search.start",
  "fs.search.results",
  "process.list",
  "process.kill",
  "desktop.screenshot",
  "desktop.clipboard.read",
  "desktop.window.list",
  "terminal.batch.status",
  "terminal.batch.read",
  "terminal.batch.cancel",
  "terminal.read",
  "terminal.write",
  "terminal.kill",
  "terminal.list",
  "terminal.observability",
]);

export const AGENT_RESTART_EXIT_CODE = 4;

function normalizeWork(value = {}) {
  const count = (key) => Math.max(0, Number(value[key]) || 0);
  const work = {
    activeSessions: count("activeSessions"),
    activeBatchJobs: count("activeBatchJobs"),
    queuedBatchJobs: count("queuedBatchJobs"),
    activeTerminalExecs: count("activeTerminalExecs"),
    queuedTerminalExecs: count("queuedTerminalExecs"),
  };
  work.total = Object.values(work).reduce((sum, item) => sum + item, 0);
  return work;
}

export class AgentLifecycle {
  constructor(options = {}) {
    this.state = "running";
    this.drainStartedAt = null;
    this.restartRequestedAt = null;
    this.now = options.now ?? (() => Date.now());
    this.workSummary = options.workSummary ?? (() => ({}));
  }

  snapshot() {
    const work = normalizeWork(this.workSummary());
    return {
      state: this.state,
      drainStartedAt: this.drainStartedAt,
      restartRequestedAt: this.restartRequestedAt,
      readyToRestart: this.state === "draining" && work.total === 0,
      work,
    };
  }

  drain() {
    if (this.state !== "restart-pending") {
      this.state = "draining";
      this.drainStartedAt ??= new Date(this.now()).toISOString();
    }
    return { ok: true, lifecycle: this.snapshot() };
  }

  resume() {
    if (this.state === "restart-pending") {
      return { ok: false, error: "restart_pending", lifecycle: this.snapshot() };
    }
    this.state = "running";
    this.drainStartedAt = null;
    return { ok: true, lifecycle: this.snapshot() };
  }

  guard(action) {
    if (this.state === "running" || ALLOWED_WHILE_DRAINING.has(String(action))) return null;
    return { ok: false, error: "agent_draining", lifecycle: this.snapshot() };
  }

  requestRestart() {
    if (this.state !== "draining") {
      return { ok: false, error: "drain_required", lifecycle: this.snapshot() };
    }
    const snapshot = this.snapshot();
    if (snapshot.work.total > 0) {
      return { ok: false, error: "active_work_remaining", lifecycle: snapshot };
    }
    this.state = "restart-pending";
    this.restartRequestedAt = new Date(this.now()).toISOString();
    return { ok: true, restart: true, lifecycle: this.snapshot() };
  }
}
