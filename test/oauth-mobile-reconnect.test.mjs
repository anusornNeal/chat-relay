import assert from "node:assert/strict";
import fs from "node:fs";

const oauth = fs.readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
const google = fs.readFileSync(new URL("../src/google-auth.ts", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../src/worker-app.ts", import.meta.url), "utf8");
const admin = fs.readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");

assert.match(oauth, /recoveryQuery\.set\("recovery", "1"\)/);
assert.match(oauth, /Use owner recovery instead/);
assert.match(google, /function connectorRecoveryHref\(/);
assert.match(google, /Use owner recovery in this browser/);
assert.match(worker, /connector\.oauth\.authorize\.response/);
assert.match(worker, /connector\.oauth\.google_start\.response/);
assert.match(admin, /oauth\.google\.callback\.failure/);

const telemetryStart = worker.indexOf("function connectorAuthorizeTelemetry(");
const telemetryEnd = worker.indexOf("async function recordOAuthTokenFailure(", telemetryStart);
assert.ok(telemetryStart >= 0 && telemetryEnd > telemetryStart, "authorize telemetry helper missing");
const telemetry = worker.slice(telemetryStart, telemetryEnd);
for (const forbidden of ["access_token", "refresh_token", "code_verifier", "code_challenge", "password"]) {
  assert.equal(telemetry.includes(forbidden), false, "authorize telemetry must not include " + forbidden);
}

console.log("OAuth mobile reconnect regression guard passed");
