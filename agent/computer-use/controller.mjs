const MODES = new Set(["direct", "laya", "auto"]);

export class ComputerUseController {
  constructor({ enabled = false, direct, laya } = {}) {
    this.enabled = enabled === true;
    this.direct = direct;
    this.laya = laya;
    this.mode = "direct";
  }

  status() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      activeDriver: this.mode === "laya" ? "laya" : "direct",
      autoStrategy: "direct-first",
      laya: this.laya?.status?.() ?? { state: "unavailable", available: false, reason: "adapter_missing" },
    };
  }

  async setMode(mode) {
    const normalized = String(mode || "").toLowerCase();
    if (!this.enabled) return { ok: false, error: "desktop_disabled", computerUse: this.status() };
    if (!MODES.has(normalized)) return { ok: false, error: "invalid_computer_use_mode", allowed: [...MODES], computerUse: this.status() };

    if (normalized === "laya") {
      const initialized = await this.laya?.initialize?.();
      if (!initialized?.ok || initialized?.ready !== true) {
        return {
          ok: false,
          error: initialized?.error || "laya_unavailable",
          reason: initialized?.reason || this.laya?.status?.()?.reason || "laya_unavailable",
          computerUse: this.status(),
        };
      }
    }

    this.mode = normalized;
    return { ok: true, computerUse: this.status() };
  }

  getConfig() {
    return { ...this.direct.getConfig(), computerUse: this.status() };
  }

  _driver() {
    return this.mode === "laya" ? this.laya : this.direct;
  }

  screenshot(payload) { return this._driver().screenshot(payload); }
  clipboardRead(payload) { return this._driver().clipboardRead(payload); }
  clipboardWrite(payload) { return this._driver().clipboardWrite(payload); }
  listWindows(payload) { return this._driver().listWindows(payload); }
  focusWindow(payload) { return this._driver().focusWindow(payload); }
  mouseClick(payload) { return this._driver().mouseClick(payload); }
  keyboardInput(payload) { return this._driver().keyboardInput(payload); }
  step(payload) { return this._driver().step(payload); }

  close() {
    this.laya?.close?.();
    this.direct?.close?.();
  }
}
