import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWorktreeManager } from "../agent/git-worktree-manager.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-relay-worktree-"));
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "relay-test@example.invalid");
  git(repo, "config", "user.name", "Relay Test");
  await fsp.writeFile(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  return {
    root,
    repo,
    manager: new GitWorktreeManager([root]),
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test("cleanup rejects protected worktree branches", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const worktree = path.join(f.root, "develop-wt");
  git(f.repo, "branch", "develop");
  git(f.repo, "worktree", "add", worktree, "develop");

  const result = await f.manager.cleanup(f.repo, worktree);

  assert.equal(result.ok, false);
  assert.equal(result.error, "protected_branch");
  assert.equal(result.branch, "develop");
  assert.equal(fs.existsSync(worktree), true);
});

test("cleanup rejects dirty worktrees", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const worktree = path.join(f.root, "dirty-wt");
  git(f.repo, "worktree", "add", "-b", "feature-dirty", worktree);
  await fsp.writeFile(path.join(worktree, "dirty.txt"), "dirty\n");

  const result = await f.manager.cleanup(f.repo, worktree);

  assert.equal(result.ok, false);
  assert.equal(result.error, "dirty_worktree");
  assert.equal(result.branch, "feature-dirty");
  assert.equal(result.changedEntries, 1);
  assert.equal(fs.existsSync(worktree), true);
});

test("cleanup rejects branches that are not merged into the repo HEAD", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const worktree = path.join(f.root, "unmerged-wt");
  git(f.repo, "worktree", "add", "-b", "feature-unmerged", worktree);
  await fsp.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");

  const result = await f.manager.cleanup(f.repo, worktree);

  assert.equal(result.ok, false);
  assert.equal(result.error, "branch_not_merged");
  assert.equal(result.branch, "feature-unmerged");
  assert.equal(fs.existsSync(worktree), true);
});

test("cleanup rejects worktree paths outside configured roots", async (t) => {
  const f = await fixture();
  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-relay-outside-"));
  t.after(async () => {
    await f.cleanup();
    await fsp.rm(outsideRoot, { recursive: true, force: true });
  });
  const worktree = path.join(outsideRoot, "outside-wt");
  git(f.repo, "worktree", "add", "-b", "feature-outside", worktree);
  const restricted = new GitWorktreeManager([f.repo]);

  const result = await restricted.cleanup(f.repo, worktree);

  assert.equal(result.ok, false);
  assert.equal(result.error, "path_not_allowed");
  assert.equal(fs.existsSync(worktree), true);
});

test("cleanup requires repoPath to resolve to the primary worktree", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const sourceWorktree = path.join(f.root, "source-wt");
  const targetWorktree = path.join(f.root, "target-wt");
  git(f.repo, "worktree", "add", "-b", "feature-source", sourceWorktree);
  git(f.repo, "worktree", "add", "-b", "feature-target", targetWorktree);

  const result = await f.manager.cleanup(sourceWorktree, targetWorktree);

  assert.equal(result.ok, false);
  assert.equal(result.error, "repo_path_not_primary_worktree");
  assert.equal(fs.existsSync(targetWorktree), true);
});

test("cleanup removes a clean merged worktree, prunes metadata, and deletes its branch", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const worktree = path.join(f.root, "merged-wt");
  git(f.repo, "worktree", "add", "-b", "feature-merged", worktree);
  await fsp.writeFile(path.join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "feature");
  git(f.repo, "merge", "--no-ff", "feature-merged", "-m", "merge feature");

  const result = await f.manager.cleanup(f.repo, worktree);

  assert.equal(result.ok, true);
  assert.equal(result.branch, "feature-merged");
  assert.equal(result.mergedInto, "main");
  assert.equal(result.worktreeRemoved, true);
  assert.equal(result.pruned, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(fs.existsSync(worktree), false);
  assert.doesNotMatch(git(f.repo, "worktree", "list", "--porcelain"), /feature-merged/);
  assert.equal(git(f.repo, "branch", "--list", "feature-merged"), "");
});
