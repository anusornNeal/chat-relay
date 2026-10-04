import assert from "node:assert/strict";
import test from "node:test";

import { handleStatusRequest } from "../src/status-route.mjs";

const statusRequest = (agentId = "desk-1") => new Request(
  `https://relay.example.dev/status${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
);

function dependencies(overrides = {}) {
  return {
    request: statusRequest(),
    expectedProtocolVersion: 4,
    authenticate: async () => ({ user: { id: "user-1", name: "User" } }),
    resolveAgent: async () => ({ ok: true, agentId: "desk-1" }),
    getAgentAccess: async () => ({
      response: Response.json({ ok: true }),
      data: {
        authorized: true,
        agent: { name: "Work PC", ownerUserId: "user-1", enabled: true },
        scopes: ["read"],
      },
    }),
    getRelayStatus: async () => Response.json({ online: true, protocolVersion: 4 }),
    ...overrides,
  };
}

async function responseData(response) {
  return { status: response.status, data: await response.json() };
}

test("preserves a successful offline Agent status response", async () => {
  const result = await responseData(await handleStatusRequest(dependencies({
    getRelayStatus: async () => Response.json({ online: false }),
  })));

  assert.equal(result.status, 200);
  assert.equal(result.data.online, false);
  assert.equal(result.data.agentName, "Work PC");
  assert.equal(result.data.expectedProtocolVersion, 4);
});

test("returns a sanitized unavailable response when Registry authentication is blocked", async () => {
  const result = await responseData(await handleStatusRequest(dependencies({
    authenticate: async () => ({
      user: null,
      response: new Response("Exceeded allowed volume of requests in Durable Objects free tier.", { status: 503 }),
    }),
  })));

  assert.deepEqual(result, { status: 503, data: { error: "relay_unavailable" } });
});

test("sanitizes Registry resolve and agent-access infrastructure failures", async () => {
  const resolveFailure = await responseData(await handleStatusRequest(dependencies({
    request: statusRequest(null),
    resolveAgent: async () => ({
      ok: false,
      response: new Response("provider details", { status: 503 }),
    }),
  })));
  assert.deepEqual(resolveFailure, { status: 503, data: { error: "relay_unavailable" } });

  const accessFailure = await responseData(await handleStatusRequest(dependencies({
    getAgentAccess: async () => ({
      response: new Response("provider details", { status: 503 }),
      data: { error: "provider details" },
    }),
  })));
  assert.deepEqual(accessFailure, { status: 503, data: { error: "relay_unavailable" } });
});

test("sanitizes Relay Durable Object failures and malformed status responses", async () => {
  const failures = [
    async () => { throw new Error("private provider details"); },
    async () => new Response("private provider details", { status: 503 }),
    async () => new Response("not json", { status: 200 }),
  ];

  for (const getRelayStatus of failures) {
    const result = await responseData(await handleStatusRequest(dependencies({ getRelayStatus })));
    assert.deepEqual(result, { status: 503, data: { error: "relay_unavailable" } });
  }
});

test("preserves authentication and authorization failures", async () => {
  const unauthorized = await responseData(await handleStatusRequest(dependencies({
    authenticate: async () => ({ user: null }),
  })));
  assert.deepEqual(unauthorized, { status: 401, data: { error: "unauthorized" } });

  const forbidden = await responseData(await handleStatusRequest(dependencies({
    getAgentAccess: async () => ({
      response: Response.json({ error: "agent_access_denied" }, { status: 403 }),
      data: { error: "agent_access_denied" },
    }),
  })));
  assert.deepEqual(forbidden, { status: 403, data: { error: "agent_access_denied" } });
});
