import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

if (pkg.name !== "@anusornneal/chat-relay") {
  throw new Error(`Unexpected package name: ${pkg.name}`);
}
if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
  throw new Error(`Invalid package version: ${pkg.version}`);
}
if (pkg.bin?.["chat-relay"] !== "bin/chat-relay.js") {
  throw new Error("chat-relay bin entry is missing");
}

const requiredLocalFiles = [
  "bin/chat-relay.js",
  "cli/index.mjs",
  "cli/config.mjs",
  "cli/device-login.mjs",
  "cli/remote.mjs",
  "agent/local-agent.mjs",
  "agent/file-manager.mjs",
  "agent/process-manager.mjs",
  "agent/terminal-manager.mjs",
];

for (const file of requiredLocalFiles) {
  if (!fs.existsSync(file)) throw new Error(`Required publish file missing: ${file}`);
}

const packed = execSync(
  "npm pack --dry-run --json --ignore-scripts",
  { encoding: "utf8" },
);
const packInfo = JSON.parse(packed)[0];
const packedFiles = new Set(packInfo.files.map((entry) => entry.path));

for (const file of requiredLocalFiles) {
  if (!packedFiles.has(file)) {
    throw new Error(`Required file not included in npm package: ${file}`);
  }
}

const forbiddenPrefixes = [".dev.vars", "src/", "test/", ".github/", ".git/"];
for (const file of packedFiles) {
  if (forbiddenPrefixes.some((prefix) => file === prefix || file.startsWith(prefix))) {
    throw new Error(`Forbidden file included in npm package: ${file}`);
  }
}

execFileSync(
  process.execPath,
  ["bin/chat-relay.js", "help"],
  { stdio: "pipe" },
);

console.log(
  `publish package verified: ${pkg.name}@${pkg.version} (${packInfo.entryCount} files, ${packInfo.size} bytes)`,
);
