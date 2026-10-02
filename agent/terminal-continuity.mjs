const SESSION_PREFIX = "terminal";

export function createTerminalSessionId(processEpoch, sessionUuid) {
  if (typeof processEpoch !== "string" || !processEpoch) throw new Error("invalid_process_epoch");
  if (typeof sessionUuid !== "string" || !sessionUuid) throw new Error("invalid_session_uuid");
  return `${SESSION_PREFIX}:${processEpoch}:${sessionUuid}`;
}

export function parseTerminalSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const match = /^terminal:([^:]+):([^:]+)$/.exec(sessionId);
  if (!match) return null;
  return { processEpoch: match[1], sessionUuid: match[2] };
}

export function terminalSessionMiss(sessionId, processEpoch) {
  const identity = parseTerminalSessionId(sessionId);
  if (identity && identity.processEpoch !== processEpoch) {
    return {
      ok: false,
      error: "terminal_session_epoch_mismatch",
      reason: "agent_process_restarted",
      sessionId,
      sessionProcessEpoch: identity.processEpoch,
      currentProcessEpoch: processEpoch,
      resumable: false,
      recovery: "start_new_session",
    };
  }
  return {
    ok: false,
    error: "session_not_found",
    sessionId,
    currentProcessEpoch: processEpoch,
    resumable: false,
  };
}

export function terminalContinuityConfig(processEpoch, activeSessions) {
  return {
    processEpoch,
    activeSessions,
    scope: "same_process",
    preservesSessionsAcrossSocketReconnect: true,
    preservesSessionsAcrossProcessRestart: false,
    resumableAfterProcessRestart: false,
    sessionIdFormat: "terminal:<processEpoch>:<sessionUuid>",
  };
}
