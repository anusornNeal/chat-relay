import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileManager } from "../agent/file-manager.mjs";

test("optional search preview replaces a follow-up read and preserves legacy search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-preview-"));
  try {
    await fs.writeFile(path.join(root, "Onboarding.kt"), "class Onboarding {}\nsecond line\n");
    const files = new FileManager(root);
    const legacy = await files.startSearch(root, "Onboarding", "files");
    const extended = await files.startSearch(root, "Onboarding", "files", 20, 2);
    assert.equal(legacy.results[0].preview, undefined);
    assert.match(extended.results[0].preview.content, /class Onboarding/);
    assert.deepEqual(legacy.results.map(x => x.name), extended.results.map(x => x.name));
    const content = await files.startSearch(root, "Onboarding", "content", 20, 2);
    assert.match(content.results[0].preview.content, /class Onboarding/);
    const empty = await files.startSearch(root, "absent", "files", 20, 2);
    assert.equal(empty.results.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
