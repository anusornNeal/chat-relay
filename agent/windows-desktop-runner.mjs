import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const POWERSHELL_TIMEOUT_MS = 15_000;
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-desktop-worker.ps1");

export class PersistentDesktopRunner {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = Number(options.timeoutMs ?? POWERSHELL_TIMEOUT_MS);
    this.process = null;
    this.stdout = null;
    this.pending = new Map();
    this.stderr = "";
  }

  ensureStarted() {
    if (this.platform !== "win32") return false;
    if (this.process && !this.process.killed) return true;

    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.stderr = "";
    this.stdout = readline.createInterface({ input: child.stdout });

    this.stdout.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.result ?? { ok: false, error: "desktop_worker_error" });
    });

    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8192);
    });

    child.on("exit", () => {
      const error = { ok: false, error: "desktop_worker_exited" };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve(error);
      }
      this.pending.clear();
      this.stdout?.close();
      this.stdout = null;
      this.process = null;
    });

    child.on("error", () => {
      // exit handler settles pending work.
    });

    return true;
  }

  async run(operation, args) {
    if (!this.ensureStarted() || !this.process?.stdin?.writable) {
      return { ok: false, error: operation === "screenshot" ? "capture_failed" : "input_failed" };
    }

    const id = randomUUID();
    const request = JSON.stringify({ id, operation, args: args || {} }) + "\n";

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: operation === "screenshot" ? "capture_timeout" : "input_timeout" });
      }, this.timeoutMs);

      this.pending.set(id, { resolve, timer });
      this.process.stdin.write(request, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: operation === "screenshot" ? "capture_failed" : "input_failed" });
      });
    });
  }

  close() {
    try { this.stdout?.close(); } catch {}
    try { this.process?.kill(); } catch {}
    this.stdout = null;
    this.process = null;
  }
}
