import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { configDir } from "../cli/config.mjs";

export const RECENT_CALL_CAPACITY = 1000;
const RETENTION_DAYS = 30;
const DAY_MS = 86400000;
const MAX_PAGE_BYTES = 48 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const FLUSH_MS = 30_000;
const ACTIONS = new Set([
  "ping", "agent.config", "agent.recentCalls", "agent.usageStats",
  "agent.lifecycle.status", "agent.lifecycle.drain", "agent.lifecycle.resume",
  "agent.lifecycle.restart", "agent.lifecycle.upgrade",
  "fs.stat", "fs.list", "fs.read", "fs.readMany", "fs.batch", "fs.editMany",
  "fs.artifact", "fs.write", "fs.edit", "fs.mkdir", "fs.move", "fs.delete",
  "fs.search.start", "fs.search.results", "git.worktree.cleanup",
  "process.list", "process.kill", "desktop.screenshot", "desktop.clipboard.read",
  "desktop.clipboard.write", "desktop.window.list", "desktop.window.focus",
  "desktop.mouse.click_image", "desktop.mouse.click", "desktop.keyboard.input", "desktop.step",
  "terminal.exec", "terminal.batch.start", "terminal.batch.status", "terminal.batch.read",
  "terminal.batch.cancel", "terminal.start", "terminal.shell.start", "terminal.read",
  "terminal.write", "terminal.kill", "terminal.list", "terminal.observability", "other",
]);
const ALIASES = new Map([
  ["fs.readMany.relative", "fs.readMany"], ["fs.batch.compact", "fs.batch"],
  ["terminal.exec.compact", "terminal.exec"], ["terminal.read.compact", "terminal.read"],
  ["terminal.batch.read.compact", "terminal.batch.read"], ["agent.recentCalls.page", "agent.recentCalls"],
]);
const COUNTERS = [
  "calls", "failed", "durationMs", "requestBytes", "responseBytes", "batchRequested", "batchProcessed",
  "batchSucceeded", "readBatches", "requestedReadItems", "readItems", "estimatedSavedReadCalls",
];
const empty = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const actionKey = action => ALIASES.get(action) || (ACTIONS.has(action) ? action : "other");
function add(target, source) {
  for (const key of COUNTERS) target[key] = Math.min(Number.MAX_SAFE_INTEGER, target[key] + boundedCount(source[key]));
  return target;
}
function items(value) { return Array.isArray(value) ? value : []; }

function measure(action, entry, payload, result) {
  payload = payload && typeof payload === "object" ? payload : {};
  const row = empty();
  row.calls = 1;
  row.failed = entry.ok === false ? 1 : 0;
  row.durationMs = boundedCount(entry.durationMs);
  row.requestBytes = boundedCount(entry.requestBytes);
  row.responseBytes = boundedCount(entry.responseBytes);
  let requests = [], outcomes = [], readRequested = 0, readSucceeded = 0;
  if (action === "fs.readMany") {
    requests = items(payload.paths);
    outcomes = items(result?.files);
    readRequested = requests.length;
    readSucceeded = outcomes.filter(item => item.ok === true).length;
  } else if (action === "fs.batch" || action === "fs.editMany") {
    requests = items(payload.operations);
    outcomes = items(result?.results);
    if (action === "fs.batch") {
      readRequested = requests.filter(item => item?.op === "read").length;
      readSucceeded = outcomes.filter(item => item.ok === true && item.op === "read").length;
    }
  } else if (action === "fs.read" && entry.ok !== false) {
    row.readItems = 1;
  }
  if (["fs.readMany", "fs.batch", "fs.editMany"].includes(action)) {
    row.batchRequested = Math.min(20, requests.length);
    row.batchProcessed = Math.min(row.batchRequested, outcomes.length);
    row.batchSucceeded = Math.min(row.batchProcessed, outcomes.filter(item => item.ok === true).length);
    row.requestedReadItems = Math.min(20, readRequested);
    row.readBatches = row.requestedReadItems > 0 ? 1 : 0;
    row.readItems = Math.min(row.requestedReadItems, readSucceeded);
    // Estimate against one filesystem read call per successful read operation.
    // Partial file reads can still need continuation; this is not an E2E measurement.
    row.estimatedSavedReadCalls = Math.max(0, row.readItems - 1);
  }
  return row;
}

export function usageFileForAgent(agentId, directory = configDir()) {
  const key = createHash("sha256").update(String(agentId)).digest("hex").slice(0, 32);
  return path.join(directory, "usage", key + ".json");
}

// Recent metadata stays in RAM; only bounded numerical daily aggregates go to disk.
// The timer is dirty-only, unref'ed, and never runs on every tool call.
export class LocalUsageHistory {
  constructor({ file = null, now = Date.now, autoFlush = true } = {}) {
    this.file = file;
    this.now = now;
    this.autoFlush = autoFlush;
    this.epoch = randomUUID();
    this.ring = new Array(RECENT_CALL_CAPACITY);
    this.nextSeq = 1;
    this.retained = 0;
    this.days = new Map();
    this.lastDay = null;
    this.dirty = false;
    this.timer = null;
    this.persistence = file ? "local" : "memory-only";
    this.loadWarning = null;
    if (file) this.#load();
  }

