import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  createTerminalSessionId,
  terminalContinuityConfig,
  terminalSessionMiss,
} from "./terminal-continuity.mjs";

const MAX_EXEC_BUFFER = 48 * 1024;
const MAX_SESSION_BUFFER = 256 * 1024;
const MAX_READ_CHARS = 24 * 1024;
const MAX_INPUT_CHARS = 8 * 1024;
const MAX_SESSIONS = 8;
const MAX_BATCH_SIZE = 20;
const MAX_BATCH_CONCURRENCY = 8;
const DEFAULT_BATCH_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUED_JOBS = 64;
const MAX_QUEUED_JOBS = 256;
const DEFAULT_FAST_EXEC_POOL_SIZE = 2;
const MAX_FAST_EXEC_POOL_SIZE = 4;
const DEFAULT_FAST_EXEC_IDLE_MS = 60 * 1000;
const MIN_FAST_EXEC_IDLE_MS = 5 * 1000;
const MAX_FAST_EXEC_IDLE_MS = 10 * 60 * 1000;
const MAX_BATCH_READ_CHARS = 24 * 1024;
const MAX_JOB_READ_CHARS = 8 * 1024;
const MAX_RETAINED_BATCHES = 64;
const ENDED_TTL_MS = 30 * 60 * 1000;

const BLOCKED_COMMANDS = [
  /\b(mkfs|format|mount|umount|fdisk|dd|parted|diskpart|sudo|su|passwd)\b/i,
  /\b(adduser|useradd|usermod|groupadd|chsh|visudo|shutdown|reboot|halt)\b/i,
  /\b(poweroff|init|iptables|firewall|netsh|sfc|bcdedit|runas|cipher|takeown)\b/i,
  /\b(reg|sc)\.exe\b/i,
];

function validateCommand(command) {
  if (typeof command !== "string" || command.length === 0 || command.length > 4000) {
    throw new Error("invalid_command");
  }
  if (BLOCKED_COMMANDS.some((pattern) => pattern.test(command))) {
    throw new Error("command_blocked");
  }
}

function normalizeTimeout(timeoutMs, fallback = 15000, max = 20000) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1000), max);
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function safeCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return process.cwd();
  if (typeof cwd !== "string" || cwd.length > 1024) throw new Error("invalid_cwd");
  return cwd;
}

export function shellForPlatform(platform, preferredShell) {
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      displayName: "powershell",
      commandArgs: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      interactiveArgs: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
      persistentArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    };
  }
  const file = preferredShell || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return {
    file,
    displayName: path.basename(file),
    commandArgs: (command) => ["-lc", command],
    interactiveArgs: ["-l"],
    persistentArgs: platform === "darwin" && path.basename(file) === "zsh" ? ["-f"] : [],
  };
}

function terminateProcessTree(platform, pid) {
  if (platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
  }
  return new Promise((resolve) => {
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      resolve();
    }, 150);
  });
}

