import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileManager } from "../agent/file-manager.mjs";

const workspace = fileURLToPath(new URL("../.workspace/", import.meta.url));
const fixtures = [];

async function fixture() {
  await fs.mkdir(workspace, { recursive: true });
  const dir = await fs.mkdtemp(path.join(workspace, "search-test-"));
  fixtures.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(fixtures.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("start_search returns first page and keeps get_more_search_results compatible", async () => {
  const root = await fixture();
  for (let i = 0; i < 28; i++) {
    await fs.writeFile(path.join(root, `needle-${String(i).padStart(2, "0")}.txt`), "sample");
  }
  const files = new FileManager(root);
  const first = await files.startSearch(root, "needle", "files");
  assert.equal(first.status, "COMPLETED");
  assert.equal(first.totalResults, 28);
  assert.equal(first.results.length, 20);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.incomplete, false);
  assert.equal(first.stopReason, null);
  const next = files.getSearchResults(first.sessionId, first.nextOffset, 50);
  assert.equal(next.results.length, 8);
  assert.equal(next.nextOffset, null);
  assert.deepEqual([...first.results, ...next.results].map((r) => r.name),
    Array.from({ length: 28 }, (_, i) => `needle-${String(i).padStart(2, "0")}.txt`));

  const limited = await files.startSearch(root, "needle", "files", 3);
  assert.equal(limited.totalResults, 3);
  assert.equal(limited.incomplete, true);
  assert.equal(limited.stopReason, "result_limit");
  assert.equal(limited.nextOffset, null);
});

test("scan cap is reported as incomplete, not a fully completed scan", async () => {
  const root = await fixture();
  for (let offset = 0; offset < 5001; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 5001 - offset) }, (_, i) =>
      fs.writeFile(path.join(root, `noise-${String(offset + i).padStart(5, "0")}.txt`), "")));
  }
  const manager = new FileManager(root);
  const result = await manager.startSearch(root, "missing", "files");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.totalResults, 0);
  assert.equal(result.scanned, 5000);
  assert.equal(result.incomplete, true);
  assert.equal(result.stopReason, "scan_limit");
  assert.equal(manager.getSearchResults(result.sessionId).incomplete, true);
});

test("content search avoids generated directories and binary files, but explicit generated root is searchable", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "build"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.mkdir(path.join(root, "coverage"));
  await fs.writeFile(path.join(root, "code.kt"), "header\nneedle: main\n");
  await fs.writeFile(path.join(root, "build", "generated.kt"), "needle: build");
  await fs.writeFile(path.join(root, "dist", "bundle.js"), "needle: dist");
  await fs.writeFile(path.join(root, "coverage", "coverage.txt"), "needle: coverage");
  await fs.writeFile(path.join(root, "image.png"), "needle: fake png");
  await fs.writeFile(path.join(root, "unknown.binfile"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  const manager = new FileManager(root);
  const content = await manager.startSearch(root, "needle", "content");
  assert.equal(content.totalResults, 1);
  assert.equal(content.results[0].path, path.join(root, "code.kt"));
  assert.equal(content.results[0].line, 2);
  assert.equal(content.scanned, 3);
  assert.equal(content.incomplete, false);
  const binaryName = await manager.startSearch(root, "image.png", "files");
  assert.equal(binaryName.results.length, 1);
  const explicit = await manager.startSearch(path.join(root, "build"), "needle", "content");
  assert.equal(explicit.totalResults, 1);
  assert.ok(explicit.results[0].path.endsWith("generated.kt"));
});

test("search sessions are bounded, oldest is evicted, and expired sessions are removed lazily", async () => {
  const root = await fixture();
  const manager = new FileManager(root);
  const ids = [];
  for (let i = 0; i < 65; i++) {
    ids.push((await manager.startSearch(root, "not-present", "files")).sessionId);
  }
  assert.equal(manager.searches.size, 64);
  assert.throws(() => manager.getSearchResults(ids[0]), /search_not_found/);
  const retained = manager.getSearchResults(ids[1]);
  assert.equal(retained.status, "COMPLETED");
  assert.equal(retained.results.length, 0);
  const active = manager.searches.get(ids[1]);
  active.expiresAt = Date.now() - 1;
  assert.throws(() => manager.getSearchResults(ids[1]), /search_not_found/);
  assert.equal(manager.searches.has(ids[1]), false);
});
