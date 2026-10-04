import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_RELAY_PACKAGE,
  createUpgradeRelaunchSpec,
  launchLatestRemote,
  UPGRADE_LOOP_GUARD_ENV,
} from "../cli/self-update.mjs";

test("builds a direct npx relaunch on Unix-like platforms", () => {
  const spec = createUpgradeRelaunchSpec({ tuiEnabled: true }, {
    platform: "linux",
    env: {},
    now: 1_000,
  });
  assert.equal(spec.ok, true);
  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["-y", CHAT_RELAY_PACKAGE, "remote", "--tui"]);
  assert.equal(spec.options.env[UPGRADE_LOOP_GUARD_ENV], "61000");
});

test("builds a cmd handoff on Windows", () => {
  const spec = createUpgradeRelaunchSpec({ tuiEnabled: false }, {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    now: 2_000,
  });
  assert.equal(spec.ok, true);
  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(spec.args[3], /npx -y @anusornneal\/chat-relay@latest remote --plain/);
});

test("upgrade handoff loop guard rejects an immediate second relaunch", () => {
  const spec = createUpgradeRelaunchSpec({}, {
    platform: "linux",
    env: { [UPGRADE_LOOP_GUARD_ENV]: "90000" },
    now: 30_000,
  });
  assert.equal(spec.ok, false);
  assert.equal(spec.error, "upgrade_loop_guard");
  assert.equal(spec.retryAt, new Date(90_000).toISOString());
});

test("launchLatestRemote spawns and unreferences the handoff process", () => {
  let observed;
  let unreferenced = false;
  const result = launchLatestRemote({ tuiEnabled: true }, {
    platform: "linux",
    env: {},
    now: 5_000,
    spawnImpl(command, args, options) {
      observed = { command, args, options };
      return {
        pid: 4242,
        unref() { unreferenced = true; },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.pid, 4242);
  assert.equal(result.package, CHAT_RELAY_PACKAGE);
  assert.equal(observed.command, "npx");
  assert.deepEqual(observed.args, ["-y", CHAT_RELAY_PACKAGE, "remote", "--tui"]);
  assert.equal(unreferenced, true);
});

test("launchLatestRemote reports synchronous spawn failures", () => {
  const result = launchLatestRemote({}, {
    platform: "linux",
    env: {},
    now: 5_000,
    spawnImpl() {
      throw new Error("spawn unavailable");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "upgrade_relaunch_failed");
  assert.match(result.message, /spawn unavailable/);
});
