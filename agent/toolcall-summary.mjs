const MAX_TEXT = 96;

function cleanText(value, max = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function compactPath(value) {
  const normalized = cleanText(value, 120).replace(/\\/g, "/");
  if (normalized.length <= 72) return normalized || "-";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return "…" + normalized.slice(-68);
  return "…/" + parts.slice(-3).join("/");
}

function redactCommand(value) {
  let text = cleanText(value, 220);
  const patterns = [
    /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/ig,
    /((?:token|password|passwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;]+)/ig,
    /(--(?:token|password|secret|api-key|access-key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s;]+)/ig,
  ];
  for (const pattern of patterns) text = text.replace(pattern, "$1[redacted]");
  return text;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function lineRange(payload) {
  const offset = Math.max(0, number(payload.offset));
  const length = Math.max(1, number(payload.length, 200));
  return `lines ${offset + 1}–${offset + length}`;
}

function countKeyboardInput(payload) {
  if (Array.isArray(payload.actions)) return payload.actions.length + " action" + (payload.actions.length === 1 ? "" : "s");
  if (typeof payload.text === "string") return payload.text.length + " chars";
  if (typeof payload.input === "string") return payload.input.length + " chars";
  return "input";
}

export function humanizeToolCall(payload = {}) {
  const action = String(payload?.action || "unknown");

  switch (action) {
    case "ping":
      return "Ping agent";
    case "agent.config":
      return "Get agent config";
    case "agent.recentCalls":
      return `Get recent tool calls · limit ${number(payload.limit, 50)}`;
    case "agent.lifecycle.status":
      return "Get lifecycle status";
    case "agent.lifecycle.drain":
      return "Drain agent";
    case "agent.lifecycle.resume":
      return "Resume agent";
    case "agent.lifecycle.restart":
      return "Restart agent";

    case "fs.stat":
      return `Stat ${compactPath(payload.path)}`;
    case "fs.list":
      return `List ${compactPath(payload.path)} · depth ${number(payload.depth)} · limit ${number(payload.limit, 100)}`;
    case "fs.read":
      return `Read ${compactPath(payload.path)} · ${lineRange(payload)}`;
    case "fs.readMany":
      return `Read ${Array.isArray(payload.paths) ? payload.paths.length : 0} files`;
    case "fs.batch":
      return `Filesystem batch · ${Array.isArray(payload.operations) ? payload.operations.length : 0} ops`;
    case "fs.artifact":
      return `Export ${compactPath(payload.path)}`;
    case "fs.write": {
      const bytes = Buffer.byteLength(String(payload.content ?? ""), "utf8");
      return `Write ${compactPath(payload.path)} · ${payload.mode || "rewrite"} · ${bytes} B`;
    }
    case "fs.edit":
      return `Edit ${compactPath(payload.path)} · replace ×${number(payload.expectedReplacements, 1)}`;
    case "fs.mkdir":
      return `Create folder ${compactPath(payload.path)}`;
    case "fs.move":
      return `Move ${compactPath(payload.source)} → ${compactPath(payload.destination)}`;
    case "fs.delete":
      return `Delete ${compactPath(payload.path)}${payload.recursive ? " · recursive" : ""}`;
    case "fs.search.start":
      return `Search "${cleanText(payload.pattern, 56)}" in ${compactPath(payload.path)}`;
    case "fs.search.results":
      return `Read search results · offset ${number(payload.offset)} · ${number(payload.length, 50)} rows`;

    case "process.list":
      return `List processes${payload.filter ? ` · "${cleanText(payload.filter, 52)}"` : ""}`;
    case "process.kill":
      return `Kill process ${number(payload.pid)}`;

    case "terminal.exec":
      return `Run ${redactCommand(payload.command)}${payload.cwd ? ` · in ${compactPath(payload.cwd)}` : ""}`;
    case "terminal.start":
      return `Start ${redactCommand(payload.command)}${payload.cwd ? ` · in ${compactPath(payload.cwd)}` : ""}`;
    case "terminal.shell.start":
      return `Start shell${payload.cwd ? ` · in ${compactPath(payload.cwd)}` : ""}`;
    case "terminal.read":
      return `Read terminal ${cleanText(payload.sessionId, 32)} · after #${number(payload.afterSeq)}`;
    case "terminal.write":
      return `Write terminal ${cleanText(payload.sessionId, 32)} · ${String(payload.input ?? "").length} chars`;
    case "terminal.kill":
      return `Stop terminal ${cleanText(payload.sessionId, 32)}`;
    case "terminal.list":
      return "List terminal sessions";
    case "terminal.observability":
      return "Get terminal status";
    case "terminal.batch.start":
      return `Run terminal batch · ${Array.isArray(payload.jobs) ? payload.jobs.length : 0} jobs · concurrency ${number(payload.concurrency, 1)}`;
    case "terminal.batch.status":
      return `Get batch status ${cleanText(payload.batchId, 32)}`;
    case "terminal.batch.read":
      return `Read batch ${cleanText(payload.batchId, 32)}`;
    case "terminal.batch.cancel":
      return `Cancel batch ${cleanText(payload.batchId, 32)}`;

    case "desktop.screenshot":
      return "Capture screen";
    case "desktop.clipboard.read":
      return "Read clipboard";
    case "desktop.clipboard.write":
      return `Write clipboard · ${String(payload.text ?? payload.content ?? "").length} chars`;
    case "desktop.window.list":
      return "List windows";
    case "desktop.window.focus":
      return `Focus window ${cleanText(payload.title ?? payload.windowId ?? payload.handle ?? "", 64)}`;
    case "desktop.mouse.click": {
      const button = cleanText(payload.button || "left", 12);
      const x = number(payload.x);
      const y = number(payload.y);
      return `${button[0]?.toUpperCase() || "L"}${button.slice(1)} click · ${x},${y}`;
    }
    case "desktop.keyboard.input":
      return `Keyboard input · ${countKeyboardInput(payload)}`;
    case "desktop.step":
      return `Desktop step · ${Array.isArray(payload.actions) ? payload.actions.length : 0} actions`;

    default:
      return cleanText(action.replace(/[._]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()), 100) || "Tool call";
  }
}
