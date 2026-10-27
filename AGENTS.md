# Chat Relay repository agent guidance

- Chat Relay is a general-purpose transport, not the default owner of files modified through its tools. Resolve the **selected task project's** verified repository root before filesystem or Git operations.
- Follow `docs/PROJECT_WORKSPACE_POLICY.md` when a backup, WIP archive or Git worktree is genuinely necessary. Create **new** artifacts exclusively under `<owning-project>/.workspace/backups/<task-or-purpose>/` or `<owning-project>/.workspace/worktrees/<task-or-purpose>/`, not in sibling directories and not automatically under `chat-relay/` for other projects.
- Ignore `.workspace/` in the owning repository and preserve any active, dirty, foreign or unmerged work. Never create repeated safety snapshots as a routine step. Existing legacy folders must not be moved or deleted without a separate verified cleanup.
- Respect authorized roots, project-specific rules and user instructions. Never push, publish or deploy without permission.
