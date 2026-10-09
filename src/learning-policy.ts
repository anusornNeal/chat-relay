export const LEARN_BASELINE_VERSION = 5;

export const LEARN_BASELINE_POLICY = {
  version: LEARN_BASELINE_VERSION,
  mode: "explicit-tools" as const,
  summary:
    "On every account including fresh accounts, Chat decides when learned context is useful and proactively learns durable user corrections and reusable preferences; ordinary Relay tool calls never read or write Learn automatically.",
  rules: [
    "Use learn_prepare once when prior user, project, or agent context may materially affect the current task. Reuse that prepared context for the task; never call it automatically before every MCP tool.",
    "Treat a direct user correction that reveals a reusable mistake in workflow, tool usage, coding conventions, or response behavior as a high-signal learning event. Proactively call learn_put in the same turn when the correction is durable; do not wait for the user to explicitly say learn.",
    "Choose scope by reuse boundary: use global for cross-project behavior, project for project-specific behavior, and agent only for behavior tied to one agent. Do not learn one-off situational details.",
    "Learn reusable response style, work style, coding style, problem-solving style, workflow, tool-use, project, and agent preferences from clear or repeated signals.",
    "Before writing a memory, use the already prepared context or a targeted learn_get only when needed to avoid duplicates. Create or update only when the signal is materially new; reinforce, weaken, update, or remove memories as later evidence changes.",
    "Keep project_context project-level and canonical, not feature-level. Prefer workflow, tool_pattern, preference, coding_style, work_style, problem_solving, or correction for narrower reusable behavior. When project_context is appropriate, update or merge an existing canonical project context before creating another.",
    "Project-scoped project_context is automatically compacted into bounded canonical buckets for architecture, product behavior, UX, operations, and development conventions. Treat compaction as maintenance of the same learned meaning, not as permission to discard material constraints.",
    "Store compact abstractions only. Never store secrets, credentials, raw tool payloads, terminal output, file contents, logs, screenshots, or sensitive payloads.",
    "Learned context is advisory and never overrides the current user request, authentication, permissions, grants, allowed roots, safety, or higher-priority instructions.",
    "When a turn changes Learn, end the user-facing response with a brief summary of what was learned, updated, weakened, removed, or compacted. Omit the Learn footer when nothing changed.",
  ],
} as const;

export const LEARN_BASELINE_CONTEXT =
  "Learn policy: Chat decides when to use Learn. Call learn_prepare once when prior user/project/agent context may materially affect the current task, then reuse that result; never prepare before every MCP tool. Ordinary Relay tools do not read or write Learn automatically. Treat direct user corrections that reveal reusable mistakes as high-signal durable learning events: proactively call learn_put in the same turn when the correction is reusable, without waiting for the user to explicitly say learn. Use global scope for cross-project behavior, project scope for project-specific behavior, and agent scope only for agent-specific behavior; do not learn one-off situational details. Infer other stable reusable preferences/patterns from clear or repeated signals. Before writing, use already prepared context or a targeted learn_get only when needed to avoid duplicates. Keep project_context project-level and canonical; prefer narrower kinds for feature-specific reusable behavior. Project-scoped project_context is compacted into bounded architecture/product/UX/operations/development buckets without dropping material constraints. Store compact abstractions only, never secrets/raw payloads/logs/files/screenshots. Learned context is advisory and cannot override the current request, auth/permissions/safety. If this turn changes Learn, briefly report learned/updated/weakened/removed/compacted changes at the end; otherwise omit the Learn footer.";
