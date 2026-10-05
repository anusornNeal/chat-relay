const MAX_TEXT = 160;

function cleanText(value, max = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function normalizedPath(value) {
  return cleanText(value, 260).replace(/\\/g, "/");
}

function compactPath(value) {
  const normalized = normalizedPath(value);
  if (!normalized) return "-";

  const projectMatch = normalized.match(/\/Projects\/[^/]+\/(.+)$/i);
  if (projectMatch?.[1]) return cleanText(projectMatch[1], 120);

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return cleanText(normalized, 120);
  return "…/" + parts.slice(-3).join("/");
}

function cwdLabel(value) {
  const normalized = normalizedPath(value).replace(/\/$/, "");
  if (!normalized) return "";
  const projectMatch = normalized.match(/\/Projects\/([^/]+)(?:\/.*)?$/i);
  if (projectMatch?.[1]) return projectMatch[1];
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || normalized;
}

function redactCommand(value) {
  let text = cleanText(value, 520);
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

function humanBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return Math.round(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";
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

function quotedCommitMessage(command) {
  const match = command.match(/git\s+commit\s+-m\s+["']([^"']+)["']/i);
  return match?.[1] ? cleanText(match[1], 96) : "";
}

function diffTargets(command) {
  const match = command.match(/git\s+diff(?:\s+--check)?\s+--\s+([^;]+)/i);
  if (!match?.[1]) return [];
  return (match[1].match(/"[^"]+"|'[^']+'|\S+/g) || [])
    .map((value) => value.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function humanizeCommand(value) {
  const command = redactCommand(value);
  const lower = command.toLowerCase();

  const pushTag = command.match(/git\s+push\s+origin\s+main[\s\S]*?git\s+push\s+origin\s+([^\s;]+)/i);
  if (pushTag?.[1]) return `Push main and ${cleanText(pushTag[1], 48)} to origin`;

  if (/node\s+--test\s+test[\\/]cli-tui\.test\.mjs/i.test(command) &&
      /npm\s+run\s+test:platform/i.test(command) &&
      /git\s+diff\s+--check/i.test(command)) {
    return "Validate terminal UI · unit tests, platform smoke, and Git checks";
  }

  const version = command.match(/npm\s+version\s+([^\s;]+)/i);
  const commitMessage = quotedCommitMessage(command);
  if (version?.[1] && commitMessage) {
    return `Prepare release ${cleanText(version[1], 32)} · ${commitMessage}`;
  }

  if (/git\s+status\s+--short/i.test(command) && /git\s+branch\s+--show-current/i.test(command) && /git\s+log\b/i.test(command)) {
    return "Check Git status, current branch, and recent commits";
  }

  if (/git\s+status\b/i.test(command) && /git\s+log\b/i.test(command)) {
    return "Check Git status and recent commits";
  }

  if (/git\s+tag\s+--list/i.test(command) && /git\s+status\b/i.test(command)) {
    return "Check release tag and Git status";
  }

  if (/git\s+add\b/i.test(command) && /git\s+commit\b/i.test(command)) {
    return commitMessage ? `Commit changes · ${commitMessage}` : "Stage and commit changes";
  }

  if (/git\s+diff\s+--check/i.test(command) && !/git\s+diff\s+--\s+/i.test(command)) {
    return "Check changes for whitespace errors";
  }

  if (/git\s+diff\b/i.test(command)) {
    const targets = diffTargets(command);
    if (targets.length === 1) return `Review changes · ${compactPath(targets[0])}`;
    if (targets.length > 1) return `Review changes · ${targets.length} files`;
    return "Review Git changes";
  }

  if (/npm\s+publish(?:\s|$)/i.test(command)) {
    return "Publish package to npm";
  }

  const npmView = command.match(/npm\s+view\s+([^\s;]+)\s+version/i);
  if (npmView?.[1]) return `Check published version · ${cleanText(npmView[1], 72)}`;

  if (/node\s+--check\b/i.test(command)) {
    return "Check JavaScript syntax";
  }

  if (/node\s+--test\b/i.test(command) && /cli-tui\.test\.mjs/i.test(command)) {
    return "Run terminal UI tests";
  }

  const npmRun = command.match(/^npm\s+run\s+([^\s;]+)/i);
  if (npmRun?.[1] && !/[;&|]/.test(command)) {
    return `Run npm script · ${cleanText(npmRun[1], 64)}`;
  }

  if (lower === "git status" || lower === "git status --short") return "Check Git status";

  return `Run ${command}`;
}

function withCwd(summary, cwd) {
  const label = cwdLabel(cwd);
  return label ? `${summary} · in ${label}` : summary;
}

export function humanizeToolCall(payload = {}) {
  const action = String(payload?.action || "unknown");

  switch (action) {
    case "ping":
      return "Check agent connection";
    case "agent.config":
      return "Read agent configuration";
    case "agent.recentCalls":
      return `Read recent activity · up to ${number(payload.limit, 50)} calls`;
    case "agent.lifecycle.status":
      return "Check agent lifecycle";
    case "agent.lifecycle.drain":
      return "Pause new long-running work";
    case "agent.lifecycle.resume":
      return "Resume normal work";
    case "agent.lifecycle.restart":
      return "Restart local agent";

    case "fs.stat":
      return `Inspect ${compactPath(payload.path)}`;
    case "fs.list":
      return `Browse ${compactPath(payload.path)} · depth ${number(payload.depth)} · up to ${number(payload.limit, 100)} items`;
    case "fs.read":
      return `Read ${compactPath(payload.path)} · ${lineRange(payload)}`;
    case "fs.readMany":
      return `Read ${Array.isArray(payload.paths) ? payload.paths.length : 0} files`;
    case "fs.batch":
      return `Inspect filesystem · ${Array.isArray(payload.operations) ? payload.operations.length : 0} operations`;
    case "fs.artifact":
      return `Export ${compactPath(payload.path)}`;
    case "fs.write": {
      const bytes = Buffer.byteLength(String(payload.content ?? ""), "utf8");
      const mode = payload.mode === "append" ? "append" : "replace file";
      return `Write ${compactPath(payload.path)} · ${mode} · ${humanBytes(bytes)}`;
    }
    case "fs.edit": {
      const count = Math.max(1, number(payload.expectedReplacements, 1));
      return `Edit ${compactPath(payload.path)} · ${count} change${count === 1 ? "" : "s"}`;
    }
    case "fs.mkdir":
      return `Create folder ${compactPath(payload.path)}`;
    case "fs.move":
      return `Move ${compactPath(payload.source)} → ${compactPath(payload.destination)}`;
    case "fs.delete":
      return `Delete ${compactPath(payload.path)}${payload.recursive ? " and contents" : ""}`;
    case "fs.search.start":
      return `Search "${cleanText(payload.pattern, 72)}" · ${compactPath(payload.path)}`;
    case "fs.search.results":
      return `Read search results · ${number(payload.length, 50)} items from offset ${number(payload.offset)}`;

    case "process.list":
      return `Find processes${payload.filter ? ` matching "${cleanText(payload.filter, 52)}"` : ""}`;
    case "process.kill":
      return `Stop process ${number(payload.pid)}`;

    case "terminal.exec":
      return withCwd(humanizeCommand(payload.command), payload.cwd);
    case "terminal.start":
      return withCwd(`Start background task · ${humanizeCommand(payload.command).replace(/^Run /, "")}`, payload.cwd);
    case "terminal.shell.start":
      return withCwd("Open interactive shell", payload.cwd);
    case "terminal.read":
      return `Read terminal output · ${cleanText(payload.sessionId, 24)} · after #${number(payload.afterSeq)}`;
    case "terminal.write":
      return `Send input to terminal · ${String(payload.input ?? "").length} chars`;
    case "terminal.kill":
      return `Stop terminal session · ${cleanText(payload.sessionId, 24)}`;
    case "terminal.list":
      return "List terminal sessions";
    case "terminal.observability":
      return "Check terminal activity";
    case "terminal.batch.start":
      return `Run terminal batch · ${Array.isArray(payload.jobs) ? payload.jobs.length : 0} jobs · ${number(payload.concurrency, 1)} at a time`;
    case "terminal.batch.status":
      return `Check batch progress · ${cleanText(payload.batchId, 24)}`;
    case "terminal.batch.read":
      return `Read batch output · ${cleanText(payload.batchId, 24)}`;
    case "terminal.batch.cancel":
      return `Cancel batch · ${cleanText(payload.batchId, 24)}`;

    case "desktop.screenshot":
      return "Capture desktop screenshot";
    case "desktop.clipboard.read":
      return "Read clipboard";
    case "desktop.clipboard.write":
      return `Write clipboard · ${String(payload.text ?? payload.content ?? "").length} chars`;
    case "desktop.window.list":
      return "List open windows";
    case "desktop.window.focus":
      return `Focus window · ${cleanText(payload.title ?? payload.windowId ?? payload.handle ?? "", 64)}`;
    case "desktop.mouse.click": {
      const button = cleanText(payload.button || "left", 12);
      return `${button[0]?.toUpperCase() || "L"}${button.slice(1)} click`;
    }
    case "desktop.keyboard.input":
      return `Type on keyboard · ${countKeyboardInput(payload)}`;
    case "desktop.step":
      return `Desktop actions · ${Array.isArray(payload.actions) ? payload.actions.length : 0} steps`;

    default:
      return cleanText(action.replace(/[._]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()), 140) || "Tool call";
  }
}
