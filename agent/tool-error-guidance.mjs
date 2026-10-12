// Actionable advice for deterministic, non-retryable tool failures.
// This is presentation metadata only: security checks remain in their original handlers.
export function toolErrorGuidance(action, message, input = {}) {
  if (typeof message !== "string") return {};
  const code = message.split(":", 1)[0];
  if (code === "command_blocked") {
    const command = typeof input.command === "string" ? input.command : "";
    const processQuery = /\b(Get-CimInstance|Win32_Process|Get-Process|tasklist)\b/i.test(command);
    const fileQuery = /\b(Select-String|findstr|rg|grep)\b/i.test(command);
    return {
      errorCode: code,
      retryable: false,
      reason: "The terminal safety policy rejected this command before execution.",
      suggestedTool: processQuery ? "list_processes" : fileQuery ? "start_search" : "get_config",
      suggestedAction: processQuery
        ? "Use list_processes for process inspection instead of shell process enumeration."
        : fileQuery
          ? "Use start_search with an allowed path for file/content search."
          : "Inspect available capabilities; do not retry unchanged or bypass the terminal policy.",
    };
  }
  if (code === "path_not_allowed") {
    return {
      errorCode: code,
      retryable: false,
      reason: "The requested path is outside the agent's authorized filesystem roots.",
      suggestedTool: "get_config",
      suggestedAction: "Check allowedRoots and use paths within them. Access elsewhere requires an authorized root configuration change; do not bypass using terminal commands.",
    };
  }
  if (code === "replacement_count_mismatch") {
    return {
      errorCode: code,
      retryable: false,
      reason: "The exact edit text does not match the expected occurrence count in the current file.",
      suggestedTool: "read_file",
      suggestedAction: "Read the current file contents, then retry edit_block with fresh exact oldText; do not retry the same stale replacement.",
    };
  }
  return {};
}
