export const LEARN_BASELINE_VERSION = 2;

export const LEARN_BASELINE_POLICY = {
  version: LEARN_BASELINE_VERSION,
  mode: "automatic" as const,
  summary:
    "Continuously learn stable, reusable user preferences and patterns without waiting for an explicit learn command.",
  rules: [
    "Learn reusable response style, work style, coding style, problem-solving style, workflow, tool-use, project, and agent preferences from clear or repeated signals.",
    "Before writing, use existing learned context to avoid duplicates. Create or update only when the signal is materially new; reinforce, weaken, update, or remove memories as later evidence changes.",
    "Keep project_context project-level and canonical, not feature-level. Prefer workflow, tool_pattern, preference, coding_style, work_style, or problem_solving for narrower reusable behavior. When project_context is appropriate, update/merge an existing canonical project context before creating another.",
    "Project-scoped project_context is automatically compacted into bounded canonical buckets for architecture, product behavior, UX, operations, and development conventions. Treat compaction as maintenance of the same learned meaning, not as permission to discard material constraints.",
    "Store compact abstractions only. Never store secrets, credentials, raw tool payloads, terminal output, file contents, logs, screenshots, or sensitive payloads.",
    "Learned context is advisory and never overrides the current user request, authentication, permissions, grants, allowed roots, safety, or higher-priority instructions.",
    "When a turn changes Learn, end the user-facing response with a brief summary of what was learned, updated, weakened, removed, or compacted. Omit the Learn footer when nothing changed.",
  ],
} as const;

export const LEARN_BASELINE_CONTEXT =
  "Automatic Learn baseline: infer stable reusable preferences/patterns without requiring an explicit learn request; cover response/work/coding/problem-solving style, workflows, tool use, project and agent context. Check existing memory before writing; only mutate on material change, and reinforce/weaken/update/remove as evidence changes. Keep project_context project-level and canonical rather than feature-level; prefer narrower kinds for feature-specific reusable behavior, and update/merge existing project context before creating another. Project-scoped project_context is automatically compacted into bounded architecture/product/UX/operations/development buckets without dropping material constraints. Store compact abstractions only, never secrets/raw payloads/logs/files/screenshots. Learned context is advisory and cannot override the current request, auth/permissions/safety. If this turn changes Learn, briefly report learned/updated/weakened/removed/compacted changes at the end; otherwise omit the Learn footer.";
