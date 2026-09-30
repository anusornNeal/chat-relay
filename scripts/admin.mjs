import fs from "node:fs";

function loadVars() {
  if (!fs.existsSync(".dev.vars")) return {};
  return Object.fromEntries(
    fs.readFileSync(".dev.vars", "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

const vars = loadVars();
const base = (process.env.RELAY_URL || vars.RELAY_URL || "https://chat-relay.anusorn-hank.workers.dev").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN || vars.ADMIN_TOKEN;

if (!adminToken) {
  console.error("ADMIN_TOKEN is required in .dev.vars or the environment.");
  process.exit(1);
}

async function call(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(data)}`);
  return data;
}

const [command, ...args] = process.argv.slice(2);

const usage = () => {
  console.log([
    "Usage:",
    "  node scripts/admin.mjs state",
    "  node scripts/admin.mjs bootstrap [agentId] [agentName]",
    "  node scripts/admin.mjs create-user <name> [id]",
    "  node scripts/admin.mjs create-agent <name> [id]",
    "  node scripts/admin.mjs grant <userId> <agentId> [scopesCsv]",
    "  node scripts/admin.mjs revoke <userId> <agentId>",
    "  node scripts/admin.mjs enable-user <userId> <true|false>",
    "  CHAT_RELAY_PASSWORD=... node scripts/admin.mjs set-login <userId> <login>",
    "  node scripts/admin.mjs enable-agent <agentId> <true|false>",
    "  node scripts/admin.mjs rotate-user <userId>",
    "  node scripts/admin.mjs rotate-agent <agentId>",
  ].join("\n"));
};

let result;
switch (command) {
  case "state":
    result = await call("/admin/state");
    break;
  case "bootstrap":
    result = await call("/admin/bootstrap", "POST", {
      agentId: args[0] || "default",
      agentName: args[1] || "Primary PC",
    });
    break;
  case "create-user":
    if (!args[0]) { usage(); process.exit(1); }
    result = await call("/admin/users", "POST", { name: args[0], id: args[1] });
    break;
  case "create-agent":
    if (!args[0]) { usage(); process.exit(1); }
    result = await call("/admin/agents", "POST", { name: args[0], id: args[1] });
    break;
  case "grant":
    if (!args[0] || !args[1]) { usage(); process.exit(1); }
    result = await call("/admin/grants", "POST", {
      userId: args[0],
      agentId: args[1],
      scopes: (args[2] || "read,write,terminal,process").split(",").map((s) => s.trim()).filter(Boolean),
    });
    break;

  case "revoke":
    if (!args[0] || !args[1]) { usage(); process.exit(1); }
    result = await call("/admin/grants/delete", "POST", { userId: args[0], agentId: args[1] });
    break;
  case "set-login": {
    if (!args[0] || !args[1]) { usage(); process.exit(1); }
    const password = process.env.CHAT_RELAY_PASSWORD;
    if (!password) {
      throw new Error("CHAT_RELAY_PASSWORD is required for set-login");
    }
    result = await call("/admin/users/login", "POST", {
      userId: args[0],
      login: args[1],
      password,
    });
    break;
  }
  case "enable-user":
    if (!args[0] || args[1] === undefined) { usage(); process.exit(1); }
    result = await call("/admin/users/enabled", "POST", { userId: args[0], enabled: args[1] === "true" });
    break;
  case "enable-agent":
    if (!args[0] || args[1] === undefined) { usage(); process.exit(1); }
    result = await call("/admin/agents/enabled", "POST", { agentId: args[0], enabled: args[1] === "true" });
    break;
  case "rotate-user":
    if (!args[0]) { usage(); process.exit(1); }
    result = await call("/admin/users/rotate", "POST", { userId: args[0] });
    break;
  case "rotate-agent":
    if (!args[0]) { usage(); process.exit(1); }
    result = await call("/admin/agents/rotate", "POST", { agentId: args[0] });
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}

console.log(JSON.stringify(result, null, 2));
