import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileManager } from "../agent/file-manager.mjs";

test("multi-search batch keeps order, isolates errors and retains search sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-batched-search-"));
  try {
    await fs.writeFile(path.join(root, "ViewModel.kt"), "class MainViewModel {}\n");
    await fs.writeFile(path.join(root, "Repository.kt"), "class MainRepository {}\n");
    const manager = new FileManager(root);
    const result = await manager.batch([
      { id: "vm", op: "search", path: root, pattern: "ViewModel", searchType: "files", previewLines: 2 },
      { id: "bad", op: "search", path: root, pattern: "", searchType: "files" },
      { id: "repo", op: "search", path: root, pattern: "MainRepository", searchType: "content", previewLines: 2 },
      { id: "stat", op: "stat", path: path.join(root, "ViewModel.kt") },
    ]);
    assert.equal(result.results.length, 4);
    assert.deepEqual(result.results.map((item) => item.id), ["vm", "bad", "repo", "stat"]);
    assert.deepEqual(result.results.map((item) => item.ok), [true, false, true, true]);
    assert.equal(result.results[1].error, "invalid_pattern");
    assert.match(result.results[0].result.results[0].preview.content, /MainViewModel/);
    assert.equal(result.results[2].result.results[0].line, 1);
    assert.match(result.results[2].result.results[0].preview.content, /MainRepository/);
    assert.equal(manager.getSearchResults(result.results[0].result.sessionId).totalResults, 1);
    assert.equal(manager.getSearchResults(result.results[0].result.sessionId).results[0].preview, undefined);
    const denied = await manager.batch([
      { op: "search", path: path.dirname(root), pattern: "anything" },
    ]);
    assert.equal(denied.results[0].ok, false);
    assert.match(denied.results[0].error, /path_not_allowed/);
    await assert.rejects(manager.batch(Array.from({ length: 9 }, () =>
      ({ op: "search", path: root, pattern: "ViewModel" }))), /too_many_batch_searches/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("content search centers context on matched line and continuation preserves exact ranges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-search-context-"));
  try {
    const lines = Array.from({ length: 30 }, (_, i) => "source-line-" + (i + 1));
    lines[12] = "source-line-13 MATCH_FUNCTION";
    await fs.writeFile(path.join(root, "ViewModel.kt"), lines.join("\n"));
    const manager = new FileManager(root);
    const base = await manager.startSearch(root, "MATCH_FUNCTION", "content", 3);
    assert.equal(typeof base.results[0].preview, "string");
    const result = await manager.startSearch(root, "MATCH_FUNCTION", "content", 3, 5);
    const ctx = result.results[0].preview;
    assert.equal(result.results[0].line, 13);
    assert.equal(ctx.offset, 10);
    assert.equal(ctx.length, 5);
    assert.match(ctx.content, /MATCH_FUNCTION/);
    assert.equal(ctx.nextOffset, 15);
    const rest = await manager.read(result.results[0].path, ctx.nextOffset, 2);
    assert.equal(rest.offset, 15);
    assert.match(rest.content, /source-line-16/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("next search page can include context without rescanning or changing legacy pagination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-search-more-"));
  try {
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(path.join(root, "Match-" + String(i).padStart(2, "0") + ".kt"), "first\nsecond\n");
    }
    const manager = new FileManager(root);
    const first = await manager.startSearch(root, "Match-", "files", 30);
    assert.equal(first.results.length, 20);
    const continuation = await manager.getSearchResultsWithPreview(first.sessionId, first.nextOffset, 5, 2);
    assert.equal(continuation.results.length, 5);
    assert.equal(continuation.nextOffset, null);
    assert(continuation.results.every((item) => item.preview.content === "first\nsecond"));
    const boundedPage = await manager.getSearchResultsWithPreview(first.sessionId, 0, 100, 2);
    assert.equal(boundedPage.results.length, 20);
    assert.equal(boundedPage.nextOffset, 20);
    const legacyPage = manager.getSearchResults(first.sessionId, 20, 5);
    assert(legacyPage.results.every((item) => item.preview === undefined));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("batch verify guidance routes independent checks to existing terminal batch", async () => {
  const worker = await fs.readFile(new URL("../src/worker-app.ts", import.meta.url), "utf8");
  const at = worker.indexOf('    "terminal_batch_start",', worker.indexOf("export function createMcpServer("));
  assert(at > 0);
  assert.match(worker.slice(at, at + 430), /Batch Verify/);
  assert.match(worker.slice(at, at + 430), /INDEPENDENT/);
  assert.match(worker.slice(at, at + 430), /terminal_batch_read/);
});
