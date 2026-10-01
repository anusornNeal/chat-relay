import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { BoundedLane } from "./capability-scheduler.mjs";

const MAX_SCREENSHOT_BINARY_BYTES = 32 * 1024;
const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 8192;
const MAX_CLIPBOARD_TEXT_LENGTH = 8192;
const MIN_SCREENSHOT_WIDTH = 320;
const MAX_SCREENSHOT_WIDTH = 1920;
const MIN_SCREENSHOT_QUALITY = 20;
const MAX_SCREENSHOT_QUALITY = 85;
const MAX_WINDOW_LIST_LIMIT = 100;
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-desktop-worker.ps1");

const KEY_CODES = new Map([
  ["enter", 0x0D],
  ["tab", 0x09],
  ["escape", 0x1B],
  ["backspace", 0x08],
  ["delete", 0x2E],
  ["arrowleft", 0x25],
  ["arrowup", 0x26],
  ["arrowright", 0x27],
  ["arrowdown", 0x28],
  ["home", 0x24],
  ["end", 0x23],
  ["pageup", 0x21],
  ["pagedown", 0x22],
  ["space", 0x20],
  ...Array.from({ length: 12 }, (_, index) => ["f" + (index + 1), 0x70 + index]),
  ...Array.from({ length: 26 }, (_, index) => [String.fromCharCode(97 + index), 0x41 + index]),
  ...Array.from({ length: 10 }, (_, index) => [String(index), 0x30 + index]),
]);

function normalizedKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeKeyboardInput(input = {}) {
  const hasText = typeof input.text === "string" && input.text.length > 0;
  const hasKey = typeof input.key === "string" && input.key.trim().length > 0;

  if (hasText === hasKey) return { ok: false, error: "invalid_keyboard_input" };

  if (hasText) {
    if (input.text.length > MAX_TEXT_LENGTH) return { ok: false, error: "text_too_large" };
    if (input.ctrl || input.alt || input.shift || input.win) {
      return { ok: false, error: "invalid_keyboard_input" };
    }
    return { ok: true, payload: { text: input.text } };
  }

  const key = normalizedKey(input.key);
  const keyCode = KEY_CODES.get(key);
  if (!keyCode) return { ok: false, error: "unsupported_key" };

  return {
    ok: true,
    payload: {
      keyCode,
      ctrl: input.ctrl === true,
      alt: input.alt === true,
      shift: input.shift === true,
      win: input.win === true,
    },
  };
}

class PersistentDesktopRunner {
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

export function createDesktopPlatformAdapter(options = {}) {
  const platform = options.platform ?? process.platform;
  const customRunner = typeof options.runner === "function" ? options.runner : null;

  if (platform === "win32") {
    const persistentRunner = customRunner ? null : (options.persistentRunner ?? new PersistentDesktopRunner({ platform }));
    return {
      platform,
      supported: true,
      transport: "persistent-worker",
      run: customRunner ?? ((operation, args) => persistentRunner.run(operation, args)),
      close: () => persistentRunner?.close?.(),
    };
  }

  return {
    platform,
    supported: false,
    transport: "unsupported",
    run: customRunner ?? (async () => ({ ok: false, error: "unsupported_platform" })),
    close: () => {},
  };
}

export class DesktopManager {
  constructor(options = {}) {
    this.enabled = options.enabled ?? process.env.DESKTOP_ENABLED === "1";
    this.adapter = options.adapter ?? createDesktopPlatformAdapter({
      platform: options.platform,
      persistentRunner: options.persistentRunner,
      runner: options.runner,
    });
    this.platform = this.adapter.platform;
    this.runner = (operation, args) => this.adapter.run(operation, args);
    this.controlLane = options.controlLane ?? new BoundedLane({
      name: "desktop_control",
      concurrency: 1,
      maxQueued: options.controlMaxQueued ?? process.env.DESKTOP_CONTROL_MAX_QUEUED,
      queueTimeoutMs: options.controlQueueTimeoutMs ?? process.env.AGENT_QUEUE_TIMEOUT_MS,
    });
  }

  getConfig() {
    return {
      enabled: this.enabled,
      supported: this.adapter.supported,
      platform: this.adapter.platform,
      transport: this.adapter.transport,
      controlQueue: this.controlLane.snapshot(),
    };
  }

