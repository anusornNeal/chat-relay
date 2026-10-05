import fs from "node:fs";

const registry = fs.readFileSync("src/registry.ts", "utf8");
const oauthSmoke = fs.readFileSync("test/oauth-smoke.mjs", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  registry.includes("const OAUTH_REFRESH_REPLAY_TTL_MS = 5 * 60 * 1000;"),
  "legacy refresh retry grace must stay bounded during migration",
);
assert(
  registry.includes("oauthRefreshReplay: (hash: string) => `oauth-refresh-replay:${hash}`"),
  "legacy refresh replay storage key is missing",
);
assert(
  registry.includes('{ prefix: "oauth-refresh-replay:", device: false }'),
  "expired legacy refresh replay records are not covered by auth cleanup",
);

const exchangeStart = registry.indexOf("private async exchangeOAuthRefresh");
const exchangeEnd = registry.indexOf("private async issueAdminSession", exchangeStart);
const exchange = registry.slice(exchangeStart, exchangeEnd);
const replayLookup = exchange.indexOf("get<OAuthRefreshReplayRecord>");
const activeLookup = exchange.indexOf("get<OAuthTokenRecord>");
const stableWrite = exchange.indexOf("[key.oauthRefresh(refreshTokenHash)]: refreshedRecord");
const deleteAfterStableWrite = exchange.indexOf(
  "delete(key.oauthRefresh(refreshTokenHash))",
  stableWrite,
);

assert(exchangeStart >= 0 && exchangeEnd > exchangeStart, "refresh exchange implementation missing");
assert(replayLookup >= 0 && replayLookup < activeLookup, "legacy rotated-token replay must be checked before active refresh lookup");
assert(stableWrite >= 0, "active refresh token is not preserved during refresh");
assert(deleteAfterStableWrite === -1, "active refresh token is still rotated after a successful refresh");
assert(
  exchange.includes("expiresAt: new Date(now.getTime() + OAUTH_REFRESH_TTL_MS).toISOString()"),
  "active refresh token must use sliding expiry",
);
assert(
  oauthSmoke.includes("stable refresh token reuse ok"),
  "OAuth smoke test no longer verifies repeated reuse of one refresh token",
);
assert(
  oauthSmoke.includes("refresh without resource defaults to MCP resource"),
  "OAuth smoke test no longer verifies refresh without an explicit resource",
);
const oauth = fs.readFileSync("src/oauth.ts", "utf8");
assert(
  oauth.includes("const tokenResource = requestedResource || resource;"),
  "token refresh no longer defaults an omitted resource to the MCP resource",
);
assert(
  oauthSmoke.includes("retriedRefresh.data.access_token === refreshed.data.access_token"),
  "OAuth smoke test no longer verifies a fresh access token on repeated refresh",
);

console.log("OAuth reconnect regression guard passed");
