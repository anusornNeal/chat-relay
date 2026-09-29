import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

const MAX_EXEC_BUFFER = 48 * 1024;
const MAX_SESSION_BUFFER = 256 * 1024;
const MAX_READ_CHARS = 24 * 1024;
const MAX_INPUT_CHARS = 8 * 1024;
const MAX_SESSIONS = 8;
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

function safeCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return process.cwd();
  if (typeof cwd !== "string" || cwd.length > 1024) throw new Error("invalid_cwd");
  return cwd;
}

export class TerminalManager {
  constructor() {
    this.sessions = new Map();
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

  #cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === "running" || !session.endedAt) continue;
      if (now - Date.parse(session.endedAt) > ENDED_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }
}