  gate() {
    if (!this.enabled) return { ok: false, error: "desktop_disabled" };
    if (!this.adapter.supported) return { ok: false, error: "unsupported_platform" };
    return null;
  }

  async runControl(work) {
    try {
      return await this.controlLane.run(work);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "desktop_queue_error" };
    }
  }

  async screenshot(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const monitor = input.monitor ?? "primary";
    if (!(monitor === "primary" || monitor === "secondary" || (Number.isInteger(monitor) && monitor >= 0 && monitor <= 15))) {
      return { ok: false, error: "invalid_monitor" };
    }

    const maxWidth = input.maxWidth === undefined ? 960 : Number(input.maxWidth);
    if (!Number.isInteger(maxWidth) || maxWidth < MIN_SCREENSHOT_WIDTH || maxWidth > MAX_SCREENSHOT_WIDTH) {
      return { ok: false, error: "invalid_max_width" };
    }
    const quality = input.quality === undefined ? 58 : Number(input.quality);
    if (!Number.isInteger(quality) || quality < MIN_SCREENSHOT_QUALITY || quality > MAX_SCREENSHOT_QUALITY) {
      return { ok: false, error: "invalid_quality" };
    }

    const result = await this.runner("screenshot", { monitor, maxWidth, quality });
    return this.normalizeScreenshotResult(result);
  }

  normalizeScreenshotResult(result) {
    if (!result?.ok) return result || { ok: false, error: "capture_failed" };
    if (result.mimeType !== "image/jpeg" || typeof result.data !== "string") {
      return { ok: false, error: "capture_failed" };
    }

    const binaryBytes = Buffer.from(result.data, "base64").byteLength;
    if (binaryBytes <= 0 || binaryBytes > MAX_SCREENSHOT_BINARY_BYTES) {
      return { ok: false, error: "screenshot_too_large" };
    }

    return {
      ...result,
      ok: true,
      width: Number(result.width),
      height: Number(result.height),
      desktopOriginX: Number(result.desktopOriginX),
      desktopOriginY: Number(result.desktopOriginY),
      desktopWidth: Number(result.desktopWidth),
      desktopHeight: Number(result.desktopHeight),
      scaleX: Number(result.scaleX),
      scaleY: Number(result.scaleY),
      monitorIndex: Number(result.monitorIndex),
      isPrimary: result.isPrimary === true,
      deviceName: typeof result.deviceName === "string" ? result.deviceName : undefined,
      virtualDesktopOriginX: Number(result.virtualDesktopOriginX),
      virtualDesktopOriginY: Number(result.virtualDesktopOriginY),
      virtualDesktopWidth: Number(result.virtualDesktopWidth),
      virtualDesktopHeight: Number(result.virtualDesktopHeight),
      monitorCount: Number(result.monitorCount),
      jpegQuality: Number(result.jpegQuality),
      byteLength: binaryBytes,
    };
  }

  async clipboardRead() {
    const gate = this.gate();
    if (gate) return gate;
    const result = await this.runner("clipboard_read", {});
    if (!result?.ok || typeof result.text !== "string") return result || { ok: false, error: "clipboard_failed" };
    return { ok: true, text: result.text.slice(0, MAX_CLIPBOARD_TEXT_LENGTH), truncated: result.truncated === true };
  }

  async clipboardWrite(input = {}) {
    const gate = this.gate();
    if (gate) return gate;
    if (typeof input.text !== "string") return { ok: false, error: "invalid_clipboard_text" };
    if (input.text.length > MAX_CLIPBOARD_TEXT_LENGTH) return { ok: false, error: "text_too_large" };
    return this.runControl(() => this.runner("clipboard_write", { text: input.text }));
  }

