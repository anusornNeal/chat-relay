import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLifecycle,
  AGENT_RESTART_EXIT_CODE,
  AGENT_UPGRADE_EXIT_CODE,
  summarizeAgentWork,
} from "../agent/lifecycle.mjs";
import { shouldRestartAgent } from "../cli/remote.mjs";
import { CapabilityScheduler } from "../agent/capability-scheduler.mjs";

test("upgrade requires drain and zero active work", () => {
  let activeSessions = 1;
  const lifecycle = new AgentLifecycle({
    now: () => 10_000,
    workSummary: () => ({ activeSessions }),
  });

  assert.equal(lifecycle.requestUpgrade().error, "drain_required");
  lifecycle.drain();
  assert.equal(lifecycle.requestUpgrade().error, "active_work_remaining");

  activeSessions = 0;
  assert.equal(lifecycle.snapshot().readyToUpgrade, true);
  const result = lifecycle.requestUpgrade();
  assert.equal(result.ok, true);
  assert.equal(result.upgrade, true);
  assert.equal(result.lifecycle.state, "upgrade-pending");
  assert.equal(result.lifecycle.upgradeRequestedAt, new Date(10_000).toISOString());
  assert.equal(lifecycle.resume().error, "upgrade_pending");
});

test("restart behavior remains unchanged", () => {
  const lifecycle = new AgentLifecycle({ workSummary: () => ({}) });
  lifecycle.drain();
  const result = lifecycle.requestRestart();
  assert.equal(result.ok, true);
  assert.equal(result.restart, true);
  assert.equal(result.lifecycle.state, "restart-pending");
});

test("supervisor distinguishes restart from upgrade handoff exits", () => {
  assert.equal(AGENT_RESTART_EXIT_CODE, 4);
  assert.equal(AGENT_UPGRADE_EXIT_CODE, 5);
  assert.equal(shouldRestartAgent({ code: AGENT_RESTART_EXIT_CODE }), true);
  assert.equal(shouldRestartAgent({ code: AGENT_UPGRADE_EXIT_CODE }), false);
  assert.equal(shouldRestartAgent({ code: 2 }), false);
  assert.equal(shouldRestartAgent({ code: 3 }), false);
  assert.equal(shouldRestartAgent({ code: 1 }), true);
});

test("drain readiness includes filesystem, process, terminal-control, desktop-read, and desktop-control work", () => {
  const work = summarizeAgentWork({
    terminal: {
      sessions: [{ status: "running" }],
      activeExecJobs: 1,
      queuedJobs: 2,
    },
    scheduler: {
      terminalExec: { active: 1, queued: 1 },
      filesystem: { active: 2, queued: 3 },
      process: { active: 1, queued: 0 },
      terminalControl: { active: 1, queued: 1 },
      desktopRead: { active: 1, queued: 2 },
      agent: { active: 99, queued: 99 },
    },
    desktop: {
      controlQueue: { active: 1, queued: 4 },
    },
  });

  assert.deepEqual(work, {
    activeSessions: 1,
    activeBatchJobs: 1,
    queuedBatchJobs: 2,
    activeTerminalExecs: 1,
    queuedTerminalExecs: 1,
    activeOtherJobs: 5,
    queuedOtherJobs: 6,
    activeDesktopControls: 1,
    queuedDesktopControls: 4,
  });

  const lifecycle = new AgentLifecycle({ workSummary: () => work });
  lifecycle.drain();
  assert.equal(lifecycle.requestUpgrade().error, "active_work_remaining");
  assert.equal(lifecycle.snapshot().work.total, 22);
});

test("pending restart or upgrade stops admitting drain-safe I/O before process exit", () => {
  const upgrade = new AgentLifecycle({ workSummary: () => ({}) });
  upgrade.drain();
  assert.equal(upgrade.guard("fs.read"), null);
  assert.equal(upgrade.requestUpgrade().ok, true);
  assert.equal(upgrade.guard("fs.read").error, "agent_draining");
  assert.equal(upgrade.guard("desktop.screenshot").error, "agent_draining");
  assert.equal(upgrade.guard("agent.lifecycle.status"), null);

  const restart = new AgentLifecycle({ workSummary: () => ({}) });
  restart.drain();
  assert.equal(restart.requestRestart().ok, true);
  assert.equal(restart.guard("terminal.read").error, "agent_draining");
  assert.equal(restart.guard("ping"), null);
});

test("desktop read operations share the tracked desktopRead scheduler lane", async () => {
  const scheduler = new CapabilityScheduler({ desktopReadConcurrency: 1, queueTimeoutMs: 5_000 });
  let releaseFirst;
  const blocker = new Promise((resolve) => { releaseFirst = resolve; });
  const first = scheduler.run("desktop.clipboard.read", async () => {
    await blocker;
    return "first";
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = scheduler.run("desktop.window.list", async () => "second");
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = scheduler.snapshot().desktopRead;
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.queued, 1);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(scheduler.snapshot().desktopRead.active, 0);
  assert.equal(scheduler.snapshot().desktopRead.queued, 0);
});
