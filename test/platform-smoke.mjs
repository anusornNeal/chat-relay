import fs from "node:fs";
import { spawn } from "node:child_process";

import { DesktopManager, createDesktopPlatformAdapter } from "../agent/desktop-manager.mjs";
import { ProcessManager } from "../agent/process-manager.mjs";
import { TerminalManager } from "../agent/terminal-manager.mjs";
import { buildAgentHello } from "../agent/protocol.mjs";

const platform = process.platform;
const isWindows = platform === "win32";
const isMac = platform === "darwin";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function command(text) {
  return isWindows
    ? `Write-Output "${text}"`
    : `printf '${text}\\n'`;
}

async function waitForSession(manager, sessionId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    const result = manager.read(sessionId, 0);
    output = result.chunks.map((chunk) => chunk.text).join("");
    if (output.includes(expected)) return output;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session output missing ${expected}: ${output}`);
}

async function waitForBatch(manager, batchId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = manager.batchStatus(batchId);
    if (result.endedAt) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("batch did not finish");
}

async function terminalTests() {
  const manager = new TerminalManager({ platform, fastExecPoolSize: 2, fastExecIdleMs: 5000 });

  const execResult = await manager.exec(command("platform-exec-ok"));
  assert(execResult.ok && execResult.stdout.includes("platform-exec-ok"), "platform terminal exec failed");
  assert(execResult.execMode === "persistent-shell", "terminal exec did not use persistent fast path");

  const secondExec = await manager.exec(command("platform-exec-reuse"));
  assert(secondExec.ok && secondExec.stdout.includes("platform-exec-reuse"), "persistent shell reuse failed");

  const stateSet = isWindows
    ? '$chatRelayFastLocal = "secret"; Write-Output "state-set"'
    : "CHAT_RELAY_FAST_LOCAL=secret; printf 'state-set\\n'";
  const stateCheck = isWindows
    ? 'if (Get-Variable chatRelayFastLocal -ErrorAction SilentlyContinue) { Write-Output "leaked" } else { Write-Output "clean" }'
    : "printf '%s\\n' \"${CHAT_RELAY_FAST_LOCAL-unset}\"";
  const stateSetResult = await manager.exec(stateSet);
  const stateCheckResult = await manager.exec(stateCheck);
  assert(stateSetResult.ok && stateSetResult.execMode === "persistent-shell", "fast exec state setup failed");
  assert(stateCheckResult.ok && (isWindows ? stateCheckResult.stdout.includes("clean") : stateCheckResult.stdout.includes("unset")), "persistent shell leaked command state");

  const failedExec = await manager.exec(isWindows ? "Get-Item 'Z:\\__chat_relay_missing__' -ErrorAction Stop" : "false");
  assert(!failedExec.ok && failedExec.exitCode !== 0 && failedExec.execMode === "persistent-shell", "fast exec failure semantics changed");

  const parallel = await Promise.all([
    manager.exec(command("platform-parallel-a")),
    manager.exec(command("platform-parallel-b")),
  ]);
  assert(parallel.every((item) => item.ok && item.execMode === "persistent-shell"), "parallel persistent exec failed");

  const isolated = new TerminalManager({ platform, fastExec: false });
  const isolatedExec = await isolated.exec(command("platform-isolated-ok"));
  assert(isolatedExec.ok && isolatedExec.execMode === "isolated", "isolated terminal fallback failed");
  isolated.close();

  if (isWindows) {
    const statefulFallback = await manager.exec('$env:CHAT_RELAY_FAST_TEST = "x"; Write-Output $env:CHAT_RELAY_FAST_TEST');
    assert(statefulFallback.ok && statefulFallback.execMode === "isolated", "stateful PowerShell command did not use isolated fallback");
  }

  const execConfig = manager.getExecConfig();
  assert(execConfig.enabled && execConfig.stats.persistent >= 5 && execConfig.pool?.workers >= 1, "fast exec observability missing");

  const session = manager.start(command("platform-session-ok"));
  await waitForSession(manager, session.sessionId, "platform-session-ok");

  const batch = manager.batchStart([
    command("platform-batch-a"),
    command("platform-batch-b"),
  ], { concurrency: 2 });
  const status = await waitForBatch(manager, batch.batchId);
  assert(status.counts.completed === 2, "platform terminal batch failed");
  const batchOutput = manager.batchRead(batch.batchId).jobs.map((job) => job.stdout).join("\n");
  assert(batchOutput.includes("platform-batch-a") && batchOutput.includes("platform-batch-b"), "platform batch output missing");

  const shell = manager.startShell();
  await new Promise((resolve) => setTimeout(resolve, 150));
  manager.write(shell.sessionId, command("platform-shell-ok"));
  await waitForSession(manager, shell.sessionId, "platform-shell-ok");
  await manager.kill(shell.sessionId);
  manager.close();
}

async function processTests() {
  const manager = new ProcessManager({ platform });
  const listed = await manager.list("node");
  assert(Array.isArray(listed) && listed.some((item) => Number(item.ProcessId) === process.pid), "current node process missing");

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert(Number.isInteger(child.pid) && child.pid > 100, "test child did not start");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await manager.kill(child.pid);
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 1500);
  });
  assert(child.exitCode !== null || child.signalCode !== null, "process kill did not terminate child");
}

function capabilityTests() {
  const desktop = createDesktopPlatformAdapter({
    platform,
    runner: async () => ({ ok: true }),
  });
  const expectedDesktop = isWindows || isMac;
  assert(desktop.supported === expectedDesktop, "desktop platform support mismatch");

  const hello = buildAgentHello({
    platform,
    terminalEnabled: true,
    desktopEnabled: expectedDesktop,
  });
  assert(hello.capabilities.includes("terminal.exec"), "terminal capability missing");
  assert(hello.capabilities.includes("git.worktree.cleanup"), "worktree cleanup capability missing");
  if (expectedDesktop) {
    assert(hello.capabilities.includes("desktop.screenshot"), "desktop capability missing");
  }
  new DesktopManager({ enabled: expectedDesktop, adapter: desktop }).close();
}

function macNativeToolTests() {
  if (!isMac) return;
  for (const file of [
    "/bin/zsh",
    "/usr/bin/osascript",
    "/usr/bin/pbcopy",
    "/usr/bin/pbpaste",
    "/usr/bin/sips",
    "/usr/sbin/screencapture",
  ]) {
    fs.accessSync(file, fs.constants.X_OK);
  }
}

capabilityTests();
macNativeToolTests();
await terminalTests();
await processTests();

console.log(`platform smoke test passed: ${platform}/${process.arch}`);
