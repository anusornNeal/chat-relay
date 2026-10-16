import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { needsRelayLogin } from "../cli/device-login.mjs";
test("explicit relay target triggers reauthentication only on change",()=>{
 assert.equal(needsRelayLogin({relayUrl:"https://host.example"},"https://self.example"),true);
 assert.equal(needsRelayLogin({relayUrl:"https://self.example/"},"https://self.example"),false);
 assert.equal(needsRelayLogin({relayUrl:"https://host.example"},undefined),false);
});
test("default wrangler is not tied to production",()=>{
 const config=fs.readFileSync("wrangler.jsonc","utf8");
 assert.doesNotMatch(config,/anusorn-hank|googleusercontent/);
});
test("selfhost cannot fall back to production config",()=>{
 const result=spawnSync(process.execPath,["scripts/deploy-worker.mjs","selfhost"],{encoding:"utf8"});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Missing wrangler.selfhost.jsonc/);
});
test("production deploy requires explicit opt in",()=>{
 const result=spawnSync(process.execPath,["scripts/deploy-worker.mjs","production"],{encoding:"utf8",env:{...process.env,CHAT_RELAY_PRODUCTION_DEPLOY:""}});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/CHAT_RELAY_PRODUCTION_DEPLOY/);
});
