import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REF = /^@[a-zA-Z0-9_-]+:e[0-9]+$/;
const APP = /^[A-Za-z0-9_][\w .()\-]{0,99}$/;
const MAX_OUTPUT = 256 * 1024;

/**
 * Optional, local-only accessibility backend.
 * No daemon, bundled executable, Worker endpoint, or automatic physical-input fallback.
 */
export class AgentDesktopAdapter {
  constructor({ executable = "agent-desktop", execute = execFileAsync, timeoutMs = 10000 } = {}) {
    this.executable = executable;
    this.execute = execute;
    this.timeoutMs = Math.min(Math.max(1000, timeoutMs), 30000);
  }

  async #call(command, args = []) {
    try {
      const { stdout } = await this.execute(this.executable, [command, ...args], {
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
      });
      const result = JSON.parse(stdout);
      if (typeof result?.ok !== "boolean") return { ok: false, error: { code: "INVALID_OUTPUT" } };
      return result;
    } catch (error) {
      // Never return raw stderr/stdout: these may contain private desktop information.
      return { ok: false, error: { code: error.code === "ENOENT" ? "NOT_INSTALLED" : "EXECUTION_FAILED" } };
    }
  }

  snapshot({ app, interactive = true } = {}) {
    if (typeof app !== "string" || !APP.test(app)) return Promise.resolve({ ok: false, error: { code: "INVALID_APP" } });
    return this.#call("snapshot", ["--app", app, ...(interactive ? ["-i"] : []), "--compact"]);
  }

  click({ ref } = {}) {
    if (typeof ref !== "string" || !REF.test(ref)) return Promise.resolve({ ok: false, error: { code: "INVALID_REF" } });
    return this.#call("click", [ref]);
  }

  setValue({ ref, value } = {}) {
    if (typeof ref !== "string" || !REF.test(ref) || typeof value !== "string" || value.length > 8192) {
      return Promise.resolve({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    return this.#call("set-value", [ref, value]);
  }

  status() {
    return this.#call("status");
  }
}
