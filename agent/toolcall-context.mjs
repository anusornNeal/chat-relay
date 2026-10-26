import path from "node:path";
import { humanizeToolCall } from "./toolcall-summary.mjs";

// Derive concise local UI labels, not raw commands or full request payloads.
const WORKSPACE_DIR = /^(projects?|workspaces?|repos?|repositories|code|src)$/i;

function safeLabel(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 64 || /[\u0000-\u001f\u007f/\\]/.test(text) || text === "." || text === "..") return null;
  return text;
}

function normalizeLocation(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/\\/g, "/");
  if (!/^(?:[a-zA-Z]:\/|\/)/.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function samePathOrWithin(location, root) {
  const windows = /^[A-Za-z]:\//.test(location) && /^[A-Za-z]:\//.test(root);
  const current = windows ? location.toLowerCase() : location;
  const boundary = windows ? root.toLowerCase() : root;
  return current === boundary || current.startsWith(boundary + "/");
}

function rootsFrom(value) {
  const inputs = Array.isArray(value) ? value : typeof value === "string" ? value.split(";") : [];
  return inputs.map(normalizeLocation).filter(Boolean).sort((a, b) => b.length - a.length);
}

function pathProject(value, roots, { cwd, directory = false } = {}) {
  let location = normalizeLocation(value);
  if (!location && typeof value === "string" && value.trim() && cwd) {
    const base = normalizeLocation(cwd);
    if (base) location = normalizeLocation(path.posix.join(base, value.replace(/\\/g, "/")));
  }
  if (!location) return null;
  for (const root of roots) {
    if (!samePathOrWithin(location, root)) continue;
    const relative = location.slice(root.length).replace(/^\/+/, "");
    const segments = relative.split("/").filter(Boolean);
    const rootName = root.split("/").filter(Boolean).at(-1) || "";
    if (WORKSPACE_DIR.test(rootName)) {
      // A file directly in the workspace root is not a project.
      if (segments.length < 2 && !directory) return null;
      return safeLabel(segments[0]);
    }
    // A configured root can itself be a project, e.g. ~/repo/chat-relay.
    if (segments[0] && WORKSPACE_DIR.test(segments[0])) {
      if (segments.length < 3 && !directory) return null;
      return safeLabel(segments[1]);
    }
    return safeLabel(rootName);
  }
  return null;
}

function candidatePaths(payload) {
  const action = String(payload?.action || "");
  if (action === "terminal.batch.start") {
    const fallbackCwd = payload.cwd;
    return (Array.isArray(payload.jobs) ? payload.jobs : [])
      .map((job) => ({ value: job && typeof job === "object" ? job.cwd || fallbackCwd : fallbackCwd, directory: true }));
  }
  if (action.startsWith("terminal.")) {
    if (action === "terminal.exec" || action === "terminal.start" || action === "terminal.shell.start") {
      return [{ value: payload.cwd, directory: true }];
    }
    return [];
  }
  if (action === "fs.batch") {
    return (Array.isArray(payload.operations) ? payload.operations : [])
      .flatMap((item) => [item?.path, item?.source, item?.destination]
        .filter((value) => typeof value === "string")
        .map((value) => ({ value, cwd: payload.cwd, directory: item?.op === "list" })));
  }
  if (action === "fs.readMany") {
    return (Array.isArray(payload.paths) ? payload.paths : [])
      .map((item) => ({ value: typeof item === "string" ? item : item?.path, cwd: payload.cwd }));
  }
  if (action === "fs.move") {
    return [{ value: payload.source, cwd: payload.cwd }, { value: payload.destination, cwd: payload.cwd }];
  }
  if (action.startsWith("fs.")) {
    return [{ value: payload.path, cwd: payload.cwd, directory: action === "fs.list" || action === "fs.search.start" }];
  }
  if (action === "git.worktree.cleanup") return [{ value: payload.repoPath, directory: true }];
  return [];
}

export function resolveToolProject(payload = {}, allowedRoots = [], linkedContexts = null) {
  payload = payload && typeof payload === "object" ? payload : {};
  const explicit = safeLabel(payload.projectKey);
  if (explicit) return explicit;
  const roots = rootsFrom(allowedRoots);
  const paths = candidatePaths(payload);
  const names = new Set();
  let unresolved = 0;
  for (const candidate of paths) {
    const result = pathProject(candidate.value, roots, candidate);
    if (result) names.add(result);
    else unresolved += 1;
  }
  if (names.size > 1 || (names.size && unresolved)) return "Multiple projects";
  if (names.size === 1) return [...names][0];
  const lookupId = payload.batchId || payload.sessionId;
  const linked = lookupId && linkedContexts?.get?.(String(lookupId));
  return safeLabel(linked);
}

function shortName(value) {
  const filename = String(value ?? "").trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  return filename ? filename.slice(0, 90) : "file";
}

function relativeLocation(value, project) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === String(project || "").toLowerCase());
  if (index >= 0 && index < parts.length - 1) return parts.slice(index + 1).join("/").slice(0, 130);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : normalized.slice(0, 130);
}