function quotePowerShell(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function quotePosix(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function canUsePersistentExec(platform, command) {
  if (typeof command !== "string" || command.includes("\0")) return false;
  if (platform === "win32") {
    return !/\b(exit|stop-process|taskkill(?:\.exe)?|start-process\s+-wait|set-location|push-location|pop-location|set-alias|new-alias|remove-alias|set-variable|new-variable|remove-variable|import-module|remove-module|set-psdebug|set-strictmode)\b|\$(?:env|global|script):/i.test(command);
  }
  return !/(^|[^&])&([^&]|$)/.test(command);
}

function persistentExecScript(platform, command, cwd, marker) {
  const begin = marker + "_BEGIN__";
  const endPrefix = marker + "_END_";
  const endSuffix = "__";

  if (platform === "win32") {
    const psCommand = quotePowerShell(command);
    const psCwd = quotePowerShell(cwd);
    const psBegin = quotePowerShell(begin);
    const psEndPrefix = quotePowerShell(endPrefix);
    const psEndSuffix = quotePowerShell(endSuffix);
    return [
      "& {",
      "  [Console]::Out.Write(" + psBegin + ")",
      "  [Console]::Error.Write(" + psBegin + ")",
      "  $__ChatRelayOldLocation = (Get-Location).Path",
      "  $global:LASTEXITCODE = $null",
      "  $__ChatRelayExitCode = 0",
      "  try {",
      "    Set-Location -LiteralPath " + psCwd,
      "    & ([ScriptBlock]::Create(" + psCommand + "))",
      "    $__ChatRelaySucceeded = $?",
      "    if ($null -ne $global:LASTEXITCODE) {",
      "      $__ChatRelayExitCode = [Math]::Max(0, [Math]::Min(2147483647, [int]$global:LASTEXITCODE))",
      "    } elseif (-not $__ChatRelaySucceeded) {",
      "      $__ChatRelayExitCode = 1",
      "    }",
      "  } catch {",
      "    [Console]::Error.Write(($_ | Out-String))",
      "    $__ChatRelayExitCode = 1",
      "  } finally {",
      "    Set-Location -LiteralPath $__ChatRelayOldLocation -ErrorAction SilentlyContinue",
      "  }",
      "  $__ChatRelayEnd = " + psEndPrefix + " + [string]$__ChatRelayExitCode + " + psEndSuffix,
      "  [Console]::Out.Write($__ChatRelayEnd)",
      "  [Console]::Error.Write($__ChatRelayEnd)",
      "}",
    ].join("\n");
  }

  const shCommand = quotePosix(command);
  const shCwd = quotePosix(cwd);
  const shBegin = quotePosix(begin);
  const shEndPrefix = quotePosix(endPrefix);
  const shEndSuffix = quotePosix(endSuffix);
  return [
    "printf %s " + shBegin,
    "printf %s " + shBegin + " >&2",
    "(",
    "  cd -- " + shCwd + " || exit 200",
    "  eval " + shCommand,
    ")",
    "__chat_relay_exit_code=$?",
    "printf '%s%s%s' " + shEndPrefix + " \"$__chat_relay_exit_code\" " + shEndSuffix,
    "printf '%s%s%s' " + shEndPrefix + " \"$__chat_relay_exit_code\" " + shEndSuffix + " >&2",
  ].join("\n");
}

class PersistentExecWorker {
  constructor({ platform, shell }) {
    this.platform = platform;
    this.shell = shell;
    this.child = null;
    this.startPromise = null;
    this.current = null;
    this.reserved = false;
    this.idleTimer = null;
  }

  get busy() {
    return this.reserved || this.current !== null;
  }

  async run(command, cwd, timeoutMs) {
    if (this.reserved || this.current) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "", error: "fast_exec_busy", fastExecUnavailable: true };
    }
    this.reserved = true;
    try {
      await this.#ensureStarted();
      if (!this.child?.stdin?.writable) {
        return { ok: false, exitCode: 1, stdout: "", stderr: "", error: "fast_exec_unavailable", fastExecUnavailable: true };
      }

      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      const marker = "__CHAT_RELAY_" + randomUUID().replace(/-/g, "") + "__";
      const begin = marker + "_BEGIN__";
      const endPrefix = marker + "_END_";
      const endSuffix = "__";

      return await new Promise((resolve) => {
        const current = {
          resolve,
          begin,
          endPrefix,
          endSuffix,
          stdout: "",
          stderr: "",
          stdoutBuffer: "",
          stderrBuffer: "",
          stdoutStarted: false,
          stderrStarted: false,
          stdoutEnded: false,
          stderrEnded: false,
          exitCode: 0,
          startedAt: Date.now(),
          timer: null,
        };
        current.timer = setTimeout(() => {
          if (this.current !== current) return;
          this.current = null;
          void this.#terminate();
          resolve({
            ok: false,
            exitCode: 1,
            stdout: current.stdout,
            stderr: current.stderr,
            error: "Command timed out after " + timeoutMs + "ms",
            execMode: "persistent-shell",
          });
        }, timeoutMs);
        this.current = current;

        const script = persistentExecScript(this.platform, command, cwd, marker);
        try {
          this.child.stdin.write(script + os.EOL + os.EOL);
        } catch (error) {
          clearTimeout(current.timer);
          this.current = null;
          resolve({
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "",
            error: error instanceof Error ? error.message : "fast_exec_write_failed",
            fastExecUnavailable: true,
          });
        }
      });
    } finally {
      this.reserved = false;
    }
  }

  scheduleIdleClose(idleMs) {
    if (this.busy || !this.child) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy) void this.#terminate();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  close() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    void this.#terminate();
  }

  async #ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(this.shell.file, this.shell.persistentArgs || [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      const onError = (error) => {
        cleanup();
        if (this.child === child) this.child = null;
        reject(error);
      };
      const onSpawn = () => {
        cleanup();
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.#onData("stdout", chunk));
        child.stderr.on("data", (chunk) => this.#onData("stderr", chunk));
        child.stdin.on("error", (error) => this.#onPipeError(child, error));
        child.on("exit", (code, signal) => this.#onExit(child, code, signal));
        child.on("error", () => {});
        resolve();
      };
      const cleanup = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  #onData(stream, chunk) {
    const current = this.current;
    if (!current) return;
    const bufferKey = stream + "Buffer";
    const startedKey = stream + "Started";
    const endedKey = stream + "Ended";
    const outputKey = stream;

    current[bufferKey] += String(chunk);
    if (!current[startedKey]) {
      const beginIndex = current[bufferKey].indexOf(current.begin);
      if (beginIndex < 0) {
        if (current[bufferKey].length > current.begin.length) {
          current[bufferKey] = current[bufferKey].slice(-current.begin.length);
        }
        return;
      }
      current[bufferKey] = current[bufferKey].slice(beginIndex + current.begin.length);
      current[startedKey] = true;
    }

    const endIndex = current[bufferKey].indexOf(current.endPrefix);
    if (endIndex < 0) {
      if (Buffer.byteLength(current[bufferKey], "utf8") > MAX_EXEC_BUFFER + current.endPrefix.length + 32) {
        this.#overflow(stream, current);
      }
      return;
    }

    const tail = current[bufferKey].slice(endIndex + current.endPrefix.length);
    const suffixIndex = tail.indexOf(current.endSuffix);
    if (suffixIndex < 0) return;

    current[outputKey] += current[bufferKey].slice(0, endIndex);
    const parsedCode = Number.parseInt(tail.slice(0, suffixIndex), 10);
    if (Number.isInteger(parsedCode)) current.exitCode = parsedCode;
    current[bufferKey] = tail.slice(suffixIndex + current.endSuffix.length);
    current[endedKey] = true;

    if (Buffer.byteLength(current[outputKey], "utf8") > MAX_EXEC_BUFFER) {
      this.#overflow(stream, current);
      return;
    }
    this.#completeIfDone(current);
  }

  #overflow(stream, current) {
    if (this.current !== current) return;
    clearTimeout(current.timer);
    const clipped = clipText(current[stream] + current[stream + "Buffer"], MAX_EXEC_BUFFER);
    current[stream] = clipped.text;
    this.current = null;
    void this.#terminate();
    current.resolve({
      ok: false,
      exitCode: 1,
      stdout: current.stdout,
      stderr: current.stderr,
      error: stream + " maxBuffer exceeded",
      execMode: "persistent-shell",
    });
  }

  #completeIfDone(current) {
    if (this.current !== current || !current.stdoutEnded || !current.stderrEnded) return;
    clearTimeout(current.timer);
    this.current = null;
    current.resolve({
      ok: current.exitCode === 0,
      exitCode: current.exitCode,
      stdout: current.stdout,
      stderr: current.stderr,
      error: current.exitCode === 0 ? null : "Command failed with exit code " + current.exitCode,
      execMode: "persistent-shell",
      shellMs: Math.max(0, Date.now() - current.startedAt),
    });
  }

  #onPipeError(child, error) {
    if (this.child !== child) return;
    const current = this.current;
    if (!current) return;
    clearTimeout(current.timer);
    this.current = null;
    void this.#terminate();
    current.resolve({
      ok: false,
      exitCode: 1,
      stdout: current.stdout,
      stderr: current.stderr,
      error: "Persistent shell pipe failed: " + (error instanceof Error ? error.message : String(error)),
      execMode: "persistent-shell",
    });
  }

  #onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const current = this.current;
    if (!current) return;
    clearTimeout(current.timer);
    this.current = null;
    current.resolve({
      ok: false,
      exitCode: Number.isInteger(code) ? code : 1,
      stdout: current.stdout,
      stderr: current.stderr,
      error: signal ? "Persistent shell exited with signal " + signal : "Persistent shell exited unexpectedly",
      execMode: "persistent-shell",
    });
  }

  async #terminate() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin?.end(); } catch {}
    if (child.exitCode !== null || child.signalCode !== null) return;
    await terminateProcessTree(this.platform, child.pid);
  }
}

