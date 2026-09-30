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
const tinyJpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function managerTests() {
  let runnerCalls = [];
  const runner = async (operation, args) => {
    runnerCalls.push({ operation, args });
    if (operation === "screenshot") {
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
      };
    }
    return { ok: true };
  };

  const disabled = new DesktopManager({ enabled: false, platform: "win32", runner });
  assert((await disabled.screenshot()).error === "desktop_disabled", "disabled screenshot gate failed");
  assert((await disabled.mouseClick({ x: 1, y: 1 })).error === "desktop_disabled", "disabled control gate failed");

  const unsupported = new DesktopManager({ enabled: true, platform: "linux", runner });
  assert((await unsupported.screenshot()).error === "unsupported_platform", "unsupported platform gate failed");

  const manager = new DesktopManager({ enabled: true, platform: "win32", runner });
  const screenshot = await manager.screenshot();
  assert(screenshot.ok && screenshot.mimeType === "image/jpeg" && screenshot.data === tinyJpeg, "controlled screenshot failed");
  const secondaryScreenshot = await manager.screenshot({ monitor: "secondary" });
  assert(secondaryScreenshot.ok, "secondary screenshot failed");
  assert(runnerCalls.some((item) => item.operation === "screenshot" && item.args.monitor === "secondary"), "secondary monitor was not forwarded");
  assert((await manager.screenshot({ monitor: "bogus" })).error === "invalid_monitor", "invalid monitor accepted");
  assert((await manager.mouseClick({ x: 1.2, y: 2 })).error === "invalid_coordinates", "invalid coordinates accepted");
  assert((await manager.mouseClick({ x: 1, y: 2, button: "side" })).error === "invalid_button", "invalid button accepted");
  assert((await manager.mouseClick({ x: 1, y: 2, clicks: 3 })).error === "invalid_click_count", "invalid click count accepted");
  assert((await manager.keyboardInput({})).error === "invalid_keyboard_input", "empty keyboard payload accepted");
  assert((await manager.keyboardInput({ text: "x", key: "Enter" })).error === "invalid_keyboard_input", "conflicting keyboard payload accepted");
  assert((await manager.keyboardInput({ text: "สวัสดี" })).ok, "unicode text path failed");
  assert((await manager.keyboardInput({ key: "A", ctrl: true })).ok, "key chord path failed");
  assert(runnerCalls.some((item) => item.operation === "keyboard_input" && item.args.text === "สวัสดี"), "unicode text was not forwarded");
  assert(runnerCalls.some((item) => item.operation === "keyboard_input" && item.args.keyCode === 0x41 && item.args.ctrl), "key mapping failed");
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
      payload = {
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
        byteLength: Buffer.from(tinyJpeg, "base64").byteLength,
      };
    } else if (action === "desktop.mouse.click" || action === "desktop.keyboard.input") {
      payload = { ok: true, action };
    } else {
      payload = { ok: false, error: "unexpected_action" };
    }
    socket.send(JSON.stringify({ requestId: message.requestId, payload }));
  });

  const reader = await createUser("reader-" + suffix, ["desktop_read"], agentId);
  const controller = await createUser("controller-" + suffix, ["desktop_control"], agentId);
  const legacy = await createUser("legacy-" + suffix, ["read", "write", "terminal", "process"], agentId);
  const wildcard = await createUser("wildcard-" + suffix, ["*"], agentId);

  const listed = await rpc(reader.token, 1, "tools/list");
  const byName = new Map((listed.result?.tools || []).map((tool) => [tool.name, tool]));
  for (const name of ["screenshot", "mouse_click", "keyboard_input"]) {
    assert(byName.has(name), "missing desktop tool " + name);
  }
  assert(byName.get("screenshot")?.annotations?.readOnlyHint === true, "screenshot readOnlyHint missing");
  assert(byName.get("mouse_click")?.annotations?.destructiveHint === true, "mouse destructiveHint missing");
  assert(byName.get("keyboard_input")?.annotations?.destructiveHint === true, "keyboard destructiveHint missing");

  const shot = await rpc(reader.token, 2, "tools/call", {
    name: "screenshot",
    arguments: { agentId },
  });
  assert(!shot.result?.isError, "desktop_read screenshot failed");
  assert(shot.result?.content?.[0]?.type === "text", "screenshot did not return temporary URL metadata");
  const metadata = JSON.parse(shot.result?.content?.[0]?.text || "{}");
  assert(metadata.desktopWidth === 1920 && metadata.scaleX === 1920, "screenshot metadata missing");
  assert(typeof metadata.tempUrl === "string" && metadata.tempUrl.includes("/tmp-shot/"), "temporary screenshot URL missing");
  assert(metadata.expiresInSeconds === 300, "temporary screenshot TTL invalid");

  const tempUrl = metadata.tempUrl.startsWith("http") ? metadata.tempUrl : base + metadata.tempUrl;
  const tempShot = await fetch(tempUrl);
  assert(tempShot.ok, "temporary screenshot URL was not readable");
  assert(tempShot.headers.get("content-type") === "image/jpeg", "temporary screenshot mime type invalid");
  const tempBytes = Buffer.from(await tempShot.arrayBuffer());
  assert(tempBytes.equals(Buffer.from(tinyJpeg, "base64")), "temporary screenshot bytes mismatch");

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

  for (const name of ["screenshot", "mouse_click", "keyboard_input"]) {
    const denied = await rpc(legacy.token, 10 + name.length, "tools/call", {
      name,
      arguments: name === "screenshot"
        ? { agentId }
        : name === "mouse_click"
          ? { agentId, x: 10, y: 10 }
          : { agentId, text: "x" },
    });
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
