import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MAX_SCREENSHOT_BINARY_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "macos-desktop-helper.js");

function execNative(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 512 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function writeNative(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("native_command_timeout"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || "native_command_failed"));
    });
    child.stdin.end(input);
  });
}

function parseSipsSize(output) {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1] || 0);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1] || 0);
  return { width, height };
}

export class MacOSDesktopRunner {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async #jxa(operation, args = {}) {
    try {
      const stdout = await execNative("/usr/bin/osascript", [
        "-l", "JavaScript", helperPath, operation, JSON.stringify(args),
      ], { timeoutMs: this.timeoutMs });
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      const result = line ? JSON.parse(line) : { ok: false, error: "desktop_helper_error" };
      if (result?.ok === false && /not authorized|assistive|accessibility|(-1743)|(-25211)/i.test(String(result.error || ""))) {
        return { ok: false, error: "accessibility_permission_required" };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not authorized|assistive|accessibility|(-1743)/i.test(message)) {
        return { ok: false, error: "accessibility_permission_required" };
      }
      return { ok: false, error: "desktop_helper_error" };
    }
  }

  async #screenInfo() {
    return this.#jxa("screen_info", {});
  }

  async #screenshot(args = {}) {
    const info = await this.#screenInfo();
    if (!info?.ok || !Array.isArray(info.screens) || info.screens.length === 0) {
      return info?.ok === false ? info : { ok: false, error: "capture_failed" };
    }

    const requested = args.monitor ?? "primary";
    let index;
    if (requested === "primary") index = 0;
    else if (requested === "secondary") index = 1;
    else index = Number(requested);
    if (!Number.isInteger(index) || index < 0 || index >= info.screens.length) {
      return { ok: false, error: "monitor_not_found" };
    }

    const screen = info.screens[index];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-relay-shot-"));
    const source = path.join(dir, "source.jpg");
    const output = path.join(dir, "output.jpg");
    try {
      await execNative("/usr/sbin/screencapture", ["-x", "-D", String(index + 1), "-t", "jpg", source], {
        timeoutMs: this.timeoutMs,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "";
        if (/screen recording|permission|not authorized/i.test(message)) throw new Error("screen_recording_permission_required");
        throw error;
      });

      const originalInfo = parseSipsSize(await execNative("/usr/bin/sips", [
        "-g", "pixelWidth", "-g", "pixelHeight", source,
      ]));
      if (!(originalInfo.width > 0 && originalInfo.height > 0)) {
        return { ok: false, error: "capture_failed" };
      }

      let targetWidth = Math.min(Number(args.maxWidth || 960), originalInfo.width);
      const requestedQuality = Math.max(20, Math.min(85, Number(args.quality || 58)));
      const qualities = [...new Set([requestedQuality, 55, 45, 35, 25, 20].filter((q) => q <= requestedQuality))];
      let data = null;
      let finalWidth = 0;
      let finalHeight = 0;
      let finalQuality = requestedQuality;

      for (let attempt = 0; attempt < 5 && !data; attempt += 1) {
        for (const quality of qualities) {
          await fs.rm(output, { force: true });
          await execNative("/usr/bin/sips", [
            "-Z", String(Math.max(320, Math.round(targetWidth))),
            "-s", "format", "jpeg",
            "-s", "formatOptions", String(quality),
            source,
            "--out", output,
          ]);
          const bytes = await fs.readFile(output);
          if (bytes.byteLength > 0 && bytes.byteLength <= MAX_SCREENSHOT_BINARY_BYTES) {
            const resized = parseSipsSize(await execNative("/usr/bin/sips", [
              "-g", "pixelWidth", "-g", "pixelHeight", output,
            ]));
            data = bytes.toString("base64");
            finalWidth = resized.width;
            finalHeight = resized.height;
            finalQuality = quality;
            break;
          }
        }
        targetWidth = Math.max(320, Math.floor(targetWidth * 0.78));
      }

      if (!data) return { ok: false, error: "screenshot_too_large" };
      const scaleX = Number(screen.width) / finalWidth;
      const scaleY = Number(screen.height) / finalHeight;
      return {
        ok: true,
        mimeType: "image/jpeg",
        data,
        width: finalWidth,
        height: finalHeight,
        desktopOriginX: Number(screen.x),
        desktopOriginY: Number(screen.y),
        desktopWidth: Number(screen.width),
        desktopHeight: Number(screen.height),
        scaleX,
        scaleY,
        monitorIndex: index,
        isPrimary: index === 0,
        deviceName: String(screen.deviceName || ("Display " + (index + 1))),
        virtualDesktopOriginX: Number(info.virtualDesktopOriginX),
        virtualDesktopOriginY: Number(info.virtualDesktopOriginY),
        virtualDesktopWidth: Number(info.virtualDesktopWidth),
        virtualDesktopHeight: Number(info.virtualDesktopHeight),
        monitorCount: info.screens.length,
        jpegQuality: finalQuality,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "screen_recording_permission_required") {
        return { ok: false, error: "screen_recording_permission_required" };
      }
      return { ok: false, error: "capture_failed" };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #clipboardRead() {
    try {
      const text = await execNative("/usr/bin/pbpaste", [], { timeoutMs: this.timeoutMs, maxBuffer: 64 * 1024 });
      return { ok: true, text, truncated: false };
    } catch {
      return { ok: false, error: "clipboard_failed" };
    }
  }

  async #clipboardWrite(args = {}) {
    try {
      await writeNative("/usr/bin/pbcopy", [], String(args.text ?? ""), { timeoutMs: this.timeoutMs });
      return { ok: true };
    } catch {
      return { ok: false, error: "clipboard_failed" };
    }
  }

  async #step(args = {}) {
    for (const action of args.actions || []) {
      if (action.type === "wait") {
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        continue;
      }
      const result = action.type === "click"
        ? await this.#jxa("mouse_click", action)
        : await this.#jxa("keyboard_input", action);
      if (!result?.ok) return result || { ok: false, error: "input_failed" };
    }
    if (Number(args.settleMs) > 0) {
      await new Promise((resolve) => setTimeout(resolve, Number(args.settleMs)));
    }
    if (args.captureAfter === false) return { ok: true };
    return this.#screenshot(args);
  }

  async run(operation, args = {}) {
    if (this.platform !== "darwin") return { ok: false, error: "unsupported_platform" };
    if (operation === "screenshot") return this.#screenshot(args);
    if (operation === "clipboard_read") return this.#clipboardRead();
    if (operation === "clipboard_write") return this.#clipboardWrite(args);
    if (operation === "window_list") return this.#jxa("window_list", args);
    if (operation === "window_focus") return this.#jxa("window_focus", args);
    if (operation === "mouse_click") return this.#jxa("mouse_click", args);
    if (operation === "keyboard_input") return this.#jxa("keyboard_input", args);
    if (operation === "step") return this.#step(args);
    return { ok: false, error: "unsupported_operation" };
  }

  close() {}
}
