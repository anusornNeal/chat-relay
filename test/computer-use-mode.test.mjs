import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseController } from "../agent/computer-use/controller.mjs";
import { LayaComputerUseDriver } from "../agent/computer-use/laya-driver.mjs";
import { getAgentCapabilities } from "../agent/protocol.mjs";

function directDriver() {
  return {
    getConfig: () => ({ enabled: true, supported: true, platform: "win32" }),
    screenshot: async () => ({ ok: true, driver: "direct" }),
    clipboardRead: async () => ({ ok: true }),
    clipboardWrite: async () => ({ ok: true }),
    listWindows: async () => ({ ok: true }),
    focusWindow: async () => ({ ok: true }),
    mouseClick: async () => ({ ok: true }),
    keyboardInput: async () => ({ ok: true }),
    step: async () => ({ ok: true, driver: "direct" }),
    close: () => {},
  };
}

test("direct is default and auto keeps direct driver lazy", async () => {
  let probes = 0;
  const laya = new LayaComputerUseDriver({ probe: async () => { probes += 1; return { available: true, visualCapable: false, computerUseApi: false, reason: "visual_input_unsupported" }; } });
  const controller = new ComputerUseController({ enabled: true, direct: directDriver(), laya });
  assert.equal(controller.status().mode, "direct");
  assert.equal((await controller.setMode("auto")).ok, true);
  assert.equal(probes, 0);
  assert.equal((await controller.step({ actions: [] })).driver, "direct");
});

test("desktop permission is an immutable runtime boundary", async () => {
  const controller = new ComputerUseController({ enabled: false, direct: directDriver(), laya: new LayaComputerUseDriver() });
  const result = await controller.setMode("auto");
  assert.equal(result.error, "desktop_disabled");
  assert.equal(controller.status().mode, "direct");
});

test("current text-only Laya is probed lazily and rejected without changing mode", async () => {
  let probes = 0;
  const laya = new LayaComputerUseDriver({ probe: async () => {
    probes += 1;
    return { available: true, visualCapable: false, computerUseApi: false, command: "laya.exe", reason: "visual_input_unsupported" };
  } });
  const controller = new ComputerUseController({ enabled: true, direct: directDriver(), laya });
  const result = await controller.setMode("laya");
  assert.equal(probes, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "visual_input_unsupported");
  assert.equal(controller.status().mode, "direct");
  assert.equal(controller.status().laya.state, "unavailable");
});

test("invalid mode is rejected", async () => {
  const controller = new ComputerUseController({ enabled: true, direct: directDriver(), laya: new LayaComputerUseDriver() });
  const result = await controller.setMode("bogus");
  assert.equal(result.error, "invalid_computer_use_mode");
});


test("desktop mode capability follows the startup desktop permission boundary", () => {
  const enabled = getAgentCapabilities({ platform: "win32", desktopEnabled: true });
  const disabled = getAgentCapabilities({ platform: "win32", desktopEnabled: false });
  assert.equal(enabled.includes("desktop.mode"), true);
  assert.equal(disabled.includes("desktop.mode"), false);
});
