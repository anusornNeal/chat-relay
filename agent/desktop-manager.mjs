import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_SCREENSHOT_BINARY_BYTES = 32 * 1024;
const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 8192;
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-desktop.ps1");

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

function encodeArgs(args) {
  return Buffer.from(JSON.stringify(args || {}), "utf8").toString("base64");
}

async function defaultRunner(operation, args) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperPath,
        "-Operation",
        operation,
        "-InputBase64",
        encodeArgs(args),
      ],
      {
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      },
      (error, stdout) => {
        const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (!line) {
          resolve({ ok: false, error: operation === "screenshot" ? "capture_failed" : "input_failed" });
          return;
        }
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: operation === "screenshot" ? "capture_failed" : "input_failed" });
        }
      },
    );
  });
}

export class DesktopManager {
  constructor(options = {}) {
    this.enabled = options.enabled ?? process.env.DESKTOP_ENABLED === "1";
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? defaultRunner;
  }

  getConfig() {
    return {
      enabled: this.enabled,
      supported: this.platform === "win32",
      platform: this.platform,
    };
  }

  gate() {
    if (!this.enabled) return { ok: false, error: "desktop_disabled" };
    if (this.platform !== "win32") return { ok: false, error: "unsupported_platform" };
    return null;
  }

  async screenshot(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const monitor = input.monitor ?? "primary";
    if (!(monitor === "primary" || monitor === "secondary" || (Number.isInteger(monitor) && monitor >= 0 && monitor <= 15))) {
      return { ok: false, error: "invalid_monitor" };
    }

    const result = await this.runner("screenshot", { monitor });
    if (!result?.ok) return result || { ok: false, error: "capture_failed" };
    if (result.mimeType !== "image/jpeg" || typeof result.data !== "string") {
      return { ok: false, error: "capture_failed" };
    }

    const binaryBytes = Buffer.from(result.data, "base64").byteLength;
    if (binaryBytes <= 0 || binaryBytes > MAX_SCREENSHOT_BINARY_BYTES) {
      return { ok: false, error: "screenshot_too_large" };
    }

    return {
      ok: true,
      mimeType: result.mimeType,
      data: result.data,
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
      byteLength: binaryBytes,
    };
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

    return this.runner("mouse_click", { x, y, button, clicks });
  }

  async keyboardInput(input = {}) {
    const gate = this.gate();
    if (gate) return gate;

    const hasText = typeof input.text === "string" && input.text.length > 0;
    const hasKey = typeof input.key === "string" && input.key.trim().length > 0;

    if (hasText === hasKey) return { ok: false, error: "invalid_keyboard_input" };

    if (hasText) {
      if (input.text.length > MAX_TEXT_LENGTH) return { ok: false, error: "text_too_large" };
      if (input.ctrl || input.alt || input.shift || input.win) {
        return { ok: false, error: "invalid_keyboard_input" };
      }
      return this.runner("keyboard_input", { text: input.text });
    }

    const key = normalizedKey(input.key);
    const keyCode = KEY_CODES.get(key);
    if (!keyCode) return { ok: false, error: "unsupported_key" };

    return this.runner("keyboard_input", {
      keyCode,
      ctrl: input.ctrl === true,
      alt: input.alt === true,
      shift: input.shift === true,
      win: input.win === true,
    });
  }
}

export { KEY_CODES, MAX_SCREENSHOT_BINARY_BYTES };
