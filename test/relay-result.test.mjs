import assert from "node:assert/strict";
import test from "node:test";

import {
  readRelayResultMetadata,
  relayResultHeaders,
} from "../src/relay-result.ts";

test("Relay result headers preserve hot-path metadata without body parsing", () => {
  const headers = relayResultHeaders(
    { ok: false, exitCode: 7, errorCode: "COMMAND_FAILED" },
    {
      relayRoundTripMs: 11,
      transportMs: 3,
      agentQueueWaitMs: 2,
      agentHandlerMs: 6,
    },
  );

  assert.deepEqual(readRelayResultMetadata(headers), {
    present: true,
    payloadOk: false,
    exitCode: 7,
    errorCode: "command_failed",
    relayRoundTripMs: 11,
    transportMs: 3,
    agentQueueWaitMs: 2,
    agentHandlerMs: 6,
  });
});

test("Relay result headers do not leak payload content", () => {
  const headers = relayResultHeaders(
    { ok: true, stdout: "secret output", data: "opaque payload" },
    {
      relayRoundTripMs: 4,
      transportMs: 1,
      agentQueueWaitMs: 1,
      agentHandlerMs: 2,
    },
  );

  const serialized = JSON.stringify([...headers.entries()]);
  assert.equal(serialized.includes("secret output"), false);
  assert.equal(serialized.includes("opaque payload"), false);
  assert.equal(readRelayResultMetadata(headers).payloadOk, true);
});

test("Relay result metadata is absent for rolling-deploy legacy responses", () => {
  assert.deepEqual(readRelayResultMetadata(new Headers()), { present: false });
});
