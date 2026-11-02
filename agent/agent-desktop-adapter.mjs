import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REF = /^@[A-Za-z0-9_-]{2,80}:e[1-9][0-9]{0,7}$/;
const APP = /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]{0,99}$/u;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 45 * 1024;
const MAX_VALUE_LENGTH = 8192;

function failure(code) {
  return { ok: false, error: { code } };
}

function parseEnvelope(stdout, kind) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return failure("INVALID_OUTPUT");
  }
  if (!result || typeof result.ok !== "boolean") return failure("INVALID_OUTPUT");
  if (!result.ok) {
    // Never reflect raw messages, paths, stderr or CLI diagnostics to the remote caller.
    const code = typeof result.error?.code === "string" && /^[A-Z_]{2,60}$/.test(result.error.code)
      ? result.error.code : "COMMAND_FAILED";
    const retry = result.error?.disposition?.retry;
    const delivery = result.error?.disposition?.delivery;
    return {
      ok: false,
      error: {
        code,
        ...(retry === "safe" || retry === "unsafe" ? { retry } : {}),
        ...(typeof delivery === "string" && /^[a-z_]{1,40}$/.test(delivery) ? { delivery } : {}),
      },
    };
  }
  const data = result.data;
  if (!data || typeof data !== "object") return failure("INVALID_OUTPUT");
  if (kind === "snapshot" &&
      (typeof data.app !== "string" || typeof data.snapshot_id !== "string" ||
       typeof data.ref_count !== "number" || typeof data.complete !== "boolean" ||
       !data.tree || typeof data.tree !== "object")) return failure("INVALID_OUTPUT");
  if (kind === "status" && (typeof data.version !== "string" ||
      typeof data.platform !== "string")) return failure("INVALID_OUTPUT");
  if (kind === "action" && (typeof data.action !== "string" ||
      typeof data.disposition?.delivery !== "string")) return failure("INVALID_OUTPUT");
  let compact;
  if (kind === "snapshot") {
    compact = {
      app: data.app,
      window: data.window,
      snapshot_id: data.snapshot_id,
      ref_count: data.ref_count,
      complete: data.complete,
      ...(data.truncated ? { truncated: true } : {}),
      tree: data.tree,
    };
  } else if (kind === "status") {
    compact = {
      platform: data.platform,
      version: data.version,
      accessibility: data.permissions?.accessibility?.state,
      supported_surfaces: data.supported_surfaces,
    };
  } else {
    compact = {
      action: data.action,
      disposition: data.disposition,
      verification_scope: data.verification_scope,
    };
  }
  const response = { ok: true, backend: "agent-desktop", data: compact };
  return Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_RESULT_BYTES
    ? response : failure("RESULT_TOO_LARGE");
}

/**
 * Optional headless CLI adapter. Never invokes --headed or synthesizes physical input.
 * The native binary is installed separately, not bundled with Chat Relay.
 */
export class AgentDesktopAdapter {
  constructor({ executable = process.env.AGENT_DESKTOP_BIN || (process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop"), execute = execFileAsync, timeoutMs = 10000 } = {}) {
    this.executable = executable;
    this.execute = execute;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(Math.max(1000, timeoutMs), 30000) : 10000;
  }

  async #call(command, args = [], kind = "action") {
    try {
      const { stdout } = await this.execute(this.executable, [command, ...args], {
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
      });
      return parseEnvelope(stdout, kind);
    } catch (error) {
      // agent-desktop returns its structured JSON even on nonzero exit codes.
      if (typeof error?.stdout === "string" && error.stdout.trim()) {
        return parseEnvelope(error.stdout, kind);
      }
      return failure(error?.code === "ENOENT" ? "NOT_INSTALLED"
        : error?.killed || error?.code === "ETIMEDOUT" ? "TIMEOUT" : "EXECUTION_FAILED");
    }
  }

  snapshot({ app, root, interactive = true, maxDepth = 6, skeleton = false } = {}) {
    if (typeof app !== "string" || !APP.test(app)) return Promise.resolve(failure("INVALID_APP"));
    if (root !== undefined && (typeof root !== "string" || !REF.test(root))) {
      return Promise.resolve(failure("INVALID_REF"));
    }
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8 ||
        typeof interactive !== "boolean" || typeof skeleton !== "boolean") {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    return this.#call("snapshot", [
      "--app", app, ...(interactive ? ["--interactive-only"] : []),
      "--compact", "--max-depth", String(maxDepth),
      ...(root ? ["--root", root] : []),
      ...(skeleton ? ["--skeleton"] : []),
    ], "snapshot");
  }

  click({ ref } = {}) {
    if (typeof ref !== "string" || !REF.test(ref)) return Promise.resolve(failure("INVALID_REF"));
    return this.#call("click", [ref]);
  }

  setValue({ ref, value } = {}) {
    if (typeof ref !== "string" || !REF.test(ref) ||
        typeof value !== "string" || value.length > MAX_VALUE_LENGTH) {
      return Promise.resolve(failure("INVALID_INPUT"));
    }
    return this.#call("set-value", [ref, value]);
  }

  status() {
    return this.#call("status", [], "status");
  }

  executeAction(action = {}) {
    switch (action.operation) {
      case "snapshot": return this.snapshot(action);
      case "click": return this.click(action);
      case "set-value": return this.setValue(action);
      case "status": return this.status();
      default: return Promise.resolve(failure("INVALID_OPERATION"));
    }
  }
}
