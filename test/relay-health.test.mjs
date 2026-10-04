import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRelayHealth,
  relayHealthRetryDelay,
  startRelayHealthMonitor,
} from "../cli/relay-health.mjs";

test("checks the authenticated relay status endpoint for the configured agent", async () => {
  let requestedUrl;
  let requestOptions;
  const result = await checkRelayHealth("https://relay.example.dev", {
    userToken: "user-token",
    agentId: "device 1",
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestOptions = options;
      return new Response(JSON.stringify({ online: true }), { status: 200 });
    },
  });

  assert.equal(result.state, "reachable");
  assert.equal(requestedUrl, "https://relay.example.dev/status?agentId=device+1");
  assert.equal(requestOptions.method, "GET");
  assert.equal(requestOptions.headers.accept, "application/json");
  assert.equal(requestOptions.headers.authorization, "Bearer user-token");
});

test("recognizes Cloudflare Worker request limit error 1027", async () => {
  const result = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response("<title>Error 1027: Worker exceeded daily request limit</title>", { status: 429 }),
  });

  assert.deepEqual(result, { state: "limited", code: 1027 });
});

test("reports other rate limits and Worker errors as unavailable", async () => {
  const rateLimited = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response("Too many requests", { status: 429 }),
  });
  assert.deepEqual(rateLimited, { state: "limited", code: 429 });

  const workerError = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response("Error 1102: Worker exceeded resource limits", { status: 500 }),
  });
  assert.deepEqual(workerError, { state: "cloudflare-error", code: 1102 });

  const appError = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response("temporarily unavailable", { status: 503 }),
  });
  assert.deepEqual(appError, { state: "unavailable", code: 503 });
});

test("identifies the sanitized Relay Durable Object outage response", async () => {
  const result = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response(JSON.stringify({ error: "relay_unavailable" }), { status: 503 }),
  });

  assert.deepEqual(result, { state: "unavailable", reason: "relay_unavailable" });
});

test("distinguishes agent reauthorization and disabled states from sign-in failures", async () => {
  const reauthorization = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response(JSON.stringify({
      online: false,
      authorized: false,
      enabled: false,
      reauthorizationRequired: true,
    }), { status: 200 }),
  });
  assert.deepEqual(reauthorization, { state: "reauthorize" });

  const disabled = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response(JSON.stringify({
      online: false,
      authorized: false,
      enabled: false,
      reauthorizationRequired: false,
    }), { status: 200 }),
  });
  assert.deepEqual(disabled, { state: "agent-disabled" });
});

test("rejects a healthy-looking response that is not the relay health response", async () => {
  const result = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response("<html>fallback page</html>", { status: 200 }),
  });

  assert.deepEqual(result, { state: "unavailable", code: 200 });
});

test("distinguishes an offline Agent from a reachable Relay", async () => {
  const result = await checkRelayHealth("https://relay.example.dev", {
    fetchImpl: async () => new Response(JSON.stringify({ online: false }), { status: 200 }),
  });

  assert.deepEqual(result, { state: "unavailable", reason: "agent_offline" });
});

test("checkNow reruns a pending health check without publishing its stale result", async () => {
  let resolveFirstRequest;
  let requestCount = 0;
  const statuses = [];
  const stop = startRelayHealthMonitor("https://relay.example.dev", {
    intervalMs: 60_000,
    onStatus: (health) => statuses.push(health.state),
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve) => { resolveFirstRequest = resolve; });
      }
      return new Response(JSON.stringify({ online: true }), { status: 200 });
    },
  });

  try {
    stop.checkNow();
    assert.equal(requestCount, 1);
    resolveFirstRequest(new Response(JSON.stringify({ online: false }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requestCount, 2);
    assert.deepEqual(statuses, ["reachable"]);
  } finally {
    stop();
  }
});

test("backs off health checks during Cloudflare request pressure", () => {
  assert.equal(relayHealthRetryDelay({ state: "reachable" }, 5_000), 5_000);
  assert.equal(
    relayHealthRetryDelay({ state: "limited", code: 1027 }, 5_000, { limitedIntervalMs: 60_000 }),
    60_000,
  );
  assert.equal(
    relayHealthRetryDelay({ state: "cloudflare-error", code: 1102 }, 5_000, { cloudflareErrorIntervalMs: 30_000 }),
    30_000,
  );
});

test("checkNow cannot bypass Cloudflare pressure cooldown", async () => {
  let requestCount = 0;
  const statuses = [];
  const stop = startRelayHealthMonitor("https://relay.example.dev", {
    intervalMs: 1_000,
    limitedIntervalMs: 60_000,
    onStatus: (health) => statuses.push(health),
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("Error 1027: Worker exceeded daily request limit", { status: 429 });
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requestCount, 1);
    assert.equal(statuses[0]?.state, "limited");
    assert.equal(stop.checkNow(), false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requestCount, 1);
  } finally {
    stop();
  }
});
