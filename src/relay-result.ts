export type RelayResultTiming = {
  relayRoundTripMs: number;
  transportMs: number;
  agentQueueWaitMs: number;
  agentHandlerMs: number;
};

export type RelayResultMetadata = Partial<RelayResultTiming> & {
  present: boolean;
  payloadOk?: boolean;
  exitCode?: number | null;
  errorCode?: string;
};

const HEADER = {
  marker: "x-chat-relay-meta",
  payloadOk: "x-chat-relay-payload-ok",
  exitCode: "x-chat-relay-exit-code",
  errorCode: "x-chat-relay-error-code",
  relayRoundTripMs: "x-chat-relay-round-trip-ms",
  transportMs: "x-chat-relay-transport-ms",
  agentQueueWaitMs: "x-chat-relay-agent-queue-ms",
  agentHandlerMs: "x-chat-relay-agent-handler-ms",
} as const;

function boundedMs(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(Math.max(0, Math.round(numeric)), 120_000);
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(code)) return undefined;
  return code.toLowerCase();
}

export function relayResultHeaders(payload: unknown, timing: RelayResultTiming): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    [HEADER.marker]: "1",
    [HEADER.relayRoundTripMs]: String(timing.relayRoundTripMs),
    [HEADER.transportMs]: String(timing.transportMs),
    [HEADER.agentQueueWaitMs]: String(timing.agentQueueWaitMs),
    [HEADER.agentHandlerMs]: String(timing.agentHandlerMs),
  });

  const result = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!result) return headers;

  if (typeof result.ok === "boolean") {
    headers.set(HEADER.payloadOk, result.ok ? "1" : "0");
  }

  if (result.exitCode === null) {
    headers.set(HEADER.exitCode, "null");
  } else if (Number.isFinite(Number(result.exitCode))) {
    headers.set(HEADER.exitCode, String(Math.trunc(Number(result.exitCode))));
  }

  const errorCode = safeErrorCode(result.errorCode) || safeErrorCode(result.error);
  if (errorCode) headers.set(HEADER.errorCode, errorCode);
  return headers;
}

export function readRelayResultMetadata(headers: Headers): RelayResultMetadata {
  if (headers.get(HEADER.marker) !== "1") return { present: false };

  const payloadOkHeader = headers.get(HEADER.payloadOk);
  const exitCodeHeader = headers.get(HEADER.exitCode);
  const errorCode = safeErrorCode(headers.get(HEADER.errorCode));
  const relayRoundTripMs = boundedMs(headers.get(HEADER.relayRoundTripMs));
  const transportMs = boundedMs(headers.get(HEADER.transportMs));
  const agentQueueWaitMs = boundedMs(headers.get(HEADER.agentQueueWaitMs));
  const agentHandlerMs = boundedMs(headers.get(HEADER.agentHandlerMs));

  return {
    present: true,
    ...(payloadOkHeader === "1"
      ? { payloadOk: true }
      : payloadOkHeader === "0"
        ? { payloadOk: false }
        : {}),
    ...(exitCodeHeader === "null"
      ? { exitCode: null }
      : exitCodeHeader !== null && Number.isFinite(Number(exitCodeHeader))
        ? { exitCode: Math.trunc(Number(exitCodeHeader)) }
        : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(relayRoundTripMs === undefined ? {} : { relayRoundTripMs }),
    ...(transportMs === undefined ? {} : { transportMs }),
    ...(agentQueueWaitMs === undefined ? {} : { agentQueueWaitMs }),
    ...(agentHandlerMs === undefined ? {} : { agentHandlerMs }),
  };
}