class PersistentExecPool {
  constructor({ platform, shell, size, idleMs }) {
    this.platform = platform;
    this.shell = shell;
    this.size = size;
    this.idleMs = idleMs;
    this.workers = [];
    this.queue = [];
  }

  exec(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
      this.queue.push({ command, cwd, timeoutMs, resolve });
      this.#pump();
    });
  }

  snapshot() {
    return {
      enabled: true,
      size: this.size,
      workers: this.workers.length,
      busy: this.workers.filter((worker) => worker.busy).length,
      queued: this.queue.length,
      idleMs: this.idleMs,
    };
  }

  close() {
    for (const worker of this.workers) worker.close();
    this.workers.length = 0;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job.resolve({ ok: false, exitCode: 1, stdout: "", stderr: "", error: "terminal_closed" });
    }
  }

  #pump() {
    while (this.queue.length > 0) {
      let worker = this.workers.find((item) => !item.busy);
      if (!worker && this.workers.length < this.size) {
        worker = new PersistentExecWorker({ platform: this.platform, shell: this.shell });
        this.workers.push(worker);
      }
      if (!worker) return;

      const job = this.queue.shift();
      worker.run(job.command, job.cwd, job.timeoutMs)
        .then(job.resolve)
        .catch((error) => job.resolve({
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : "fast_exec_unavailable",
          fastExecUnavailable: true,
        }))
        .finally(() => {
          worker.scheduleIdleClose(this.idleMs);
          this.#pump();
        });
    }
  }
}

