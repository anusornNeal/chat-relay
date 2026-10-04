import fs from "node:fs";
import WebSocket from "ws";
import { DesktopManager } from "../agent/desktop-manager.mjs";

const vars = fs.existsSync(".dev.vars")
  ? Object.fromEntries(
      fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)
        .filter((line) => line && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    )
  : {};

const base = (process.env.TEST_RELAY_URL || "http://127.0.0.1:8807").replace(/\/$/, "");
const adminToken = process.env.TEST_ADMIN_TOKEN || vars.ADMIN_TOKEN || "test-admin";
const nativeJpeg = Buffer.alloc(1_900_000, 0x41).toString("base64");
const tinyJpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function managerTests() {
  let runnerCalls = [];
  const runner = async (operation, args) => {
    runnerCalls.push({ operation, args });
    if (operation === "screenshot" || (operation === "step" && args.captureAfter === true)) {
      return {
        ok: true,
        mimeType: "image/jpeg",
        data: tinyJpeg,
        width: 1,
        height: 1,
        desktopOriginX: 0,
        desktopOriginY: 0,
        desktopWidth: 1920,
        desktopHeight: 1080,
        scaleX: 1920,
        scaleY: 1080,
        virtualDesktopOriginX: -1920,
        virtualDesktopOriginY: 0,
        virtualDesktopWidth: 3840,
        virtualDesktopHeight: 1080,
        monitorCount: 2,
        jpegQuality: args.quality ?? 58,
      };
    }
    if (operation === "clipboard_read") return { ok: true, text: "clip", truncated: false };
    if (operation === "window_list") return { ok: true, windows: [{ WindowId: "123", ProcessId: 42, Title: "Editor", X: 10, Y: 20, Width: 800, Height: 600, IsForeground: true }], Count: 1 };
    return { ok: true };
  };

  const disabled = new DesktopManager({ enabled: false, platform: "win32", runner });
  assert((await disabled.screenshot()).error === "desktop_disabled", "disabled screenshot gate failed");
  assert((await disabled.mouseClick({ x: 1, y: 1 })).error === "desktop_disabled", "disabled control gate failed");

  const unsupported = new DesktopManager({ enabled: true, platform: "linux", runner });
  assert((await unsupported.screenshot()).error === "unsupported_platform", "unsupported platform gate failed");

  const macManager = new DesktopManager({ enabled: true, platform: "darwin", runner });
  assert(macManager.getConfig().supported && macManager.getConfig().transport === "native-macos", "macOS adapter was not enabled");
  const macScreenshot = await macManager.screenshot();
  assert(macScreenshot.ok && macScreenshot.mimeType === "image/jpeg", "macOS controlled screenshot contract failed");
  macManager.close();
  const manager = new DesktopManager({ enabled: true, platform: "win32", runner });
  const screenshot = await manager.screenshot();
  assert(screenshot.ok && screenshot.mimeType === "image/jpeg" && screenshot.data === tinyJpeg, "controlled screenshot failed");
  const secondaryScreenshot = await manager.screenshot({ monitor: "secondary", maxWidth: 720, quality: 50 });
  assert(secondaryScreenshot.ok, "secondary screenshot failed");
  assert(secondaryScreenshot.virtualDesktopWidth === 3840 && secondaryScreenshot.monitorCount === 2, "virtual desktop metadata missing");
  assert(runnerCalls.some((item) => item.operation === "screenshot" && item.args.monitor === "secondary" && item.args.maxWidth === 720 && item.args.quality === 50), "screenshot options were not forwarded");
  assert((await manager.screenshot({ monitor: "bogus" })).error === "invalid_monitor", "invalid monitor accepted");
  assert((await manager.screenshot({ maxWidth: 200 })).error === "invalid_max_width", "invalid screenshot width accepted");
  assert((await manager.screenshot({ quality: 90 })).error === "invalid_quality", "invalid screenshot quality accepted");
  const clipboard = await manager.clipboardRead();
  assert(clipboard.ok && clipboard.text === "clip", "clipboard read failed");
  assert((await manager.clipboardWrite({ text: "hello" })).ok, "clipboard write failed");
  assert((await manager.clipboardWrite({ text: "x".repeat(8193) })).error === "text_too_large", "oversize clipboard accepted");
  const windows = await manager.listWindows({ limit: 10 });
  assert(windows.ok && windows.windows[0]?.windowId === "123", "window list failed");
  assert((await manager.focusWindow({ windowId: "123" })).ok, "window focus failed");
  assert((await manager.focusWindow({ windowId: "bad" })).error === "invalid_window_id", "invalid window id accepted");
  assert((await manager.mouseClick({ x: 1.2, y: 2 })).error === "invalid_coordinates", "invalid coordinates accepted");
  assert((await manager.mouseClick({ x: 1, y: 2, button: "side" })).error === "invalid_button", "invalid button accepted");
  assert((await manager.mouseClick({ x: 1, y: 2, clicks: 3 })).error === "invalid_click_count", "invalid click count accepted");
  assert((await manager.keyboardInput({})).error === "invalid_keyboard_input", "empty keyboard payload accepted");
  assert((await manager.keyboardInput({ text: "x", key: "Enter" })).error === "invalid_keyboard_input", "conflicting keyboard payload accepted");
  assert((await manager.keyboardInput({ text: "สวัสดี" })).ok, "unicode text path failed");
  assert((await manager.keyboardInput({ key: "A", ctrl: true })).ok, "key chord path failed");
  assert(runnerCalls.some((item) => item.operation === "keyboard_input" && item.args.text === "สวัสดี"), "unicode text was not forwarded");
  assert(runnerCalls.some((item) => item.operation === "keyboard_input" && item.args.key === "a" && item.args.keyCode === 0x41 && item.args.ctrl), "key mapping failed");

  const step = await manager.step({
    actions: [
      { type: "click", x: 10, y: 20 },
      { type: "text", text: "hello" },
      { type: "key", key: "Enter" },
      { type: "wait", ms: 10 },
    ],
    captureAfter: true,
    monitor: "secondary",
    maxWidth: 640,
    quality: 45,
  });
  assert(step.ok, "desktop step failed");
  const stepCall = runnerCalls.find((item) => item.operation === "step");
  assert(stepCall?.args.actions.length === 4, "desktop step actions were not batched");
  assert(stepCall?.args.actions[0]?.settleAfterMs === 25, "adaptive click settle was not applied");
  assert(stepCall?.args.monitor === "secondary", "desktop step monitor was not forwarded");
  assert(stepCall?.args.maxWidth === 640 && stepCall?.args.quality === 45, "desktop step capture options were not forwarded");

  const fastStep = await manager.step({ actions: [
    { type: "text", text: "a" },
    { type: "text", text: "b" },
    { type: "wait", ms: 0 },
  ] });
  assert(fastStep.ok, "default no-capture step failed");
  const fastStepCall = runnerCalls.filter((item) => item.operation === "step").at(-1);
  assert(fastStepCall?.args.captureAfter === false, "desktop step captured by default");
  assert(fastStepCall?.args.actions.length === 1 && fastStepCall.args.actions[0]?.text === "ab", "desktop step compaction failed");
  assert(fastStepCall?.args.settleMs === 0, "no-capture step added final settle");
  assert(fastStep.timing?.requestedActions === 3 && fastStep.timing?.executedActions === 1, "step timing action counts missing");

  let activeControls = 0;
  let maxActiveControls = 0;
  let controlCalls = 0;
  let releaseFirstControl;
  const firstControlGate = new Promise((resolve) => { releaseFirstControl = resolve; });
  const serialized = new DesktopManager({
    enabled: true,
    platform: "win32",
    controlMaxQueued: 1,
    controlQueueTimeoutMs: 120,
    runner: async (operation) => {
      if (operation === "screenshot") {
        return {
          ok: true, mimeType: "image/jpeg", data: tinyJpeg,
          width: 1, height: 1, desktopOriginX: 0, desktopOriginY: 0,
          desktopWidth: 1920, desktopHeight: 1080, scaleX: 1920, scaleY: 1080,
        };
      }
      activeControls += 1;
      maxActiveControls = Math.max(maxActiveControls, activeControls);
      controlCalls += 1;
      if (controlCalls === 1) await firstControlGate;
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeControls -= 1;
      return { ok: true };
    },
  });
  const firstControl = serialized.mouseClick({ x: 1, y: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondControl = serialized.keyboardInput({ text: "x" });
  const overflowControl = await serialized.mouseClick({ x: 2, y: 2 });
  assert(overflowControl.error === "queue_full", "desktop control queue limit failed");
  const concurrentRead = await serialized.screenshot();
  assert(concurrentRead.ok, "desktop read was blocked by control queue");
  assert(controlCalls === 1, "desktop controls were not queued exclusively");
  releaseFirstControl();
  await Promise.all([firstControl, secondControl]);
  assert(maxActiveControls === 1 && controlCalls === 2, "desktop control serialization failed");
  assert(serialized.getConfig().controlQueue.concurrency === 1, "desktop control queue config missing");
}

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  return { response, data, text };
}

async function admin(path, method = "GET", body) {
  const result = await request(path, {
    method,
    headers: {
      authorization: "Bearer " + adminToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!result.response.ok) throw new Error("admin " + path + ": " + result.text);
  return result.data;
}

async function rpc(token, id, method, params = {}) {
  const response = await fetch(base + "/mcp?key=" + encodeURIComponent(token), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("rpc " + response.status + " " + text);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  if (!line) throw new Error("missing MCP data");
  return JSON.parse(line.slice(6));
}

async function createUser(suffix, scopes, agentId) {
  const created = await admin("/admin/users", "POST", {
    name: "Desktop " + suffix,
    id: "desktop-" + suffix,
  });
  await admin("/admin/grants", "POST", {
    userId: created.user.id,
    agentId,
    scopes,
  });
  return { token: created.token, id: created.user.id };
}

async function mcpTests() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const agentId = "desktop-mock-" + suffix;
  const createdAgent = await admin("/admin/agents", "POST", {
    name: "Desktop Mock",
    id: agentId,
  });

  const socket = new WebSocket(
    base.replace(/^http/, "ws") + "/agent?agentId=" + encodeURIComponent(agentId),
    { headers: { Authorization: "Bearer " + createdAgent.token } },
  );

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const action = message.payload?.action;
    let payload;
    if (action === "desktop.screenshot") {
      const native = message.payload?.native === true;
      const data = native ? nativeJpeg : tinyJpeg;
      payload = {
        ok: true,
        mimeType: "image/jpeg",
        data,
        width: 1,
        height: 1,
        desktopOriginX: 0,
        desktopOriginY: 0,
        desktopWidth: 1920,
        desktopHeight: 1080,
        scaleX: 1920,
        scaleY: 1080,
        virtualDesktopOriginX: -1920,
        virtualDesktopOriginY: 0,
        virtualDesktopWidth: 3840,
        virtualDesktopHeight: 1080,
        monitorCount: 2,
        jpegQuality: message.payload?.quality ?? 58,
        byteLength: Buffer.from(data, "base64").byteLength,
        native,
      };
    } else if (action === "desktop.step") {
      if (message.payload?.captureAfter !== true) {
        payload = { ok: true, action, actionsCompleted: message.payload?.actions?.length || 0 };
      } else {
        payload = {
          ok: true,
          action,
          actionsCompleted: message.payload?.actions?.length || 0,
          mimeType: "image/jpeg",
          data: tinyJpeg,
          width: 1,
          height: 1,
          desktopOriginX: 0,
          desktopOriginY: 0,
          desktopWidth: 1920,
          desktopHeight: 1080,
          scaleX: 1920,
          scaleY: 1080,
          virtualDesktopOriginX: -1920,
          virtualDesktopOriginY: 0,
          virtualDesktopWidth: 3840,
          virtualDesktopHeight: 1080,
          monitorCount: 2,
          jpegQuality: message.payload?.quality ?? 58,
          byteLength: Buffer.from(tinyJpeg, "base64").byteLength,
        };
      }
    } else if (action === "desktop.clipboard.read") {
      payload = { ok: true, text: "mock clipboard", truncated: false };
    } else if (action === "desktop.clipboard.write") {
      payload = { ok: true, action, length: message.payload?.text?.length || 0 };
    } else if (action === "desktop.window.list") {
      payload = { ok: true, windows: [{ windowId: "123", processId: 42, title: "Editor", x: 10, y: 20, width: 800, height: 600, isForeground: true }], count: 1 };
    } else if (action === "desktop.window.focus") {
      payload = { ok: true, action, windowId: message.payload?.windowId };
    } else if (action === "desktop.mouse.click" || action === "desktop.keyboard.input") {
      payload = { ok: true, action };
    } else {
      payload = { ok: false, error: "unexpected_action" };
    }
    socket.send(JSON.stringify({ requestId: message.requestId, payload }));
  });

  const reader = await createUser("reader-" + suffix, ["desktop_read"], agentId);
  const controller = await createUser("controller-" + suffix, ["desktop_control"], agentId);
  const operator = await createUser("operator-" + suffix, ["desktop_read", "desktop_control"], agentId);
  const legacy = await createUser("legacy-" + suffix, ["read", "write", "terminal", "process"], agentId);
  const wildcard = await createUser("wildcard-" + suffix, ["*"], agentId);

  const listed = await rpc(reader.token, 1, "tools/list");
  const byName = new Map((listed.result?.tools || []).map((tool) => [tool.name, tool]));
  for (const name of ["screenshot", "clipboard_read", "clipboard_write", "list_windows", "focus_window", "mouse_click", "keyboard_input", "desktop_step"]) {
    assert(byName.has(name), "missing desktop tool " + name);
  }
  assert(byName.get("screenshot")?.annotations?.readOnlyHint === true, "screenshot readOnlyHint missing");
  assert(byName.get("clipboard_read")?.annotations?.readOnlyHint === true, "clipboard readOnlyHint missing");
  assert(byName.get("list_windows")?.annotations?.readOnlyHint === true, "window list readOnlyHint missing");
  assert(byName.get("clipboard_write")?.annotations?.destructiveHint === true, "clipboard write destructiveHint missing");
  assert(byName.get("focus_window")?.annotations?.destructiveHint === true, "window focus destructiveHint missing");
  assert(byName.get("mouse_click")?.annotations?.destructiveHint === true, "mouse destructiveHint missing");
  assert(byName.get("keyboard_input")?.annotations?.destructiveHint === true, "keyboard destructiveHint missing");

  const shot = await rpc(reader.token, 2, "tools/call", {
    name: "screenshot",
    arguments: { agentId, maxWidth: 720, quality: 50 },
  });
  assert(!shot.result?.isError, "desktop_read screenshot failed");
  const imageBlock = shot.result?.content?.find((item) => item.type === "image");
  const textBlock = shot.result?.content?.find((item) => item.type === "text");
  assert(imageBlock?.data === tinyJpeg && imageBlock?.mimeType === "image/jpeg", "screenshot did not return direct image content");
  assert(textBlock?.type === "text", "screenshot did not return temporary URL metadata");
  const metadata = JSON.parse(textBlock?.text || "{}");
  assert(metadata.desktopWidth === 1920 && metadata.scaleX === 1920, "screenshot metadata missing");
  assert(metadata.virtualDesktopOriginX === -1920 && metadata.virtualDesktopWidth === 3840 && metadata.monitorCount === 2, "virtual desktop metadata missing");
  assert(metadata.jpegQuality === 50, "screenshot quality metadata missing");
  assert(typeof metadata.tempUrl === "string" && metadata.tempUrl.includes("/tmp-shot/"), "temporary screenshot URL missing");
  assert(metadata.expiresInSeconds === 300, "temporary screenshot TTL invalid");

  const tempPath = metadata.tempUrl.startsWith("http")
    ? new URL(metadata.tempUrl).pathname
    : metadata.tempUrl;
  const tempShot = await fetch(base + tempPath);
  assert(tempShot.ok, "temporary screenshot URL was not readable");
  assert(tempShot.headers.get("content-type") === "image/jpeg", "temporary screenshot mime type invalid");
  const tempBytes = Buffer.from(await tempShot.arrayBuffer());
  assert(tempBytes.equals(Buffer.from(tinyJpeg, "base64")), "temporary screenshot bytes mismatch");

  const nativeShot = await rpc(reader.token, 29, "tools/call", {
    name: "screenshot",
    arguments: { agentId, native: true },
  });
  assert(!nativeShot.result?.isError, "native screenshot failed");
  assert(!nativeShot.result?.content?.some((item) => item.type === "image"), "native screenshot unexpectedly embedded image bytes");
  const nativeMeta = JSON.parse(nativeShot.result?.content?.find((item) => item.type === "text")?.text || "{}");
  assert(nativeMeta.native === true && nativeMeta.byteLength === 1_900_000, "native screenshot metadata invalid");
  const nativePath = nativeMeta.tempUrl.startsWith("http") ? new URL(nativeMeta.tempUrl).pathname : nativeMeta.tempUrl;
  const nativeResponse = await fetch(base + nativePath);
  assert(nativeResponse.ok, "chunked native screenshot URL was not readable");
  const nativeBytes = Buffer.from(await nativeResponse.arrayBuffer());
  assert(nativeBytes.length === 1_900_000 && nativeBytes.equals(Buffer.from(nativeJpeg, "base64")), "chunked native screenshot bytes mismatch");

  const readerClipboard = await rpc(reader.token, 30, "tools/call", { name: "clipboard_read", arguments: { agentId } });
  assert(!readerClipboard.result?.isError && JSON.parse(readerClipboard.result?.content?.[0]?.text || "{}").payload?.text === "mock clipboard", "desktop_read clipboard failed");
  const readerWindows = await rpc(reader.token, 31, "tools/call", { name: "list_windows", arguments: { agentId, limit: 10 } });
  assert(!readerWindows.result?.isError && JSON.parse(readerWindows.result?.content?.[0]?.text || "{}").payload?.windows?.[0]?.windowId === "123", "desktop_read window list failed");
  const readerClipboardWrite = await rpc(reader.token, 32, "tools/call", { name: "clipboard_write", arguments: { agentId, text: "x" } });
  assert(readerClipboardWrite.result?.isError === true, "desktop_read unexpectedly gained clipboard control");
  const readerFocus = await rpc(reader.token, 33, "tools/call", { name: "focus_window", arguments: { agentId, windowId: "123" } });
  assert(readerFocus.result?.isError === true, "desktop_read unexpectedly gained window focus control");


  const readerClick = await rpc(reader.token, 3, "tools/call", {
    name: "mouse_click",
    arguments: { agentId, x: 10, y: 10 },
  });
  assert(readerClick.result?.isError === true, "desktop_read unexpectedly gained control permission");

  const controllerShot = await rpc(controller.token, 4, "tools/call", {
    name: "screenshot",
    arguments: { agentId },
  });
  assert(controllerShot.result?.isError === true, "desktop_control unexpectedly gained screenshot permission");

  const controllerClipboardRead = await rpc(controller.token, 34, "tools/call", { name: "clipboard_read", arguments: { agentId } });
  assert(controllerClipboardRead.result?.isError === true, "desktop_control unexpectedly gained clipboard read permission");
  const controllerWindows = await rpc(controller.token, 35, "tools/call", { name: "list_windows", arguments: { agentId } });
  assert(controllerWindows.result?.isError === true, "desktop_control unexpectedly gained window list permission");
  const controllerClipboardWrite = await rpc(controller.token, 36, "tools/call", { name: "clipboard_write", arguments: { agentId, text: "hello" } });
  assert(!controllerClipboardWrite.result?.isError, "desktop_control clipboard write failed");
  const controllerFocus = await rpc(controller.token, 37, "tools/call", { name: "focus_window", arguments: { agentId, windowId: "123" } });
  assert(!controllerFocus.result?.isError, "desktop_control window focus failed");


  const controllerClick = await rpc(controller.token, 5, "tools/call", {
    name: "mouse_click",
    arguments: { agentId, x: 10, y: 10, button: "left", clicks: 1 },
  });
  assert(!controllerClick.result?.isError, "desktop_control click failed");

  const controllerKey = await rpc(controller.token, 6, "tools/call", {
    name: "keyboard_input",
    arguments: { agentId, key: "A", ctrl: true },
  });
  assert(!controllerKey.result?.isError, "desktop_control keyboard failed");

  const controllerStepNoCapture = await rpc(controller.token, 7, "tools/call", {
    name: "desktop_step",
    arguments: {
      agentId,
      actions: [{ type: "click", x: 10, y: 10 }],
    },
  });
  assert(!controllerStepNoCapture.result?.isError, "desktop_control default no-capture step failed");

  const controllerStepWithCapture = await rpc(controller.token, 8, "tools/call", {
    name: "desktop_step",
    arguments: {
      agentId,
      actions: [{ type: "click", x: 10, y: 10 }],
      captureAfter: true,
    },
  });
  assert(controllerStepWithCapture.result?.isError === true, "desktop_control gained screenshot through desktop_step");

  const operatorStep = await rpc(operator.token, 9, "tools/call", {
    name: "desktop_step",
    arguments: {
      agentId,
      actions: [
        { type: "click", x: 10, y: 10 },
        { type: "text", text: "hello" },
        { type: "key", key: "Enter" },
      ],
      captureAfter: true,
      maxWidth: 640,
      quality: 45,
    },
  });
  assert(!operatorStep.result?.isError, "combined desktop_step failed");
  assert(operatorStep.result?.content?.some((item) => item.type === "image"), "desktop_step did not return image content");

  for (const name of ["screenshot", "mouse_click", "keyboard_input", "desktop_step"]) {
    const denied = await rpc(legacy.token, 10 + name.length, "tools/call", {
      name,
      arguments: name === "screenshot"
        ? { agentId }
        : name === "mouse_click"
          ? { agentId, x: 10, y: 10 }
          : name === "keyboard_input"
            ? { agentId, text: "x" }
            : { agentId, actions: [{ type: "click", x: 10, y: 10 }], captureAfter: false },
    });
    assert(denied.result?.isError === true, "legacy scopes unexpectedly authorized " + name);
  }  for (const [name, args] of [
    ["clipboard_read", { agentId }],
    ["clipboard_write", { agentId, text: "x" }],
    ["list_windows", { agentId }],
    ["focus_window", { agentId, windowId: "123" }],
  ]) {
    const denied = await rpc(legacy.token, 50 + name.length, "tools/call", { name, arguments: args });
    assert(denied.result?.isError === true, "legacy scopes unexpectedly authorized " + name);
  }


  const wildcardShot = await rpc(wildcard.token, 20, "tools/call", {
    name: "screenshot",
    arguments: { agentId },
  });
  assert(!wildcardShot.result?.isError, "wildcard grant lost desktop compatibility");

  socket.close();
}

await managerTests();
await mcpTests();
console.log("desktop MCP/permission smoke test passed");
