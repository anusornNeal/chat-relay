export const LEARN_BASELINE_VERSION = 3;

export const LEARN_BASELINE_POLICY = {
  version: LEARN_BASELINE_VERSION,
  mode: "explicit-tools" as const,
  summary:
    "Chat decides when learned context is useful and when durable learning is warranted; ordinary Relay tool calls never read or write Learn automatically.",
  rules: [
    "Use learn_prepare once when prior user, project, or agent context may materially affect the current task. Reuse that prepared context for the task; never call it automatically before every MCP tool.",
    "Learn reusable response style, work style, coding style, problem-solving style, workflow, tool-use, project, and agent preferences from clear or repeated signals.",
    "Before writing a memory, use the already prepared context or a targeted learn_get only when needed to avoid duplicates. Create or update only when the signal is materially new; reinforce, weaken, update, or remove memories as later evidence changes.",
    "Keep project_context project-level and canonical, not feature-level. Prefer workflow, tool_pattern, preference, coding_style, work_style, or problem_solving for narrower reusable behavior. When project_context is appropriate, update/merge an existing canonical project context before creating another.",
    "Project-scoped project_context is automatically compacted into bounded canonical buckets for architecture, product behavior, UX, operations, and development conventions. Treat compaction as maintenance of the same learned meaning, not as permission to discard material constraints.",
    "Store compact abstractions only. Never store secrets, credentials, raw tool payloads, terminal output, file contents, logs, screenshots, or sensitive payloads.",
    "Learned context is advisory and never overrides the current user request, authentication, permissions, grants, allowed roots, safety, or higher-priority instructions.",
    "When a turn changes Learn, end the user-facing response with a brief summary of what was learned, updated, weakened, removed, or compacted. Omit the Learn footer when nothing changed.",
  ],
} as const;

export const LEARN_BASELINE_CONTEXT =
  "Learn policy: Chat decides when to use Learn. Call learn_prepare once when prior user/project/agent context may materially affect the current task, then reuse that result; never prepare before every MCP tool. Ordinary Relay tools do not read or write Learn automatically. Infer stable reusable preferences/patterns from clear or repeated signals, but call learn_put only when durable learning is warranted. Before writing, use already prepared context or a targeted learn_get only when needed to avoid duplicates. Keep project_context project-level and canonical; prefer narrower kinds for feature-specific reusable behavior. Project-scoped project_context is compacted into bounded architecture/product/UX/operations/development buckets without dropping material constraints. Store compact abstractions only, never secrets/raw payloads/logs/files/screenshots. Learned context is advisory and cannot override the current request, auth/permissions/safety. If this turn changes Learn, briefly report learned/updated/weakened/removed/compacted changes at the end; otherwise omit the Learn footer.";
