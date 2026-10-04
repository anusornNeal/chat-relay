import { BoundedLane } from "./capability-scheduler.mjs";
import { PersistentDesktopRunner } from "./windows-desktop-runner.mjs";
import { MacOSDesktopRunner } from "./macos-desktop-runner.mjs";

const MAX_SCREENSHOT_BINARY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 8192;
const MAX_CLIPBOARD_TEXT_LENGTH = 8192;
const MIN_SCREENSHOT_WIDTH = 320;
const MAX_SCREENSHOT_WIDTH = 1920;
const MIN_SCREENSHOT_QUALITY = 20;
const MAX_SCREENSHOT_QUALITY = 85;
const MAX_WINDOW_LIST_LIMIT = 100;

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
      key,
      keyCode,
      ctrl: input.ctrl === true,
      alt: input.alt === true,
      shift: input.shift === true,
      win: input.win === true,
    },
  };
}

function compactStepActions(actions) {
  const compacted = [];
  for (const action of actions) {
    const previous = compacted.at(-1);
    if (action.type === "wait" && action.ms === 0) continue;
    if (action.type === "text" && previous?.type === "text" &&
        previous.text.length + action.text.length <= MAX_TEXT_LENGTH) {
      previous.text += action.text;
      continue;
    }
    if (action.type === "wait" && previous?.type === "wait" && previous.ms + action.ms <= 5000) {
      previous.ms += action.ms;
      continue;
    }
    compacted.push({ ...action });
  }
  return compacted.length > 0 ? compacted : actions.map((action) => ({ ...action }));
}

function adaptiveActionSettleMs(action, nextAction) {
  if (!nextAction || action.type === "wait") return 0;
  if (action.type === "click") {
    if (action.clicks === 2) return 45;
    return nextAction.type === "text" || nextAction.type === "key" ? 25 : 15;
  }
  if (action.type === "text") return 0;
  if (action.type === "key") {
    if ((action.alt && action.key === "tab") || action.win) return 120;
    if (["enter", "tab", "escape"].includes(action.key)) return 25;
    return 5;
  }
  return 0;
}

function adaptiveFinalSettleMs(actions, wantsCapture) {
  if (!wantsCapture || actions.length === 0) return 0;
  const action = actions.at(-1);
  if (action.type === "wait") return 0;
  if (action.type === "click") return action.clicks === 2 ? 60 : 35;
  if (action.type === "text") return 10;
  if (action.type === "key") {
    if ((action.alt && action.key === "tab") || action.win) return 180;
    if (["enter", "tab", "escape"].includes(action.key)) return 50;
    return 15;
  }
  return 0;
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

  if (platform === "darwin") {
    const macosRunner = customRunner ? null : (options.macosRunner ?? new MacOSDesktopRunner({ platform }));
    return {
      platform,
      supported: true,
      transport: "native-macos",
      run: customRunner ?? ((operation, args) => macosRunner.run(operation, args)),
      close: () => macosRunner?.close?.(),
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
      macosRunner: options.macosRunner,
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

    const native = input.native === true;
    const maxWidth = input.maxWidth === undefined ? 960 : Number(input.maxWidth);
    if (!native && (!Number.isInteger(maxWidth) || maxWidth < MIN_SCREENSHOT_WIDTH || maxWidth > MAX_SCREENSHOT_WIDTH)) {
      return { ok: false, error: "invalid_max_width" };
    }
    const quality = input.quality === undefined ? 58 : Number(input.quality);
    if (!Number.isInteger(quality) || quality < MIN_SCREENSHOT_QUALITY || quality > MAX_SCREENSHOT_QUALITY) {
      return { ok: false, error: "invalid_quality" };
    }

    const result = await this.runner("screenshot", { monitor, maxWidth, quality, native });
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

    const compactedActions = compactStepActions(normalizedActions);
    const optimizedActions = compactedActions.map((action, index) => {
      const settleAfterMs = adaptiveActionSettleMs(action, compactedActions[index + 1]);
      return settleAfterMs > 0 ? { ...action, settleAfterMs } : action;
    });

    const monitor = input.monitor ?? "primary";
    if (!(monitor === "primary" || monitor === "secondary" || (Number.isInteger(monitor) && monitor >= 0 && monitor <= 15))) {
      return { ok: false, error: "invalid_monitor" };
    }

    const wantsCapture = input.captureAfter === true;
    const settleMs = input.settleMs === undefined
      ? adaptiveFinalSettleMs(compactedActions, wantsCapture)
      : Number(input.settleMs);
    if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) return { ok: false, error: "invalid_settle_ms" };

    const maxWidth = input.maxWidth === undefined ? 960 : Number(input.maxWidth);
    const quality = input.quality === undefined ? 58 : Number(input.quality);
    if (wantsCapture && (!Number.isInteger(maxWidth) || maxWidth < MIN_SCREENSHOT_WIDTH || maxWidth > MAX_SCREENSHOT_WIDTH)) {
      return { ok: false, error: "invalid_max_width" };
    }
    if (wantsCapture && (!Number.isInteger(quality) || quality < MIN_SCREENSHOT_QUALITY || quality > MAX_SCREENSHOT_QUALITY)) {
      return { ok: false, error: "invalid_quality" };
    }

    const managerStartedAt = Date.now();
    const result = await this.runControl(async (queueMeta = {}) => {
      const handlerStartedAt = Date.now();
      const workerResult = await this.runner("step", {
        actions: optimizedActions,
        captureAfter: wantsCapture,
        settleMs,
        monitor,
        ...(wantsCapture ? { maxWidth, quality } : {}),
      });
      if (!workerResult || typeof workerResult !== "object") return workerResult;
      return {
        ...workerResult,
        timing: {
          ...(workerResult.timing && typeof workerResult.timing === "object" ? workerResult.timing : {}),
          queueWaitMs: Math.max(0, Number(queueMeta.queueWaitMs) || 0),
          managerMs: Math.max(0, Date.now() - handlerStartedAt),
          requestedActions: normalizedActions.length,
          executedActions: optimizedActions.length,
        },
      };
    });
    if (result && typeof result === "object") {
      result.timing = {
        ...(result.timing && typeof result.timing === "object" ? result.timing : {}),
        totalMs: Math.max(0, Date.now() - managerStartedAt),
      };
    }

    if (!wantsCapture) return result;
    return this.normalizeScreenshotResult(result);
  }

  close() {
    this.adapter.close();
  }
}

export { KEY_CODES, MAX_SCREENSHOT_BINARY_BYTES, PersistentDesktopRunner, MacOSDesktopRunner };