function terminalTitle(payload) {
  const command = String(payload.command || "");
  if (/\bGet-Command\s+(?:rg|ripgrep)\b/i.test(command)) return "Check ripgrep availability";
  const toolCheck = command.match(/\bGet-Command\s+([a-z][a-z0-9.-]{0,25})\b/i);
  if (toolCheck?.[1]) return "Check " + toolCheck[1] + " availability";
  if (/\b(?:Select-String|rg)\b/i.test(command) && !/Get-Command/i.test(command)) return "Search project files";
  const npmScript = command.match(/\bnpm\s+run\s+([a-z][a-z0-9:_-]+)/i);
  if (npmScript?.[1]) {
    const script = npmScript[1].toLowerCase();
    if (script === "test:tui") return "Run terminal UI tests";
    if (script === "test:hardening") return "Run hardening tests";
    if (script === "verify:publish") return "Verify release package";
    if (script === "test:learn-bootstrap") return "Run Learn routing tests";
    if (script.startsWith("test:")) return "Run " + script.slice(5).replace(/-/g, " ") + " tests";
    if (script === "build") return "Build project";
    return "Run npm script " + script.slice(0, 40);
  }
  if (/\bnode\s+--test\b/i.test(command)) return "Run unit tests";
  if (/\bgit\s+diff\s+--check\b/i.test(command)) return "Validate Git changes";
  if (/\bgit\s+status\b/i.test(command) && !/\bgit\s+commit\b/i.test(command)) return "Review Git status";
  if (/\bgit\s+commit\b/i.test(command)) return "Commit changes";
  if (/\bGet-ChildItem\b/i.test(command)) return "Inspect project files";
  const translated = humanizeToolCall(payload).replace(/\s+· in [^·]+$/, "");
  if (translated.startsWith("Run ")) {
    // Do not display arbitrary shell scripts as activity headlines.
    const gitPush = command.match(/\bgit\s+push\s+(?:-u\s+)?origin\s+([a-zA-Z0-9/_-]+)/i);
    if (gitPush?.[1]) return "Push " + gitPush[1].slice(0, 40) + " to origin";
    const getContent = command.match(/\bGet-Content\s+(["']?)([a-zA-Z0-9_./\\:-]+\.[a-z0-9]+)\1/i);
    if (getContent?.[2]) return "Read " + shortName(getContent[2]);
    return "Execute terminal command";
  }
  return translated.slice(0, 160);
}

export function describeToolActivity(payload = {}, allowedRoots = [], linkedContexts = null) {
  payload = payload && typeof payload === "object" ? payload : {};
  const action = String(payload.action || "unknown");
  const project = resolveToolProject(payload, allowedRoots, linkedContexts);
  const filePath = payload.path || payload.source || payload.destination;
  const category = action.startsWith("fs.") ? "Filesystem"
    : action.startsWith("terminal.batch.") ? "Terminal batch"
      : action.startsWith("terminal.") ? "Terminal"
        : action.startsWith("desktop.") ? "Desktop"
          : action.startsWith("process.") ? "Process"
            : action.startsWith("git.") ? "Git"
              : "Agent";
  let operation = humanizeToolCall(payload);
  let detail = "";
  const count = (arr) => Array.isArray(arr) ? arr.length : 0;
  switch (action) {
    case "fs.write":
      operation = (payload.mode === "append" ? "Append " : "Write ") + shortName(payload.path);
      break;
    case "fs.edit":
      operation = "Edit " + shortName(payload.path);
      break;
    case "fs.read":
      operation = "Read " + shortName(payload.path);
      break;
    case "fs.readMany":
      operation = "Read " + count(payload.paths) + " files";
      break;
    case "fs.batch":
      operation = "Inspect " + count(payload.operations) + " filesystem items";
      break;
    case "fs.stat":
      operation = "Inspect " + shortName(payload.path);
      break;
    case "fs.list":
      operation = "Browse " + shortName(payload.path);
      break;
    case "terminal.exec":
    case "terminal.start":
      operation = terminalTitle(payload);
      break;
    case "terminal.batch.start":
      operation = "Run " + count(payload.jobs) + " terminal tasks";
      break;
    case "terminal.batch.read":
      operation = "Review terminal batch results";
      break;
    case "terminal.batch.status":
      operation = "Check terminal batch progress";
      break;
    case "terminal.read":
      operation = "Review terminal output";
      break;
    case "terminal.list":
      operation = "List terminal sessions";
      break;
  }
  if (filePath && category === "Filesystem") detail = relativeLocation(filePath, project);
  return { project, category, operation: String(operation).slice(0, 160), detail };
}
