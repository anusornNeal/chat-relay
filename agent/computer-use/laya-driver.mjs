import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

function execFileAsync(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function candidateCommands() {
  const configured = String(process.env.LAYA_COMMAND || "").trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python314", "Python313", "Python312"]) {
        candidates.push(path.join(localAppData, "Programs", "Python", version, "Scripts", "laya.exe"));
      }
    }
    candidates.push("laya.exe");
  } else {
    candidates.push("laya");
  }
  return [...new Set(candidates)];
}

export async function probeLocalLaya() {
  for (const command of candidateCommands()) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
    const result = await execFileAsync(command, ["--help"]);
    if (result.error) continue;
    const help = result.stdout + "\n" + result.stderr;
    const visualCapable = /--(?:image|screenshot|vision)\b/i.test(help);
    return {
      available: true,
      command,
      visualCapable,
      computerUseApi: false,
      reason: visualCapable ? "computer_use_api_not_integrated" : "visual_input_unsupported",
    };
  }
  return { available: false, visualCapable: false, computerUseApi: false, reason: "laya_not_found" };
}

export class LayaComputerUseDriver {
  constructor({ probe = probeLocalLaya } = {}) {
    this.probe = probe;
    this.snapshot = { state: "stopped", available: null, visualCapable: null, ready: false, reason: null };
  }

  status() {
    return { ...this.snapshot };
  }

  async initialize() {
    if (this.snapshot.ready) return { ok: true, ready: true, ...this.status() };
    this.snapshot = { ...this.snapshot, state: "starting", reason: null };
    try {
      const result = await this.probe();
      const ready = result.available === true && result.visualCapable === true && result.computerUseApi === true;
      this.snapshot = {
        state: ready ? "ready" : "unavailable",
        available: result.available === true,
        visualCapable: result.visualCapable === true,
        ready,
        command: result.command ?? null,
        reason: ready ? null : (result.reason || "laya_unavailable"),
      };
      return ready
        ? { ok: true, ready: true, ...this.status() }
        : { ok: false, ready: false, error: "laya_unavailable", reason: this.snapshot.reason, ...this.status() };
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        state: "error",
        ready: false,
        reason: error instanceof Error ? error.message : "laya_probe_failed",
      };
      return { ok: false, ready: false, error: "laya_probe_failed", ...this.status() };
    }
  }

  _unsupported() {
    return { ok: false, error: "laya_unavailable", reason: this.snapshot.reason || "laya_not_initialized" };
  }

  screenshot() { return this._unsupported(); }
  clipboardRead() { return this._unsupported(); }
  clipboardWrite() { return this._unsupported(); }
  listWindows() { return this._unsupported(); }
  focusWindow() { return this._unsupported(); }
  mouseClick() { return this._unsupported(); }
  keyboardInput() { return this._unsupported(); }
  step() { return this._unsupported(); }
  close() {}
}
