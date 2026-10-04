import { spawn } from "node:child_process";

export const CHAT_RELAY_PACKAGE = "@anusornneal/chat-relay@latest";
export const UPGRADE_LOOP_GUARD_ENV = "CHAT_RELAY_UPGRADE_GUARD_UNTIL";
export const UPGRADE_LOOP_GUARD_MS = 60_000;

function uiArgs(options = {}) {
  if (options.tuiEnabled === true) return ["--tui"];
  if (options.tuiEnabled === false) return ["--plain"];
  return [];
}

function windowsCommand(args) {
  return ["npx", "-y", CHAT_RELAY_PACKAGE, "remote", ...args]
    .map((part) => (/^[A-Za-z0-9_@./:-]+$/.test(part) ? part : `"${String(part).replaceAll('"', '\\"')}"`))
    .join(" ");
}

export function createUpgradeRelaunchSpec(options = {}, {
  platform = process.platform,
  env = process.env,
  now = Date.now(),
} = {}) {
  const guardUntil = Number(env?.[UPGRADE_LOOP_GUARD_ENV]) || 0;
  if (guardUntil > now) {
    return {
      ok: false,
      error: "upgrade_loop_guard",
      retryAt: new Date(guardUntil).toISOString(),
    };
  }

  const args = uiArgs(options);
  const childEnv = {
    ...env,
    [UPGRADE_LOOP_GUARD_ENV]: String(now + UPGRADE_LOOP_GUARD_MS),
  };

  if (platform === "win32") {
    return {
      ok: true,
      command: env?.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", windowsCommand(args)],
      options: {
        env: childEnv,
        stdio: "inherit",
        windowsHide: false,
      },
    };
  }

  return {
    ok: true,
    command: "npx",
    args: ["-y", CHAT_RELAY_PACKAGE, "remote", ...args],
    options: {
      env: childEnv,
      stdio: "inherit",
      windowsHide: false,
    },
  };
}

export function launchLatestRemote(options = {}, {
  spawnImpl = spawn,
  platform = process.platform,
  env = process.env,
  now = Date.now(),
} = {}) {
  const spec = createUpgradeRelaunchSpec(options, { platform, env, now });
  if (!spec.ok) return spec;

  try {
    const child = spawnImpl(spec.command, spec.args, spec.options);
    child?.unref?.();
    return {
      ok: true,
      pid: Number.isInteger(child?.pid) ? child.pid : null,
      package: CHAT_RELAY_PACKAGE,
    };
  } catch (error) {
    return {
      ok: false,
      error: "upgrade_relaunch_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
