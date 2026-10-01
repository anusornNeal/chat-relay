import fs from "node:fs";

function fail(message) {
  console.error("review artifact verification failed:", message);
  process.exit(1);
}

const reviewPath = "docs/plugin-review.md";
if (!fs.existsSync(reviewPath)) fail(reviewPath + " is missing");
const review = fs.readFileSync(reviewPath, "utf8");

for (const required of [
  "https://developers.openai.com/plugins/deploy/app-review",
  "https://developers.openai.com/plugins/deploy/submission",
  "https://developers.openai.com/plugins/app-guidelines",
  "/.well-known/openai-apps-challenge",
  "External submission blockers",
  "Reviewer positive cases",
  "Reviewer negative cases",
  "Production clean-room demo",
  "Exactly five representative positive cases",
  "Exactly three representative negative cases",
]) {
  if (!review.includes(required)) fail("missing review section/reference: " + required);
}

const readme = fs.readFileSync("README.md", "utf8");
if (!readme.includes("ChatGPT MCP should connect to the plain `/mcp` endpoint")) {
  fail("README must lead with the plain OAuth /mcp endpoint");
}
if (!readme.includes("legacy `/mcp?key=<USER_TOKEN>` flow remains available only during migration")) {
  fail("README must label legacy query-key auth as transitional");
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const script of ["test:submission", "verify:review"]) {
  if (!pkg.scripts?.[script]) fail("missing package script " + script);
}

const source = ["src/index.ts", "src/worker-app.ts"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
if (!source.includes('path === "/.well-known/openai-apps-challenge"')) {
  fail("domain challenge endpoint is missing");
}
if (!source.includes("annotationsForTool")) {
  fail("tool annotation policy is missing");
}

console.log("plugin review artifacts verified");
