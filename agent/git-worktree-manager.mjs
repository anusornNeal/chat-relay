import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 256 * 1024;
const DEFAULT_PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function comparablePath(value, platform = process.platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseWorktrees(output) {
  const entries = [];
  let current = null;

  for (const line of String(output || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
    if (line === "detached") current.detached = true;
  }

  if (current) entries.push(current);
  return entries;
}

async function runGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      exitCode: 0,
    };
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? Number(error.code) : 1;
    if (Array.isArray(options.allowExitCodes) && options.allowExitCodes.includes(exitCode)) {
      return {
        ok: false,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || ""),
        exitCode,
      };
    }
    const detail = String(error?.stderr || error?.message || "git_command_failed").trim();
    const wrapped = new Error(options.errorCode || "git_command_failed");
    wrapped.cause = detail;
    throw wrapped;
  }
}

export class GitWorktreeManager {
  constructor(roots = [], options = {}) {
    this.roots = Array.isArray(roots) ? roots.map((root) => path.resolve(String(root))) : [];
    this.platform = String(options.platform || process.platform);
  }

  async #resolveAllowedExisting(input) {
    if (typeof input !== "string" || input.length === 0 || input.length > 2048) {
      throw new Error("invalid_path");
    }
    const target = await fs.realpath(path.resolve(input));
    for (const root of this.roots) {
      const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root));
      if (within(canonicalRoot, target)) return target;
    }
    throw new Error("path_not_allowed");
  }

  async cleanup(repoPathInput, worktreePathInput) {
    let repoPath;
    let worktreePath;
    try {
      repoPath = await this.#resolveAllowedExisting(repoPathInput);
      worktreePath = await this.#resolveAllowedExisting(worktreePathInput);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "path_validation_failed" };
    }

    if (comparablePath(repoPath, this.platform) === comparablePath(worktreePath, this.platform)) {
      return { ok: false, error: "repo_path_is_target_worktree" };
    }

    let repoRoot;
    try {
      const rootResult = await runGit(repoPath, ["rev-parse", "--show-toplevel"], { errorCode: "not_a_git_repository" });
      repoRoot = await this.#resolveAllowedExisting(rootResult.stdout.trim());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "not_a_git_repository" };
    }

    let worktrees;
    try {
      const listed = await runGit(repoPath, ["worktree", "list", "--porcelain"], { errorCode: "worktree_list_failed" });
      worktrees = parseWorktrees(listed.stdout);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "worktree_list_failed" };
    }

    const primary = worktrees[0];
    if (!primary) return { ok: false, error: "primary_worktree_not_found" };
    const repoKey = comparablePath(repoRoot, this.platform);
    if (comparablePath(primary.path, this.platform) !== repoKey) {
      return { ok: false, error: "repo_path_not_primary_worktree" };
    }

    const targetKey = comparablePath(worktreePath, this.platform);
    const target = worktrees.find((entry) => comparablePath(entry.path, this.platform) === targetKey);
    if (!target) return { ok: false, error: "worktree_not_registered" };

    if (repoKey === targetKey) {
      return { ok: false, error: "primary_worktree_protected" };
    }
    if (target.detached || !target.branch) return { ok: false, error: "detached_worktree_not_supported" };
    if (DEFAULT_PROTECTED_BRANCHES.has(target.branch.toLowerCase())) {
      return { ok: false, error: "protected_branch", branch: target.branch };
    }

    let dirty;
    try {
      const status = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], { errorCode: "worktree_status_failed" });
      dirty = status.stdout.trim();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "worktree_status_failed" };
    }
    if (dirty) {
      return {
        ok: false,
        error: "dirty_worktree",
        branch: target.branch,
        changedEntries: dirty.split(/\r?\n/).filter(Boolean).length,
      };
    }

    let repoHead = "HEAD";
    try {
      const head = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], { errorCode: "repo_head_failed" });
      repoHead = head.stdout.trim() || "HEAD";
      const merged = await runGit(
        repoPath,
        ["merge-base", "--is-ancestor", `refs/heads/${target.branch}`, "HEAD"],
        { allowExitCodes: [1], errorCode: "merge_check_failed" },
      );
      if (!merged.ok) {
        return { ok: false, error: "branch_not_merged", branch: target.branch, mergedInto: repoHead };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "merge_check_failed" };
    }

    try {
      await runGit(repoPath, ["worktree", "remove", worktreePath], { errorCode: "worktree_remove_failed" });
      await runGit(repoPath, ["worktree", "prune"], { errorCode: "worktree_prune_failed" });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "worktree_remove_failed",
        branch: target.branch,
      };
    }

    try {
      await runGit(repoPath, ["branch", "-d", "--", target.branch], { errorCode: "branch_delete_failed" });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "branch_delete_failed",
        branch: target.branch,
        worktreeRemoved: true,
        branchDeleted: false,
      };
    }

    return {
      ok: true,
      repoPath: repoRoot,
      worktreePath,
      branch: target.branch,
      mergedInto: repoHead,
      worktreeRemoved: true,
      pruned: true,
      branchDeleted: true,
    };
  }
}

export { parseWorktrees };
