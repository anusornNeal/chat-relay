import fs from "node:fs";

export const AGENT_PROTOCOL_VERSION = 1;

let cachedVersion = null;

export function getAgentVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const packageUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(packageUrl, "utf8"));
    cachedVersion = typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function getAgentCapabilities(options = {}) {
  const terminalEnabled = options.terminalEnabled === true;
  const desktopEnabled = options.desktopEnabled === true;
  const platform = String(options.platform || process.platform);

  const capabilities = [
    "transport.heartbeat",
    "filesystem.stat",
    "filesystem.list",
    "filesystem.read",
    "filesystem.readMany",
    "filesystem.batch",
    "filesystem.artifact",
    "filesystem.write",
    "filesystem.edit",
    "filesystem.mkdir",
    "filesystem.move",
    "filesystem.delete",
    "filesystem.search",
    "process.list",
    "process.kill",
  ];

  if (terminalEnabled) {
    capabilities.push("terminal.exec", "terminal.sessions", "terminal.batch");
  }

  if (desktopEnabled && ["win32", "darwin"].includes(platform)) {
    capabilities.push("desktop.screenshot", "desktop.control", "desktop.step", "desktop.mode");
  }

  return capabilities;
}

export function buildAgentHello(options = {}) {
  const platform = String(options.platform || process.platform);
  return {
    control: "agent_hello",
    protocolVersion: Number(options.protocolVersion ?? AGENT_PROTOCOL_VERSION),
    agentVersion: String(options.agentVersion || getAgentVersion()),
    platform,
    arch: String(options.arch || process.arch),
    capabilities: getAgentCapabilities({
      terminalEnabled: options.terminalEnabled === true,
      desktopEnabled: options.desktopEnabled === true,
      platform,
    }),
  };
}