  #prune(now = this.now()) {
    const earliest = dayKey(now - (RETENTION_DAYS - 1) * DAY_MS);
    const latest = dayKey(now);
    for (const key of this.days.keys()) if (key < earliest || key > latest) {
      this.days.delete(key); this.dirty = true;
    }
    this.lastDay = latest;
  }

  #load() {
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error("usage_file_too_large");
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.days || typeof parsed.days !== "object" || Array.isArray(parsed.days)) {
        throw new Error("invalid_usage_file");
      }
      for (const [day, tools] of Object.entries(parsed.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !tools || typeof tools !== "object") continue;
        const rows = new Map();
        for (const [action, values] of Object.entries(tools)) {
          if (!ACTIONS.has(action) || !values || typeof values !== "object") continue;
          rows.set(action, add(empty(), values));
        }
        this.days.set(day, rows);
      }
      this.#prune();
    } catch (error) {
      if (error?.code !== "ENOENT") this.loadWarning = "usage_history_unavailable";
    }
  }

  record(entry, payload = {}, result = null) {
    const seq = this.nextSeq++;
    this.ring[(seq - 1) % RECENT_CALL_CAPACITY] = {
      ...entry, seq, action: String(entry.action || "other").slice(0, 100),
      summary: String(entry.summary || "").slice(0, 160),
      ...(entry.error === undefined ? {} : { error: String(entry.error).slice(0, 256) }),
    };
    this.retained = Math.min(RECENT_CALL_CAPACITY, this.retained + 1);
    const now = this.now(), day = dayKey(now), action = actionKey(entry.action);
    if (day !== this.lastDay) this.#prune(now);
    let rows = this.days.get(day);
    if (!rows) { rows = new Map(); this.days.set(day, rows); }
    let row = rows.get(action);
    if (!row) { row = empty(); rows.set(action, row); }
    add(row, measure(action, entry, payload, result));
    this.dirty = true;
    this.#schedule();
  }

  #schedule() {
    if (!this.file || !this.autoFlush || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  page(limit = 50, cursor) {
    const count = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 50)));
    let before = this.nextSeq;
    if (cursor !== undefined) {
      const [epoch, raw, extra] = String(cursor).split(":");
      before = Number(raw);
      if (epoch !== this.epoch) throw new Error("recent_history_epoch_mismatch");
      if (extra !== undefined || !Number.isSafeInteger(before) || before < 1 || before > this.nextSeq) {
        throw new Error("invalid_history_cursor");
      }
    }
    const oldest = this.nextSeq - this.retained;
    const calls = [];
    let bytes = 256;
    for (let seq = before - 1; seq >= oldest && calls.length < count; seq--) {
      const entry = this.ring[(seq - 1) % RECENT_CALL_CAPACITY];
      const cost = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
      if (bytes + cost > MAX_PAGE_BYTES) break;
      calls.push(entry); bytes += cost;
    }
    calls.reverse();
    const first = calls[0]?.seq ?? before;
    return { calls, retained: this.retained, capacity: RECENT_CALL_CAPACITY, historyEpoch: this.epoch,
      oldestSeq: oldest, newestSeq: this.nextSeq - 1,
      nextCursor: first > oldest ? this.epoch + ":" + first : null,
      evicted: before <= oldest && oldest > 1 };
  }

  recent(limit) {
    return this.page(limit).calls.map(({ seq, ...entry }) => entry);
  }

  stats(requestedDays = RETENTION_DAYS) {
    const now = this.now();
    this.#prune(now);
    const days = Math.min(RETENTION_DAYS, Math.max(1, Math.trunc(Number(requestedDays) || RETENTION_DAYS)));
    const from = dayKey(now - (days - 1) * DAY_MS), through = dayKey(now);
    const tools = new Map(), totals = empty(), daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayKey(now - i * DAY_MS);
      const sum = empty();
      for (const [action, row] of this.days.get(date) || []) {
        let target = tools.get(action);
        if (!target) { target = empty(); tools.set(action, target); }
        add(target, row); add(sum, row); add(totals, row);
      }
      daily.push({ date, calls: sum.calls, failed: sum.failed, readBatches: sum.readBatches,
        readItems: sum.readItems, estimatedSavedReadCalls: sum.estimatedSavedReadCalls });
    }
    const byTool = [...tools].map(([action, row]) => ({ action, ...row }))
      .sort((a, b) => b.calls - a.calls || a.action.localeCompare(b.action));
    const batchReads = byTool.filter(row => row.action === "fs.readMany" || row.action === "fs.batch");
    const batchReadItems = batchReads.reduce((sum, row) => sum + row.readItems, 0);
    return { retentionDays: RETENTION_DAYS, days, from, through, timezone: "UTC",
      persistence: this.persistence, ...(this.loadWarning ? { warning: this.loadWarning } : {}),
      recentRetained: this.retained, totals, byTool, daily, batchReadItems,
      observedBatchReadCallShare: totals.readBatches + (tools.get("fs.read")?.calls || 0) > 0
        ? totals.readBatches / (totals.readBatches + (tools.get("fs.read")?.calls || 0)) : null,
      averageSuccessfulReadsPerBatch: totals.readBatches ? batchReadItems / totals.readBatches : null };
  }

  flush() {
    if (!this.file || !this.dirty) return;
    this.#prune();
    const snapshot = { version: 1, days: Object.fromEntries([...this.days]
      .map(([day, tools]) => [day, Object.fromEntries(tools)])) };
    const text = JSON.stringify(snapshot);
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("usage_file_too_large");
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      this.dirty = false;
      this.persistence = "local";
    } catch {
      this.persistence = "write-failed";
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}
