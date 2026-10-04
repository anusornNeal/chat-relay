import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLifecycle,
  AGENT_RESTART_EXIT_CODE,
  AGENT_UPGRADE_EXIT_CODE,
} from "../agent/lifecycle.mjs";
import { shouldRestartAgent } from "../cli/remote.mjs";

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
