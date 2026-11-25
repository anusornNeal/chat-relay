import { randomUUID } from "node:crypto";
import { createTerminalSessionId } from "./terminal-continuity.mjs";

const MODES = new Set(["full", "tail", "summary", "errors"]);
const ERROR_LINE = /(?:\b(?:error|warning|fatal|failed|failure|exception|traceback|caused by)\b|^\s*[ew]:)/i;
const EXEC_REPLAY_TTL = 10 * 60_000;
const MAX_EXEC_REPLAYS = 16;
const REPLAY_CHUNK_CHARS = 1024;
const REPLAY_RESPONSE_BYTES = 40 * 1024;

export function outputLimit(value) {
  if (value === undefined) return 2048;
  if (!Number.isInteger(value) || value < 256 || value > 8192) throw new Error("invalid_output_chars");
  return value;
}

export function validateOutputMode(mode = "full") {
  if (!MODES.has(mode)) throw new Error("invalid_output_mode");
  return mode;
}

function tail(text, limit) {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let start = text.length - limit;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  return text.slice(start);
}

function diagnostic(text) {
  return text.split(/\r?\n/).filter(line => ERROR_LINE.test(line)).join("\n");
}

function failed(result) {
  return result.ok === false || ["failed", "cancelled", "killed"].includes(result.status) || Boolean(result.signal) ||
    (typeof result.exitCode === "number" && result.exitCode !== 0);
}

// A compact view is a projection of captured output, never a new execution.
export function compactTerminalResult(result, mode, limit = 2048) {
  validateOutputMode(mode);
  if (mode === "full") return result;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  let out = stdout, err = stderr;
  if (mode === "summary" && !failed(result)) { out = ""; err = ""; }
  else if (mode === "errors") {
    out = diagnostic(stdout);
    if (!out && !err && failed(result)) out = stdout;
  }
  const errBudget = out ? Math.min(err.length, Math.ceil(limit / 2)) : limit;
  err = tail(err, errBudget);
  out = tail(out, Math.max(0, limit - err.length));
  return { ...result, stdout: out, stderr: err, outputMode: mode,
    capturedChars: stdout.length + stderr.length,
    omittedChars: Math.max(0, stdout.length + stderr.length - out.length - err.length) };
}

export function compactTerminalPage(page, mode, limit, afterSeq) {
  validateOutputMode(mode);
  if (mode === "full" || !Array.isArray(page.chunks)) return page;
  const raw = page.chunks;
  const capturedChars = raw.reduce((sum, c) => sum + c.text.length, 0);
  let remaining = limit;
  const chunks = [];
  for (let i = raw.length - 1; i >= 0 && remaining > 0; i--) {
    const c = raw[i];
    let text = c.text;
    if (mode === "summary" && !failed(page)) text = "";
    else if (mode === "errors" && c.stream !== "stderr") text = diagnostic(text);
    if (!text) continue;
    text = tail(text, remaining);
    if (text) { chunks.push({ ...c, text }); remaining -= text.length; }
  }
  if (!chunks.length && failed(page) && capturedChars && mode === "errors") {
    for (let i = raw.length - 1; i >= 0 && remaining > 0; i--) {
      const text = tail(raw[i].text, remaining);
      if (text) { chunks.push({ ...raw[i], text }); remaining -= text.length; }
    }
  }
  chunks.reverse();
  return { ...page, chunks, outputMode: mode, capturedChars, omittedChars: capturedChars - (limit - remaining),
    // Re-read the original page with full mode and this cursor, not nextSeq.
    rawAfterSeq: afterSeq };
}

// Bounded process-local replay for compact short commands. No disk or extra RPC.
export class CompactExecOutputStore {
  constructor(processEpoch, now = Date.now) {
    this.processEpoch = processEpoch;
    this.now = now;
    this.entries = new Map();
  }
  #prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
  record(result, startedAt, endedAt) {
    this.#prune();
    while (this.entries.size >= MAX_EXEC_REPLAYS) this.entries.delete(this.entries.keys().next().value);
    const sessionId = createTerminalSessionId(this.processEpoch, randomUUID());
    const chunks = [];
    for (const stream of ["stdout", "stderr"]) {
      const text = typeof result[stream] === "string" ? result[stream] : "";
      for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + REPLAY_CHUNK_CHARS);
        if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
        chunks.push({ seq: chunks.length + 1, stream, text: text.slice(start, end) });
        start = end;
      }
    }
    this.entries.set(sessionId, { expiresAt: this.now() + EXEC_REPLAY_TTL, chunks,
      summary: { sessionId, processEpoch: this.processEpoch, type: "exec-output", status: "exited",
        exitCode: result.exitCode ?? null, startedAt, endedAt, error: result.error ?? null,
        captureLimited: /maxBuffer|timed out/i.test(String(result.error || "")) } });
    return sessionId;
  }
  read(sessionId, afterSeq = 0, maxChars = 24576) {
    this.#prune();
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    const limit = Math.min(Math.max(Number(maxChars) || 24576, 1024), 24576);
    const chunks = [];
    let chars = 0, bytes = 0;
    for (const chunk of entry.chunks) {
      if (chunk.seq <= afterSeq) continue;
      const chunkBytes = Buffer.byteLength(JSON.stringify(chunk), "utf8");
      if (chunks.length && (chars + chunk.text.length > limit || bytes + chunkBytes > REPLAY_RESPONSE_BYTES)) break;
      chunks.push(chunk);
      chars += chunk.text.length; bytes += chunkBytes;
    }
    const nextSeq = chunks.at(-1)?.seq ?? afterSeq;
    return { ...entry.summary, chunks, oldestSeq: 1, nextSeq,
      truncated: false, hasMore: nextSeq < entry.chunks.length };
  }
}
