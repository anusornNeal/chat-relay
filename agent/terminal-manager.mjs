import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

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
    this.sessions = new Map();
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
  }

  async exec(command, cwd, timeoutMs) {
    validateCommand(command);
    const resolvedCwd = safeCwd(cwd);
    const timeout = normalizeTimeout(timeoutMs);

    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
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
          });
        },
      );
    });
  }

  start(command, cwd) {
    validateCommand(command);
    return this.#spawnSession({
      type: "command",
      command,
      cwd: safeCwd(cwd),
      args: ["-NoLogo", "-NoProfile", "-Command", command],
    });
  }

  startShell(cwd) {
    return this.#spawnSession({
      type: "shell",
      command: "powershell",
      cwd: safeCwd(cwd),
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
    });
  }

  list() {
    this.#cleanup();
    return [...this.sessions.values()].map((session) => this.#summary(session));
  }

  read(sessionId, afterSeq = 0, maxChars = MAX_READ_CHARS) {
    this.#cleanup();
    const session = this.#get(sessionId);
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
    if (session.status !== "running") throw new Error("session_not_running");
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_CHARS) {
      throw new Error("invalid_input");
    }
    session.process.stdin.write(input + (appendNewline ? os.EOL : ""));
    return this.#summary(session);
  }

  async kill(sessionId) {
    const session = this.#get(sessionId);
    if (session.status !== "running") return this.#summary(session);

    await new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(session.pid), "/T", "/F"], () => resolve());
    });
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
    await Promise.all(running.map((job) => new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(job.process.pid), "/T", "/F"], () => resolve());
    })));

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

  #spawnSession({ type, command, cwd, args }) {
    this.#cleanup();
    const running = [...this.sessions.values()].filter((session) => session.status === "running").length;
    if (running >= MAX_SESSIONS) throw new Error("too_many_sessions");

    const child = spawn("powershell.exe", args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session = {
      id: randomUUID(),
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
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", job.command],
      {
        cwd: job.cwd,
        timeout: job.timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_EXEC_BUFFER,
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
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("session_not_found");
    return session;
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
