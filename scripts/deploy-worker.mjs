import { spawnSync } from "node:child_process";
import fs from "node:fs";
const mode = process.argv[2];
if (!["selfhost", "production"].includes(mode)) throw Error("Usage: deploy-worker.mjs selfhost|production");
const cfg = mode === "production" ? "wrangler.production.jsonc" : "wrangler.selfhost.jsonc";
if (mode === "production" && process.env.CHAT_RELAY_PRODUCTION_DEPLOY !== "1") throw Error("Production deploy requires CHAT_RELAY_PRODUCTION_DEPLOY=1");
if (!fs.existsSync(cfg)) throw Error("Missing " + cfg + "; copy wrangler.selfhost.example.jsonc for self-hosting");
const content = fs.readFileSync(cfg,"utf8");
const vars = JSON.parse(content.replace(/^\s*\/\/.*$/gm,"").replace(/,\s*([}\]])/g,"$1")).vars || {};
if (mode === "selfhost") {
 if (!vars.PUBLIC_BASE_URL || !vars.GOOGLE_CLIENT_ID || /YOUR-WORKER|REPLACE_WITH/i.test(vars.PUBLIC_BASE_URL + vars.GOOGLE_CLIENT_ID)) throw Error("Self-host needs actual PUBLIC_BASE_URL and GOOGLE_CLIENT_ID");
 if (vars.PUBLIC_BASE_URL.includes("anusorn-hank.workers.dev")) throw Error("Refusing hosted production URL in self-host deployment");
 if (!/^https:\/\//.test(vars.PUBLIC_BASE_URL)) throw Error("Self-host base URL must use HTTPS");
}
const args = ["wrangler","deploy","--config",cfg,...process.argv.slice(3)];
const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",args,{stdio:"inherit",shell:process.platform==="win32"});
process.exit(result.status ?? 1);
