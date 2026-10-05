const ALLOWED_WHILE_DRAINING = new Set([
  "ping",
  "agent.config",
  "agent.recentCalls",
  "agent.lifecycle.status",
  "agent.lifecycle.drain",
  "agent.lifecycle.resume",
  "agent.lifecycle.restart",
  "agent.lifecycle.upgrade",
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

const ALLOWED_WHILE_FINALIZING = new Set([
  "ping",
  "agent.config",
  "agent.lifecycle.status",
]);

export const AGENT_RESTART_EXIT_CODE = 4;
export const AGENT_UPGRADE_EXIT_CODE = 5;

export function summarizeAgentWork({ terminal = {}, scheduler = {}, desktop = {} } = {}) {
  const terminalExec = scheduler.terminalExec || {};
  const otherSchedulerLanes = ["filesystem", "process", "terminalControl", "desktopRead"];
  const activeOtherJobs = otherSchedulerLanes.reduce(
    (sum, name) => sum + Math.max(0, Number(scheduler[name]?.active) || 0),
    0,
  );
  const queuedOtherJobs = otherSchedulerLanes.reduce(
    (sum, name) => sum + Math.max(0, Number(scheduler[name]?.queued) || 0),
    0,
  );
  const desktopControl = desktop.controlQueue || {};
  return {
    activeSessions: Array.isArray(terminal.sessions)
      ? terminal.sessions.filter((item) => item?.status === "running").length
      : 0,
    activeBatchJobs: Math.max(0, Number(terminal.activeExecJobs) || 0),
    queuedBatchJobs: Math.max(0, Number(terminal.queuedJobs) || 0),
    activeTerminalExecs: Math.max(0, Number(terminalExec.active) || 0),
    queuedTerminalExecs: Math.max(0, Number(terminalExec.queued) || 0),
    activeOtherJobs,
    queuedOtherJobs,
    activeDesktopControls: Math.max(0, Number(desktopControl.active) || 0),
    queuedDesktopControls: Math.max(0, Number(desktopControl.queued) || 0),
  };
}

function normalizeWork(value = {}) {
  const count = (key) => Math.max(0, Number(value[key]) || 0);
  const work = {
    activeSessions: count("activeSessions"),
    activeBatchJobs: count("activeBatchJobs"),
    queuedBatchJobs: count("queuedBatchJobs"),
    activeTerminalExecs: count("activeTerminalExecs"),
    queuedTerminalExecs: count("queuedTerminalExecs"),
    activeOtherJobs: count("activeOtherJobs"),
    queuedOtherJobs: count("queuedOtherJobs"),
    activeDesktopControls: count("activeDesktopControls"),
    queuedDesktopControls: count("queuedDesktopControls"),
  };
  work.total = Object.values(work).reduce((sum, item) => sum + item, 0);
  return work;
}

export class AgentLifecycle {
  constructor(options = {}) {
    this.state = "running";
    this.drainStartedAt = null;
    this.restartRequestedAt = null;
    this.upgradeRequestedAt = null;
    this.now = options.now ?? (() => Date.now());
    this.workSummary = options.workSummary ?? (() => ({}));
  }

  snapshot() {
    const work = normalizeWork(this.workSummary());
    return {
      state: this.state,
      drainStartedAt: this.drainStartedAt,
      restartRequestedAt: this.restartRequestedAt,
      upgradeRequestedAt: this.upgradeRequestedAt,
      readyToRestart: this.state === "draining" && work.total === 0,
      readyToUpgrade: this.state === "draining" && work.total === 0,
      work,
    };
  }

  drain() {
    if (this.state !== "restart-pending" && this.state !== "upgrade-pending") {
      this.state = "draining";
      this.drainStartedAt ??= new Date(this.now()).toISOString();
    }
    return { ok: true, lifecycle: this.snapshot() };
  }

  resume() {
    if (this.state === "restart-pending" || this.state === "upgrade-pending") {
      return {
        ok: false,
        error: this.state === "upgrade-pending" ? "upgrade_pending" : "restart_pending",
        lifecycle: this.snapshot(),
      };
    }
    this.state = "running";
    this.drainStartedAt = null;
    return { ok: true, lifecycle: this.snapshot() };
  }

  guard(action) {
    const name = String(action);
    if (this.state === "running") return null;
    if ((this.state === "restart-pending" || this.state === "upgrade-pending") && ALLOWED_WHILE_FINALIZING.has(name)) {
      return null;
    }
    if (this.state === "draining" && ALLOWED_WHILE_DRAINING.has(name)) return null;
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

  requestUpgrade() {
    if (this.state !== "draining") {
      return { ok: false, error: "drain_required", lifecycle: this.snapshot() };
    }
    const snapshot = this.snapshot();
    if (snapshot.work.total > 0) {
      return { ok: false, error: "active_work_remaining", lifecycle: snapshot };
    }
    this.state = "upgrade-pending";
    this.upgradeRequestedAt = new Date(this.now()).toISOString();
    return { ok: true, upgrade: true, lifecycle: this.snapshot() };
  }
}