  async listWindows(input = {}) {
    const gate = this.gate();
    if (gate) return gate;
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WINDOW_LIST_LIMIT) return { ok: false, error: "invalid_window_limit" };
    const result = await this.runner("window_list", { limit });
    if (!result?.ok || !Array.isArray(result.windows)) return result || { ok: false, error: "window_list_failed" };
    const windows = result.windows.slice(0, limit).map((window) => ({
      windowId: String(window.windowId ?? window.WindowId ?? ""),
      processId: Number(window.processId ?? window.ProcessId),
      title: String(window.title ?? window.Title ?? ""),
      x: Number(window.x ?? window.X),
      y: Number(window.y ?? window.Y),
      width: Number(window.width ?? window.Width),
      height: Number(window.height ?? window.Height),
      isForeground: (window.isForeground ?? window.IsForeground) === true,
    }));
    return { ok: true, windows, count: Math.min(Number(result.count ?? result.Count) || windows.length, limit) };
  }

  async focusWindow(input = {}) {
    const gate = this.gate();
    if (gate) return gate;
    const windowId = String(input.windowId ?? "").trim();
    if (!/^[1-9][0-9]{0,19}$/.test(windowId)) return { ok: false, error: "invalid_window_id" };
    return this.runControl(() => this.runner("window_focus", { windowId }));
  }

  async mouseClick(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const x = Number(input.x);
    const y = Number(input.y);
    const button = String(input.button || "left").toLowerCase();
    const clicks = Number(input.clicks ?? 1);

    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: "invalid_coordinates" };
    if (!["left", "right", "middle"].includes(button)) return { ok: false, error: "invalid_button" };
    if (clicks !== 1 && clicks !== 2) return { ok: false, error: "invalid_click_count" };

    return this.runControl(() => this.runner("mouse_click", { x, y, button, clicks }));
  }

  async keyboardInput(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const normalized = normalizeKeyboardInput(input);
    if (!normalized.ok) return normalized;
    return this.runControl(() => this.runner("keyboard_input", normalized.payload));
  }

  async step(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const actions = Array.isArray(input.actions) ? input.actions : [];
    if (actions.length < 1 || actions.length > 20) return { ok: false, error: "invalid_step_actions" };

    const normalizedActions = [];
    for (const action of actions) {
      if (!action || typeof action !== "object") return { ok: false, error: "invalid_step_action" };
      if (action.type === "click") {
        const x = Number(action.x);
        const y = Number(action.y);
        const button = String(action.button || "left").toLowerCase();
        const clicks = Number(action.clicks ?? 1);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: "invalid_coordinates" };
        if (!["left", "right", "middle"].includes(button)) return { ok: false, error: "invalid_button" };
        if (clicks !== 1 && clicks !== 2) return { ok: false, error: "invalid_click_count" };
        normalizedActions.push({ type: "click", x, y, button, clicks });
        continue;
      }

      if (action.type === "text" || action.type === "key") {
        const normalized = normalizeKeyboardInput(action);
        if (!normalized.ok) return normalized;
        normalizedActions.push({ type: action.type, ...normalized.payload });
        continue;
      }

      if (action.type === "wait") {
        const ms = Number(action.ms);
        if (!Number.isInteger(ms) || ms < 0 || ms > 5000) return { ok: false, error: "invalid_wait" };
        normalizedActions.push({ type: "wait", ms });
        continue;
      }

      return { ok: false, error: "invalid_step_action" };
    }

    const monitor = input.monitor ?? "primary";
    if (!(monitor === "primary" || monitor === "secondary" || (Number.isInteger(monitor) && monitor >= 0 && monitor <= 15))) {
      return { ok: false, error: "invalid_monitor" };
    }

    const settleMs = input.settleMs === undefined ? 120 : Number(input.settleMs);
    if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) return { ok: false, error: "invalid_settle_ms" };

    const wantsCapture = input.captureAfter !== false;
    const maxWidth = input.maxWidth === undefined ? 960 : Number(input.maxWidth);
    const quality = input.quality === undefined ? 58 : Number(input.quality);
    if (wantsCapture && (!Number.isInteger(maxWidth) || maxWidth < MIN_SCREENSHOT_WIDTH || maxWidth > MAX_SCREENSHOT_WIDTH)) {
      return { ok: false, error: "invalid_max_width" };
    }
    if (wantsCapture && (!Number.isInteger(quality) || quality < MIN_SCREENSHOT_QUALITY || quality > MAX_SCREENSHOT_QUALITY)) {
      return { ok: false, error: "invalid_quality" };
    }

    const result = await this.runControl(() => this.runner("step", {
      actions: normalizedActions,
      captureAfter: wantsCapture,
      settleMs,
      monitor,
      ...(wantsCapture ? { maxWidth, quality } : {}),
    }));

    if (input.captureAfter === false) return result;
    return this.normalizeScreenshotResult(result);
  }

  close() {
    this.adapter.close();
  }
}

export { KEY_CODES, MAX_SCREENSHOT_BINARY_BYTES, PersistentDesktopRunner };
