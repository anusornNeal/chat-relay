# Project-local backup and worktree policy

Applies to **new** temporary artifacts created by agents using Chat Relay, whether the task targets Chat Relay, Flowly, Buddy2 or another project. Relay is transport; the selected project owns its artifacts.

## Placement

1. Verify the selected project and its actual repository root. For Git repos, use `git worktree list --porcelain` to locate the **primary repository worktree**, even if the current command is running in a secondary worktree. Do not infer the root from the Relay agent's current working directory alone.
2. Create a backup, WIP snapshot or extra Git worktree **only when necessary** (for example, risky pending changes or truly independent parallel implementation). Do not create routine per-task/per-attempt copies or numbered backup retries. Prefer existing commits/branches or other safe nonduplicating approaches when sufficient.
3. Place **all new** backups and worktrees inside the owning project's root, never in a sibling directory or a different project's tree:

   ```text
   <project-root>/
     .workspace/
       backups/<task-id-or-purpose>-<timestamp>/
       worktrees/<task-id-or-purpose>/
   ```

   Examples: `chat-relay/.workspace/worktrees/REL-11`, `flowly/.workspace/backups/FLY-69-20261026`, `buddy-android/.workspace/worktrees/QCA-4131`. Use unique, descriptive names and reuse a safe existing workspace instead of making duplicates.
4. Ensure the owning project's `.gitignore` or local `.git/info/exclude` ignores `/.workspace/` before creation. Use `git worktree add <project-root>/.workspace/worktrees/<id> ...` for Git worktrees; do not clone repositories repeatedly. Verify the canonical destination stays under the owning project root (no `..`, junction or symlink escapes). Do not create nested workspaces inside a secondary worktree.
5. Back up only relevant non-secret files, and **exclude `.workspace/` itself** from any backup. Avoid recursively copying the entire repository into its own child, including dependency/build caches. Capture owner, reason, source/branch and cleanup conditions in task notes or a small backup manifest.

## Cleanup and legacy directories

- After verified integration, inspect Git registrations, dirty/untracked/ignored content, merge equivalence, ownership, active processes/leases and recovery needs. Remove only temporary artifacts proven safe to remove; never remove dirty/unmerged/foreign/active work or delete sole recoverable data.
- Previously created sibling worktrees and WIP backups are **legacy exceptions for reading and safe recovery only**. Do not automatically move/delete them or treat them as the naming pattern for new work.
- These are **agent workflow instructions**, not a restriction that Chat Relay can reliably impose on arbitrary terminal commands. A caller must still follow them; direct filesystem/Git safety rules remain in force.