function clipText(value, limit) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function clipJobOutput(stdout, stderr, limit = MAX_JOB_READ_CHARS) {
  const rawStdout = typeof stdout === "string" ? stdout : "";
  const rawStderr = typeof stderr === "string" ? stderr : "";
  const stdoutBudget = rawStderr ? Math.floor(limit / 2) : limit;
  const clippedStdout = clipText(rawStdout, stdoutBudget);
  const stderrBudget = Math.max(0, limit - clippedStdout.text.length);
  const clippedStderr = clipText(rawStderr, stderrBudget);
  return {
    stdout: clippedStdout.text,
    stderr: clippedStderr.text,
    truncated: clippedStdout.truncated || clippedStderr.truncated,
  };
}

export class TerminalManager {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.shell = shellForPlatform(this.platform, options.shell);
    this.sessions = new Map();
    this.processEpoch = options.processEpoch ?? randomUUID();
    this.batches = new Map();
    this.batchQueue = [];
    this.activeBatchJobs = 0;
    this.batchConcurrency = normalizeInteger(
      options.batchConcurrency,
      DEFAULT_BATCH_CONCURRENCY,
      1,
      MAX_BATCH_CONCURRENCY,
    );
    this.maxQueuedJobs = normalizeInteger(
      options.maxQueuedJobs,
      DEFAULT_MAX_QUEUED_JOBS,
      1,
      MAX_QUEUED_JOBS,
    );
    this.fastExecEnabled = options.fastExec !== false;
    this.fastExecPoolSize = normalizeInteger(
      options.fastExecPoolSize,
      DEFAULT_FAST_EXEC_POOL_SIZE,
      1,
      MAX_FAST_EXEC_POOL_SIZE,
    );
    this.fastExecIdleMs = normalizeInteger(
      options.fastExecIdleMs,
      DEFAULT_FAST_EXEC_IDLE_MS,
      MIN_FAST_EXEC_IDLE_MS,
      MAX_FAST_EXEC_IDLE_MS,
    );
    this.fastExecPool = this.fastExecEnabled
      ? new PersistentExecPool({
          platform: this.platform,
          shell: this.shell,
          size: this.fastExecPoolSize,
          idleMs: this.fastExecIdleMs,
        })
      : null;
    this.fastExecStats = { persistent: 0, isolated: 0, unavailable: 0 };
  }

  async exec(command, cwd, timeoutMs) {
    validateCommand(command);
    const resolvedCwd = safeCwd(cwd);
    const timeout = normalizeTimeout(timeoutMs);

    if (this.fastExecPool && canUsePersistentExec(this.platform, command)) {
      const result = await this.fastExecPool.exec(command, resolvedCwd, timeout);
      if (!result?.fastExecUnavailable) {
        this.fastExecStats.persistent += 1;
        return result;
      }
      this.fastExecStats.unavailable += 1;
    }

    this.fastExecStats.isolated += 1;
    return this.#execIsolated(command, resolvedCwd, timeout);
  }

  #execIsolated(command, resolvedCwd, timeout) {
    return new Promise((resolve) => {
      execFile(
        this.shell.file,
        this.shell.commandArgs(command),
        {
          cwd: resolvedCwd,
          timeout,
          windowsHide: true,
          maxBuffer: MAX_EXEC_BUFFER,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            exitCode: typeof error?.code === "number" ? error.code : (error ? 1 : 0),
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            error: error ? error.message : null,
            execMode: "isolated",
          });
        },
      );
    });
  }

  getExecConfig() {
    return {
      enabled: this.fastExecEnabled,
      poolSize: this.fastExecPoolSize,
      idleMs: this.fastExecIdleMs,
      stats: { ...this.fastExecStats },
      pool: this.fastExecPool?.snapshot() || null,
    };
  }

  close() {
    this.fastExecPool?.close();
  }

  start(command, cwd, observability) {
    validateCommand(command);
    return this.#spawnSession({
      type: "command",
      command,
      cwd: safeCwd(cwd),
      args: this.shell.commandArgs(command),
      observability,
    });
  }

  startShell(cwd, observability) {
    return this.#spawnSession({
      type: "shell",
      command: this.shell.displayName,
      cwd: safeCwd(cwd),
      args: this.shell.interactiveArgs,
      observability,
    });
  }

  list() {
    this.#cleanup();
    return [...this.sessions.values()].map((session) => this.#summary(session));
  }

  getContinuityConfig() {
    const activeSessions = [...this.sessions.values()]
      .filter((session) => session.status === "running").length;
    return terminalContinuityConfig(this.processEpoch, activeSessions);
  }

  observability() {
    this.#cleanup();
    return {
      ok: true,
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.id,
        processEpoch: session.processEpoch,
        type: session.type,
        status: session.status,
        exitCode: session.exitCode,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        ...(session.observability?.userId ? { userId: session.observability.userId } : {}),
        ...(session.observability?.activityId ? { activityId: session.observability.activityId } : {}),
        ...(session.observability?.toolCallId ? { toolCallId: session.observability.toolCallId } : {}),
      })),
      batches: [...this.batches.values()].map((batch) => ({
        batchId: batch.batchId,
        createdAt: batch.createdAt,
        endedAt: batch.endedAt,
        cancelled: batch.cancelled,
        ...(batch.observability?.userId ? { userId: batch.observability.userId } : {}),
        ...(batch.observability?.activityId ? { activityId: batch.observability.activityId } : {}),
        ...(batch.observability?.toolCallId ? { toolCallId: batch.observability.toolCallId } : {}),
        counts: this.#batchSummary(batch).counts,
        jobs: batch.jobs.map((job) => ({
          jobId: job.jobId,
          status: job.status,
          queuedAt: job.queuedAt,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          durationMs: job.durationMs,
          exitCode: job.exitCode,
        })),
      })),
      activeExecJobs: this.activeBatchJobs,
      queuedJobs: this.batchQueue.length,
    };
  }

  read(sessionId, afterSeq = 0, maxChars = MAX_READ_CHARS) {
    this.#cleanup();
    const session = this.#get(sessionId);
    if (!session) return terminalSessionMiss(sessionId, this.processEpoch);
    const limit = Math.min(Math.max(Number(maxChars) || MAX_READ_CHARS, 1024), MAX_READ_CHARS);
    const oldestSeq = session.chunks[0]?.seq ?? session.nextSeq;
    const chunks = [];
    let chars = 0;

    for (const chunk of session.chunks) {
      if (chunk.seq <= afterSeq) continue;
      if (chunks.length > 0 && chars + chunk.text.length > limit) break;
      chunks.push(chunk);
      chars += chunk.text.length;
    }

    return {
      ...this.#summary(session),
      chunks,
      oldestSeq,
      nextSeq: chunks.at(-1)?.seq ?? afterSeq,
      truncated: afterSeq < oldestSeq - 1,
    };
  }

  write(sessionId, input, appendNewline = true) {
    const session = this.#get(sessionId);
    if (!session) return terminalSessionMiss(sessionId, this.processEpoch);
    if (session.status !== "running") throw new Error("session_not_running");
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_CHARS) {
      throw new Error("invalid_input");
    }
    session.process.stdin.write(input + (appendNewline ? os.EOL : ""));
    return this.#summary(session);
  }

  async kill(sessionId) {
    const session = this.#get(sessionId);
    if (!session) return terminalSessionMiss(sessionId, this.processEpoch);
    if (session.status !== "running") return this.#summary(session);

    await terminateProcessTree(this.platform, session.pid);
    return this.#summary(session);
  }

  batchStart(jobs, options = {}) {
    this.#cleanup();
    if (!Array.isArray(jobs) || jobs.length < 2 || jobs.length > MAX_BATCH_SIZE) {
      throw new Error("invalid_batch_size");
    }
    const defaultCwd = safeCwd(options.cwd);
    const defaultTimeoutMs = normalizeTimeout(options.timeoutMs);
    const requestedConcurrency = normalizeInteger(
      options.concurrency,
      this.batchConcurrency,
      1,
      this.batchConcurrency,
    );
    const availableSlots = Math.max(0, this.batchConcurrency - this.activeBatchJobs);
    const immediatelyRunnable = this.batchQueue.length === 0
      ? Math.min(jobs.length, availableSlots, requestedConcurrency)
      : 0;
    const projectedQueuedJobs = this.batchQueue.length + jobs.length - immediatelyRunnable;
    if (projectedQueuedJobs > this.maxQueuedJobs) {
      throw new Error("queue_full");
    }
    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    const batch = {
      batchId,
      createdAt,
      endedAt: null,
      requestedConcurrency,
      cancelled: false,
      observability: options.observability ?? null,
      jobs: jobs.map((input, index) => {
        const item = typeof input === "string" ? { command: input } : input;
        validateCommand(item?.command);
        return {
          jobId: randomUUID(),
          index,
          command: item.command,
          cwd: safeCwd(item.cwd ?? defaultCwd),
          timeoutMs: normalizeTimeout(item.timeoutMs, defaultTimeoutMs),
          status: "queued",
          queuedAt: createdAt,
          startedAt: null,
          endedAt: null,
          queueWaitMs: null,
          durationMs: null,
          exitCode: null,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          error: null,
          process: null,
        };
      }),
    };

    this.batches.set(batchId, batch);
    for (const job of batch.jobs) this.batchQueue.push({ batchId, jobId: job.jobId });
    this.#drainBatchQueue();

    return this.#batchSummary(batch);
  }

  batchStatus(batchId) {
    this.#cleanup();
    const batch = this.#getBatch(batchId);
    return this.#batchSummary(batch);
  }

  batchRead(batchId, maxChars = MAX_BATCH_READ_CHARS) {
    this.#cleanup();
    const batch = this.#getBatch(batchId);
    const aggregateLimit = normalizeInteger(maxChars, MAX_BATCH_READ_CHARS, 1024, MAX_BATCH_READ_CHARS);
    let remaining = aggregateLimit;
    let truncated = false;
    const jobs = batch.jobs.map((job) => {
      const perJobLimit = Math.min(MAX_JOB_READ_CHARS, remaining);
      const output = clipJobOutput(job.stdout, job.stderr, perJobLimit);
      remaining = Math.max(0, remaining - output.stdout.length - output.stderr.length);
      truncated ||= job.outputTruncated || output.truncated ||
        ((job.stdout.length + job.stderr.length) > (output.stdout.length + output.stderr.length));
      return {
        ...this.#jobSummary(job),
        stdout: output.stdout,
        stderr: output.stderr,
        outputTruncated: job.outputTruncated || output.truncated,
      };
    });
    return { ...this.#batchSummary(batch), jobs, truncated, maxChars: aggregateLimit };
  }

  async batchCancel(batchId) {
    this.#cleanup();
    const batch = this.#getBatch(batchId);
    batch.cancelled = true;
    const cancelledAt = new Date().toISOString();
    this.batchQueue = this.batchQueue.filter((queued) => {
      if (queued.batchId !== batchId) return true;
      const job = batch.jobs.find((item) => item.jobId === queued.jobId);
      if (job && job.status === "queued") {
        job.status = "cancelled";
        job.endedAt = cancelledAt;
      }
      return false;
    });

    const running = batch.jobs.filter((job) => job.status === "running" && job.process?.pid);
    await Promise.all(running.map((job) => terminateProcessTree(this.platform, job.process.pid)));

    this.#finishBatchIfDone(batch);
    this.#drainBatchQueue();
    return this.#batchSummary(batch);
  }

  getBatchConfig() {
    return {
      maxBatchSize: MAX_BATCH_SIZE,
      batchConcurrency: this.batchConcurrency,
      maxQueuedJobs: this.maxQueuedJobs,
      activeBatchJobs: this.activeBatchJobs,
      queuedBatchJobs: this.batchQueue.length,
    };
  }

  #spawnSession({ type, command, cwd, args, observability }) {
    this.#cleanup();
    const running = [...this.sessions.values()].filter((session) => session.status === "running").length;
    if (running >= MAX_SESSIONS) throw new Error("too_many_sessions");

    const child = spawn(this.shell.file, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.platform !== "win32",
    });

    const session = {
      id: createTerminalSessionId(this.processEpoch, randomUUID()),
      processEpoch: this.processEpoch,
      type,
      command,
      cwd,
      pid: child.pid,
      process: child,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      chunks: [],
      nextSeq: 1,
      totalChars: 0,
      observability: observability ?? null,
    };

    this.sessions.set(session.id, session);
    child.stdout.on("data", (data) => this.#append(session, "stdout", data));
    child.stderr.on("data", (data) => this.#append(session, "stderr", data));
    child.on("error", (error) => this.#append(session, "stderr", error.message + os.EOL));
    child.on("exit", (code, signal) => {
      session.status = "exited";
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = new Date().toISOString();
    });

    return this.#summary(session);
  }

  #drainBatchQueue() {
    while (this.activeBatchJobs < this.batchConcurrency && this.batchQueue.length > 0) {
      const next = this.batchQueue.findIndex((entry) => {
        const batch = this.batches.get(entry.batchId);
        if (!batch || batch.cancelled) return false;
        const runningForBatch = batch.jobs.filter((job) => job.status === "running").length;
        return runningForBatch < batch.requestedConcurrency;
      });
      if (next < 0) break;

      const [{ batchId, jobId }] = this.batchQueue.splice(next, 1);
      const batch = this.batches.get(batchId);
      const job = batch?.jobs.find((item) => item.jobId === jobId);
      if (!batch || !job || job.status !== "queued") continue;
      this.#runBatchJob(batch, job);
    }
  }

  #runBatchJob(batch, job) {
    this.activeBatchJobs += 1;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.queueWaitMs = Date.now() - Date.parse(job.queuedAt);

    const started = Date.now();
    const child = execFile(
      this.shell.file,
      this.shell.commandArgs(job.command),
      {
        cwd: job.cwd,
        timeout: job.timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_EXEC_BUFFER,
        detached: this.platform !== "win32",
      },
      (error, stdout, stderr) => {
        job.process = null;
        const clippedOutput = clipJobOutput(stdout, stderr);
        job.stdout = clippedOutput.stdout;
        job.stderr = clippedOutput.stderr;
        job.outputTruncated = clippedOutput.truncated;
        job.exitCode = typeof error?.code === "number" ? error.code : (error ? 1 : 0);
        job.error = error ? error.message : null;
        job.status = batch.cancelled ? "cancelled" : (error ? "failed" : "completed");
        job.endedAt = new Date().toISOString();
        job.durationMs = Date.now() - started;
        this.activeBatchJobs = Math.max(0, this.activeBatchJobs - 1);
        this.#finishBatchIfDone(batch);
        this.#drainBatchQueue();
      },
    );
    job.process = child;
  }

  #finishBatchIfDone(batch) {
    if (batch.jobs.every((job) => ["completed", "failed", "cancelled"].includes(job.status))) {
      batch.endedAt ||= new Date().toISOString();
    }
  }

  #jobSummary(job) {
    return {
      jobId: job.jobId,
      index: job.index,
      status: job.status,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      queueWaitMs: job.queueWaitMs,
      durationMs: job.durationMs,
      exitCode: job.exitCode,
      error: job.error,
    };
  }

  #batchSummary(batch) {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const job of batch.jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    return {
      ok: true,
      batchId: batch.batchId,
      createdAt: batch.createdAt,
      endedAt: batch.endedAt,
      requestedConcurrency: batch.requestedConcurrency,
      cancelled: batch.cancelled,
      counts,
      jobs: batch.jobs.map((job) => this.#jobSummary(job)),
    };
  }

  #append(session, stream, data) {
    const text = data.toString();
    for (let offset = 0; offset < text.length; offset += 4096) {
      const part = text.slice(offset, offset + 4096);
      session.chunks.push({ seq: session.nextSeq++, stream, text: part });
      session.totalChars += part.length;
    }

    while (session.totalChars > MAX_SESSION_BUFFER && session.chunks.length > 1) {
      const removed = session.chunks.shift();
      session.totalChars -= removed.text.length;
    }
  }

  #summary(session) {
    return {
      sessionId: session.id,
      processEpoch: session.processEpoch,
      type: session.type,
      command: session.command,
      cwd: session.cwd,
      pid: session.pid,
      status: session.status,
      exitCode: session.exitCode,
      signal: session.signal,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      nextSeq: session.nextSeq - 1,
    };
  }

  #get(sessionId) {
    if (typeof sessionId !== "string") throw new Error("invalid_session_id");
    return this.sessions.get(sessionId) ?? null;
  }

  #getBatch(batchId) {
    if (typeof batchId !== "string") throw new Error("invalid_batch_id");
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error("batch_not_found");
    return batch;
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === "running" || !session.endedAt) continue;
      if (now - Date.parse(session.endedAt) > ENDED_TTL_MS) this.sessions.delete(id);
    }
    for (const [id, batch] of this.batches) {
      if (!batch.endedAt) continue;
      if (now - Date.parse(batch.endedAt) > ENDED_TTL_MS) this.batches.delete(id);
    }

    const retainedCompleted = [...this.batches.entries()]
      .filter(([, batch]) => Boolean(batch.endedAt))
      .sort((a, b) => Date.parse(b[1].endedAt) - Date.parse(a[1].endedAt));
    for (const [id] of retainedCompleted.slice(MAX_RETAINED_BATCHES)) {
      this.batches.delete(id);
    }
  }
}
