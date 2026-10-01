import fs from "node:fs";

const registry = fs.readFileSync("src/registry.ts", "utf8");
const oauthSmoke = fs.readFileSync("test/oauth-smoke.mjs", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  registry.includes("const OAUTH_REFRESH_REPLAY_TTL_MS = 30 * 1000;"),
  "refresh retry grace must stay bounded to 30 seconds",
);
assert(
  registry.includes("oauthRefreshReplay: (hash: string) => `oauth-refresh-replay:${hash}`"),
  "refresh replay storage key is missing",
);
assert(
  registry.includes('{ prefix: "oauth-refresh-replay:", device: false }'),
  "expired refresh replay records are not covered by auth cleanup",
);

const exchangeStart = registry.indexOf("private async exchangeOAuthRefresh");
const exchangeEnd = registry.indexOf("private async issueAdminSession", exchangeStart);
const exchange = registry.slice(exchangeStart, exchangeEnd);
const replayLookup = exchange.indexOf("get<OAuthRefreshReplayRecord>");
const activeLookup = exchange.indexOf("get<OAuthTokenRecord>");
const replayWrite = exchange.indexOf("[replayKey]: replayRecord");
const oldDelete = exchange.lastIndexOf("delete(key.oauthRefresh(refreshTokenHash))");

assert(exchangeStart >= 0 && exchangeEnd > exchangeStart, "refresh exchange implementation missing");
assert(replayLookup >= 0 && replayLookup < activeLookup, "retry replay must be checked before active token rotation");
assert(replayWrite >= 0 && replayWrite < oldDelete, "replay result must be persisted before the old refresh token is deleted");
assert(
  oauthSmoke.includes("retriedRefresh.data.refresh_token !== refreshed.data.refresh_token"),
  "OAuth smoke test no longer verifies idempotent refresh retry",
);
assert(
  oauthSmoke.includes("rotatedAgain.data.refresh_token === refreshed.data.refresh_token"),
  "OAuth smoke test no longer verifies continued rotation",
);

console.log("OAuth reconnect regression guard passed");
