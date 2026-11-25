import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { FileManager } from "../agent/file-manager.mjs";
import { deduplicateSearchPreviews } from "../agent/fs-batch-preview.mjs";
import { TerminalManager } from "../agent/terminal-manager.mjs";
import { compactTerminalResult, compactTerminalPage, CompactExecOutputStore } from "../agent/terminal-output.mjs";
import { LocalUsageHistory, RECENT_CALL_CAPACITY } from "../agent/local-usage.mjs";
import { CapabilityScheduler } from "../agent/capability-scheduler.mjs";
import { AgentLifecycle } from "../agent/lifecycle.mjs";
import { describeToolActivity } from "../agent/toolcall-context.mjs";
import { preflightScope } from "../src/learn-preflight-gate.mjs";

async function fixture(t) {
  const workspace = path.join(process.cwd(), ".workspace");
  await fs.mkdir(workspace, { recursive: true });
  const dir = await fs.mkdtemp(path.join(workspace, "efficiency-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "root"), base = path.join(root, "project"), sibling = path.join(root, "sibling"), outside = path.join(dir, "outside");
  for (const folder of [base, sibling, outside]) await fs.mkdir(folder, { recursive: true });
  return { dir, root, base, sibling, outside, manager: new FileManager(root) };
}

test("relative batches resolve only inside a canonical allowed base", async t => {
  const { manager, base, sibling, outside } = await fixture(t);
  await fs.writeFile(path.join(base, "a.txt"), "a\nb\n", "utf8");
  await fs.writeFile(path.join(sibling, "other.txt"), "sibling", "utf8");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
  await fs.symlink(sibling, path.join(base, "link"), process.platform === "win32" ? "junction" : "dir");
  const paths = ["a.txt", "../sibling/other.txt", path.join(base, "a.txt"), "link/other.txt", "missing.txt"];
  const result = await manager.readMany(paths, undefined, base);
  assert.deepEqual(result.files.map(row => row.ok), [true, false, false, false, false]);
  assert.equal(result.files[0].content, "a\nb\n");
  assert.equal(result.files[1].error, "path_outside_base");
  assert.equal(result.files[2].error, "relative_path_required");
  const batch = await manager.batch([{ op: "read", path: "a.txt" }, { op: "list", path: "." },
    { op: "stat", path: "link/other.txt" }, { op: "search", path: ".", pattern: "a.txt" }],
    undefined, { basePath: base });
  assert.deepEqual(batch.results.map(row => row.ok), [true, true, false, true]);
  assert.equal(batch.results[0].result.content, "a\nb\n");
  assert.equal(batch.results[3].result.totalResults, 1);
  await assert.rejects(manager.readMany(["outside.txt"], undefined, outside), /path_not_allowed/);
  await assert.rejects(manager.readMany(["a"], undefined, path.join(base, "a.txt")), /base_not_directory/);
  assert.equal((await manager.readMany([path.join(base, "a.txt")])).files[0].ok, true);
});

test("batch edits are UTF-8, exact, per-file atomic and no-clobber", async t => {
  const { manager, base } = await fixture(t);
  const a = path.join(base, "a.txt"), b = path.join(base, "b.txt");
  const original = "\ufefffirst\r\nsecond\r\n";
  await fs.writeFile(a, original);
  await fs.writeFile(b, "unchanged\n");
  const text = "\u0e41\u0e1c\u0e19\u0e07\u0e32\u0e19 7 \u0e27\u0e31\u0e19";
  const results = await manager.editMany([
    { op: "edit", path: "a.txt", edits: [{ oldText: "first\nsecond", newText: text + "\nsecond" }, { oldText: "second", newText: "done" }] },
    { op: "edit", path: "b.txt", edits: [{ oldText: "unchanged", newText: "changed" }, { oldText: "missing", newText: "no" }] },
    { op: "create", path: "new.txt", content: text },
    { op: "create", path: "existing.txt", content: "new" },
  ], base);
  assert.equal(results.ok, false);
  assert.equal(results.succeeded, 3);
  assert.deepEqual(results.results.map(row => row.ok), [true, false, true, true]);
  assert.equal(await fs.readFile(a, "utf8"), "\ufeff" + text + "\r\ndone\r\n");
  assert.equal(await fs.readFile(b, "utf8"), "unchanged\n");
  assert.equal(await fs.readFile(path.join(base, "new.txt"), "utf8"), text);
  const createAgain = await manager.editMany([{ op: "create", path: "existing.txt", content: "overwrite" }], base);
  assert.equal(createAgain.results[0].ok, false);
  assert.equal(await fs.readFile(path.join(base, "existing.txt"), "utf8"), "new");
  const duplicates = await manager.editMany([
    { op: "edit", path: "b.txt", edits: [{ oldText: "unchanged", newText: "x" }] },
    { op: "edit", path: "./b.txt", edits: [{ oldText: "unchanged", newText: "y" }] },
  ], base);
  assert.deepEqual(duplicates.results.map(row => row.error), ["duplicate_batch_target", "duplicate_batch_target"]);
  assert.equal(await fs.readFile(b, "utf8"), "unchanged\n");
  await fs.writeFile(path.join(base, "invalid.bin"), Buffer.from([0xff, 0x00]));
  const invalid = await manager.editMany([{ op: "edit", path: "invalid.bin", edits: [{ oldText: "x", newText: "y" }] }], base);
  assert.equal(invalid.results[0].error, "invalid_utf8");
  await assert.rejects(manager.editMany([{ op: "create", path: "huge.txt", content: "x".repeat(50000) }], base), /edit_batch_too_large/);
  await assert.rejects(fs.stat(path.join(base, "huge.txt")), { code: "ENOENT" });
  assert.equal((await fs.readdir(base)).filter(name => name.startsWith(".chat-relay-")).length, 0);
});

test("batch writes cannot escape base, collide, or execute through read-only batch", async t => {
  const { manager, base, sibling, outside } = await fixture(t);
  const target = path.join(sibling, "secret.txt");
  await fs.writeFile(target, "secret");
  await fs.symlink(sibling, path.join(base, "junction"), process.platform === "win32" ? "junction" : "dir");
  const result = await manager.editMany([
    { op: "edit", path: "../sibling/secret.txt", edits: [{ oldText: "secret", newText: "changed" }] },
    { op: "create", path: "junction/new.txt", content: "blocked" },
    { op: "edit", path: "junction/secret.txt", edits: [{ oldText: "secret", newText: "changed" }] },
    { op: "create", path: path.join(base, "absolute.txt"), content: "blocked" },
  ], base);
  assert.equal(result.succeeded, 0);
  assert.equal(await fs.readFile(target, "utf8"), "secret");
  await assert.rejects(fs.stat(path.join(sibling, "new.txt")), { code: "ENOENT" });
  const denied = await manager.editMany([{ op: "create", path: path.join(outside, "new.txt"), content: "blocked" }]);
  assert.equal(denied.results[0].ok, false);
  const batch = await manager.batch([{ op: "create", path: path.join(base, "unauthorized.txt"), content: "blocked" }]);
  assert.equal(batch.results[0].ok, false);
  await assert.rejects(fs.stat(path.join(base, "unauthorized.txt")), { code: "ENOENT" });
  const concurrent = path.join(base, "counter.txt");
  await fs.writeFile(concurrent, "old");
  const edit = value => manager.editMany([{ op: "edit", path: "counter.txt", edits: [{ oldText: "old", newText: value }] }], base);
  const [first, second] = await Promise.all([edit("first"), edit("second")]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(await fs.readFile(concurrent, "utf8"), "first");
});

function expandPreview(match, packed) {
  if (!match.preview?.ref) return match.preview;
  const { ref, ...metadata } = match.preview;
  const shared = packed.sharedPreviews.find(item => item.id === ref);
  assert.ok(shared);
  assert.equal(shared.path, match.path);
  const start = metadata.offset - shared.offset;
  return { ...metadata, content: shared.content.split("\n").slice(start, start + metadata.length).join("\n") };
}
test("search preview packing merges matching overlaps without losing matches or continuation", async t => {
  const { manager, base } = await fixture(t);
  const lines = Array.from({ length: 35 }, (_, i) => "line " + i + " " + "abcdefghij".repeat(10));
  lines[10] += " UNIQUE_ALPHA";
  lines[13] += " UNIQUE_BETA";
  lines[15] += " UNIQUE_GAMMA";
  await fs.writeFile(path.join(base, "source.kt"), lines.join("\n"));
  const operations = ["UNIQUE_ALPHA", "UNIQUE_BETA", "UNIQUE_GAMMA"].map(pattern =>
    ({ op: "search", path: ".", searchType: "content", pattern, previewLines: 18 }));
  const raw = await manager.batch(operations, 49152, { basePath: base });
  const packed = await manager.batch(operations, 49152, { basePath: base, deduplicatePreviews: true });
  assert.ok(packed.sharedPreviews?.length);
  assert.equal(packed.results.length, raw.results.length);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(raw)));
  for (let i = 0; i < packed.results.length; i++) {
    const actual = packed.results[i].result, original = raw.results[i].result;
    assert.equal(actual.totalResults, original.totalResults);
    assert.equal(actual.nextOffset, original.nextOffset);
    assert.equal(actual.results[0].line, original.results[0].line);
    assert.deepEqual(expandPreview(actual.results[0], packed), original.results[0].preview);
    const replay = await manager.getSearchResultsWithPreview(actual.sessionId, 0, 1, 18);
    assert.deepEqual(replay.results[0].preview, original.results[0].preview);
  }
  const bounded = await manager.batch(operations, 4096, { basePath: base, deduplicatePreviews: true });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  // Different snapshots of an overlapping range must not be silently joined.
  const bad = [{ op: "search", ok: true, result: { results: [{ path: "a", preview: { offset: 0, length: 2, totalLines: 3, content: "a\nb" } }] } },
    { op: "search", ok: true, result: { results: [{ path: "a", preview: { offset: 1, length: 2, totalLines: 3, content: "X\nc" } }] } }];
  assert.deepEqual(deduplicateSearchPreviews(bad), { results: bad });
});

test("compact terminal projections retain failure, exit status and replay cursors", () => {
  const result = { ok: true, exitCode: 0, stdout: "hello\n" + "x".repeat(2000), stderr: "warning\n" };
  const compact = compactTerminalResult(result, "summary", 256);
  assert.equal(compact.stdout, "");
  assert.equal(compact.exitCode, 0);
  assert.equal(compact.omittedChars, result.stdout.length + result.stderr.length);
  assert.equal(compactTerminalResult(result, "full"), result);
  const failed = compactTerminalResult({ ok: false, exitCode: 9, stdout: "start\nError: broken\n", stderr: "" }, "errors", 256);
  assert.equal(failed.exitCode, 9);
  assert.match(failed.stdout, /Error: broken/);
  const page = { status: "exited", exitCode: 0, nextSeq: 5, oldestSeq: 1, truncated: false, chunks: [
    { seq: 4, stream: "stdout", text: "first" }, { seq: 5, stream: "stdout", text: "last" }] };
  const projected = compactTerminalPage(page, "summary", 256, 3);
  assert.equal(projected.rawAfterSeq, 3);
  assert.equal(projected.nextSeq, 5);
  assert.deepEqual(projected.chunks, []);
  assert.equal(projected.omittedChars, 9);
});

test("compact exec raw output store bounds pages, retention and unicode", () => {
  let now = 0;
  const store = new CompactExecOutputStore("epoch", () => now);
  const stdout = ("\u0e07" + String.fromCodePoint(0x1f642)).repeat(14000);
  const id = store.record({ stdout, stderr: "error", exitCode: 0 }, "start", "end");
  let recovered = "", stderr = "", cursor = 0;
  for (;;) {
    const page = store.read(id, cursor, 1024);
    assert.ok(page);
    assert.ok(page.chunks.reduce((n, c) => n + c.text.length, 0) <= 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 60 * 1024);
    for (const chunk of page.chunks) {
      assert.ok(chunk.text.isWellFormed());
      if (chunk.stream === "stdout") recovered += chunk.text; else stderr += chunk.text;
    }
    cursor = page.nextSeq;
    if (!page.hasMore) break;
  }
  assert.equal(recovered, stdout);
  assert.equal(stderr, "error");
  now += 600001;
  assert.equal(store.read(id), null);
  const first = store.record({ stdout: "first" }, "start", "end");
  for (let i = 0; i < 16; i++) store.record({ stdout: "later" }, "start", "end");
  assert.equal(store.read(first), null);
});

test("actual terminal exec, session and batch support compact and full replay", async t => {
  const manager = new TerminalManager({ fastExec: false });
  t.after(() => manager.close());
  const windows = process.platform === "win32";
  const okCommand = windows ? "Write-Output RELAY_COMPACT_OK" : "printf 'RELAY_COMPACT_OK\\n'";
  const failedCommand = windows ? "Write-Output 'ERROR RELAY_COMPACT_FAIL'; exit 7" : "printf 'ERROR RELAY_COMPACT_FAIL\\n'; exit 7";
  const full = await manager.exec(okCommand, process.cwd(), 5000);
  const compact = await manager.execCompact(okCommand, process.cwd(), 5000, "summary");
  assert.equal(compact.ok, true);
  assert.equal(compact.stdout, "");
  assert.ok(compact.rawOutputId);
  const replay = manager.read(compact.rawOutputId, 0);
  assert.equal(replay.chunks.filter(chunk => chunk.stream === "stdout").map(chunk => chunk.text).join(""), full.stdout);
  const failure = await manager.execCompact(failedCommand, process.cwd(), 5000, "errors");
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.ok, false);
  assert.match(failure.stdout, /RELAY_COMPACT_FAIL/);
  const session = manager.start(okCommand, process.cwd());
  let page;
  for (let i = 0; i < 40; i++) {
    page = await manager.readCompact(session.sessionId, 0, 8192, 0, "summary");
    if (page.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(page.status, "exited");
  assert.equal(page.exitCode, 0);
  assert.deepEqual(page.chunks, []);
  assert.match(manager.read(session.sessionId, page.rawAfterSeq).chunks.map(c => c.text).join(""), /RELAY_COMPACT_OK/);
  const batch = manager.batchStart([okCommand, failedCommand], { cwd: process.cwd(), timeoutMs: 5000 });
  let status;
  for (let i = 0; i < 80; i++) {
    status = manager.batchStatus(batch.batchId);
    if (status.endedAt) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(status.endedAt);
  const summary = manager.batchReadCompact(batch.batchId, undefined, "summary");
  assert.equal(summary.jobs[0].stdout, "");
  assert.equal(summary.jobs[1].exitCode, 7);
  assert.match(summary.jobs[1].stdout, /RELAY_COMPACT_FAIL/);
  const job = manager.batchReadCompact(batch.batchId, undefined, "full", undefined, 0);
  assert.equal(job.jobs.length, 1);
  assert.match(job.jobs[0].stdout, /RELAY_COMPACT_OK/);
});

test("1000 retained calls, stable cursors, numeric-only persisted 30-day aggregates", async t => {
  const { dir } = await fixture(t);
  const file = path.join(dir, "usage.json");
  let now = Date.parse("2026-11-01T00:00:00Z");
  const history = new LocalUsageHistory({ file, now: () => now, autoFlush: false });
  const record = (action, payload, result, ok = true) => history.record({
    at: new Date(now).toISOString(), action, summary: "SECRET_CONTENT_NOT_PERSISTED", error: "SECRET_ERROR",
    ok, durationMs: 4, requestBytes: 100, responseBytes: 200
  }, payload, result);
  for (let i = 0; i < 1005; i++) record("terminal.read", {}, {});
  assert.equal(history.retained, RECENT_CALL_CAPACITY);
  const first = history.page(100);
  assert.equal(first.calls[0].seq, 906);
  record("fs.readMany.relative", { paths: ["a", "b", "c", "d"] }, { files: [{ ok: true }, { ok: true }, { ok: false }] });
  const next = history.page(100, first.nextCursor);
  assert.equal(next.calls.at(-1).seq, first.calls[0].seq - 1);
  assert.equal(next.calls[0].seq, 806);
  record("fs.batch.compact", { operations: [{ op: "read" }, { op: "read" }, { op: "stat" }] },
    { results: [{ op: "read", ok: true }, { op: "read", ok: true }, { op: "stat", ok: true }] });
  record("fs.read", {}, {});
  record("fs.editMany", { operations: [{}, {}] }, { results: [{ ok: true }, { ok: false }] }, false);
  record("arbitrary-SECRET_ACTION", {}, {});
  const stats = history.stats();
  assert.equal(stats.totals.readBatches, 2);
  assert.equal(stats.batchReadItems, 4);
  assert.equal(stats.totals.estimatedSavedReadCalls, 2);
  assert.equal(stats.averageSuccessfulReadsPerBatch, 2);
  assert.equal(stats.observedBatchReadCallShare, 2 / 3);
  assert.equal(stats.totals.failed, 1);
  assert.equal(stats.byTool.find(row => row.action === "fs.readMany").batchRequested, 4);
  assert.equal(stats.byTool.find(row => row.action === "fs.readMany").batchProcessed, 3);
  history.close();
  const saved = await fs.readFile(file, "utf8");
  assert.ok(!saved.includes("SECRET"));
  assert.ok(!saved.includes("summary"));
  const restored = new LocalUsageHistory({ file, now: () => now, autoFlush: false });
  assert.equal(restored.retained, 0);
  assert.deepEqual(restored.stats().totals, stats.totals);
  assert.throws(() => restored.page(10, first.nextCursor), /recent_history_epoch_mismatch/);
  now += 30 * 86400000;
  assert.equal(restored.stats().totals.calls, 0);
  restored.close();
  assert.equal(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).days).length, 0);
  const unavailable = new LocalUsageHistory({ file: path.join(file, "unavailable.json"), autoFlush: false });
  unavailable.record({ action: "fs.read", summary: "x", ok: true }, {}, {});
  unavailable.close();
  assert.equal(unavailable.stats().persistence, "write-failed");
  assert.equal(unavailable.stats().totals.calls, 1);
});

test("new actions retain lifecycle and scheduler semantics and correct project context", async () => {
  const scheduler = new CapabilityScheduler();
  assert.equal(await scheduler.run("terminal.exec.compact", async meta => meta.lane), "terminalExec");
  assert.equal(await scheduler.run("fs.editMany", async meta => meta.lane), "filesystem");
  const lifecycle = new AgentLifecycle({ workSummary: () => ({ activeWork: 0 }) });
  lifecycle.drain();
  assert.ok(lifecycle.guard("fs.editMany"));
  assert.ok(lifecycle.guard("terminal.exec.compact"));
  assert.equal(lifecycle.guard("fs.batch.compact"), null);
  assert.equal(lifecycle.guard("agent.usageStats"), null);
  const basePath = "C:\\Users\\tester\\Projects\\buddy-android\\.workspace\\worktrees\\feature";
  const payload = { action: "fs.editMany", basePath, operations: [{ op: "edit", path: "app/a.kt" }, { op: "create", path: "app/b.kt" }] };
  assert.equal(describeToolActivity(payload, ["C:\\Users\\tester\\Projects"]).project, "buddy-android");
  assert.equal(describeToolActivity(payload, ["C:\\Users\\tester\\Projects"]).operation, "Edit 2 files");
  assert.equal(preflightScope({ basePath }), "project:buddy-android");
});
