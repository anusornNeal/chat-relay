import fs from "node:fs";

const vars = fs.existsSync(".dev.vars")
  ? Object.fromEntries(
      fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
        .filter((line) => line && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    )
  : {};

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8809").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || vars.ADMIN_TOKEN || "test-admin";
const callerToken = process.env.TEST_CALLER_TOKEN || vars.CALLER_TOKEN || "test-caller";
const expectedChallenge = process.env.TEST_OPENAI_APPS_CHALLENGE || vars.OPENAI_APPS_CHALLENGE || "test-openai-apps-challenge";

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, text, data };
}

async function admin(path, method = "GET", body) {
  return request(path, {
    method,
    headers: {
      authorization: "Bearer " + adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function parseMcp(text) {
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}

const health = await request("/health");
if (!health.response.ok || health.data.status !== "ok") throw new Error("health check failed");

const challenge = await request("/.well-known/openai-apps-challenge");
if (!challenge.response.ok ||
    challenge.text !== expectedChallenge ||
    !String(challenge.response.headers.get("content-type") || "").startsWith("text/plain")) {
  throw new Error("OpenAI domain challenge response is not exact plain text");
}

const boot = await admin("/admin/bootstrap", "POST", {
  userName: "Owner",
  agentId: "default",
  agentName: "Submission Review PC",
});
if (!boot.response.ok) throw new Error("review bootstrap failed: " + boot.text);

const listed = await request("/mcp?key=" + encodeURIComponent(callerToken), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }),
});
if (!listed.response.ok) throw new Error("tools/list failed: " + listed.text);
const payload = parseMcp(listed.text);
const tools = payload.result?.tools || [];
if (tools.length < 20) throw new Error("unexpectedly small public tool surface");

for (const tool of tools) {
  const annotations = tool.annotations || {};
  for (const key of ["readOnlyHint", "openWorldHint", "destructiveHint"]) {
    if (typeof annotations[key] !== "boolean") {
      throw new Error("missing " + key + " for tool " + tool.name);
    }
  }
  const securitySchemes = tool.securitySchemes || tool._meta?.securitySchemes || [];
  if (!securitySchemes.some((scheme) =>
    scheme?.type === "oauth2" &&
    Array.isArray(scheme.scopes) &&
    scheme.scopes.includes("mcp") &&
    scheme.scopes.includes("offline_access")
  )) {
    throw new Error("missing OAuth security metadata for tool " + tool.name);
  }
}

const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
const expected = {
  read_file: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  write_file: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  terminal_exec: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  screenshot: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  mouse_click: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  agent_lifecycle_status: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  drain_agent: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  resume_agent: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  restart_agent: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  upgrade_agent: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
};
for (const [name, annotations] of Object.entries(expected)) {
  const actual = byName.get(name);
  if (!actual) throw new Error("missing submission tool " + name);
  for (const [key, value] of Object.entries(annotations)) {
    if (actual[key] !== value) {
      throw new Error(name + " " + key + " expected " + value + " got " + actual[key]);
    }
  }
}

const protectedResource = await request("/.well-known/oauth-protected-resource/mcp");
if (!protectedResource.response.ok) throw new Error("protected resource metadata missing");
const authorizationMetadata = await request("/.well-known/oauth-authorization-server");
if (!authorizationMetadata.response.ok) throw new Error("authorization server metadata missing");

console.log("submission readiness smoke test passed");
