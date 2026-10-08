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

test("Relay result metadata ignores blank, malformed, and unsafe numeric headers", () => {
  const headers = new Headers({ "x-chat-relay-meta": "1" });
  assert.deepEqual(readRelayResultMetadata(headers), { present: true });
  headers.set("x-chat-relay-round-trip-ms", " ");
  headers.set("x-chat-relay-transport-ms", "NaN");
  headers.set("x-chat-relay-agent-handler-ms", "Infinity");
  headers.set("x-chat-relay-exit-code", "");
  assert.deepEqual(readRelayResultMetadata(headers), { present: true });

  headers.set("x-chat-relay-round-trip-ms", "0");
  headers.set("x-chat-relay-transport-ms", "-4");
  headers.set("x-chat-relay-agent-queue-ms", "200000");
  headers.set("x-chat-relay-exit-code", "-1");
  assert.deepEqual(readRelayResultMetadata(headers), {
    present: true,
    relayRoundTripMs: 0,
    transportMs: 0,
    agentQueueWaitMs: 120000,
    exitCode: -1,
  });

  headers.set("x-chat-relay-exit-code", "1.5");
  assert.equal(Object.hasOwn(readRelayResultMetadata(headers), "exitCode"), false);
  headers.set("x-chat-relay-exit-code", "null");
  assert.equal(readRelayResultMetadata(headers).exitCode, null);
});

test("Relay result headers reject invalid exit code types and unsafe errors", () => {
  const timing = { relayRoundTripMs: 0, transportMs: 0, agentQueueWaitMs: 0, agentHandlerMs: 0 };
  for (const exitCode of ["", "  ", false, true, [], {}, Infinity, "1.5", "9007199254740992"]) {
    const headers = relayResultHeaders({ exitCode }, timing);
    assert.equal(headers.has("x-chat-relay-exit-code"), false, String(exitCode));
  }
  assert.equal(readRelayResultMetadata(relayResultHeaders({ exitCode: null }, timing)).exitCode, null);
  assert.equal(readRelayResultMetadata(relayResultHeaders({ exitCode: 0 }, timing)).exitCode, 0);
  assert.equal(relayResultHeaders({ error: "private token header" }, timing).has("x-chat-relay-error-code"), false);
});
