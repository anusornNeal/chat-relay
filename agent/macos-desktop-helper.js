ObjC.import("AppKit");
ObjC.import("CoreGraphics");

function ok(extra) {
  return Object.assign({ ok: true }, extra || {});
}

function fail(error) {
  return { ok: false, error: String(error || "input_failed") };
}

function screenInfo() {
  $.NSApplication.sharedApplication;
  const screens = $.NSScreen.screens;
  const count = Number(screens.count);
  if (!count) return fail("session_unavailable");
  const primary = screens.objectAtIndex(0);
  const primaryHeight = Number(primary.frame.size.height);
  const output = [];

  for (let i = 0; i < count; i += 1) {
    const screen = screens.objectAtIndex(i);
    const frame = screen.frame;
    const x = Number(frame.origin.x);
    const nsY = Number(frame.origin.y);
    const width = Number(frame.size.width);
    const height = Number(frame.size.height);
    output.push({
      index: i,
      x,
      y: primaryHeight - (nsY + height),
      width,
      height,
      scaleFactor: Number(screen.backingScaleFactor || 1),
      isPrimary: i === 0,
      deviceName: "Display " + (i + 1),
    });
  }

  const minX = Math.min.apply(null, output.map((item) => item.x));
  const minY = Math.min.apply(null, output.map((item) => item.y));
  const maxX = Math.max.apply(null, output.map((item) => item.x + item.width));
  const maxY = Math.max.apply(null, output.map((item) => item.y + item.height));

  return ok({
    screens: output,
    virtualDesktopOriginX: minX,
    virtualDesktopOriginY: minY,
    virtualDesktopWidth: maxX - minX,
    virtualDesktopHeight: maxY - minY,
  });
}

function modifierList(input) {
  const result = [];
  if (input.ctrl) result.push("control down");
  if (input.alt) result.push("option down");
  if (input.shift) result.push("shift down");
  if (input.win) result.push("command down");
  return result;
}

function keyboardInput(input) {
  const system = Application("System Events");
  const modifiers = modifierList(input);
  const options = modifiers.length === 0
    ? {}
    : { using: modifiers.length === 1 ? modifiers[0] : modifiers };

  if (typeof input.text === "string") {
    system.keystroke(input.text);
    return ok();
  }

  const key = String(input.key || "").toLowerCase();
  const special = {
    enter: 36,
    tab: 48,
    escape: 53,
    backspace: 51,
    delete: 117,
    arrowleft: 123,
    arrowup: 126,
    arrowright: 124,
    arrowdown: 125,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    space: 49,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };

  if (Object.prototype.hasOwnProperty.call(special, key)) {
    system.keyCode(special[key], options);
    return ok();
  }

  if (/^[a-z0-9]$/.test(key)) {
    system.keystroke(key, options);
    return ok();
  }

  return fail("unsupported_key");
}

function mouseClick(input) {
  const info = screenInfo();
  if (!info.ok) return info;
  const x = Number(input.x);
  const y = Number(input.y);
  const contains = info.screens.some((screen) =>
    x >= screen.x && x < screen.x + screen.width &&
    y >= screen.y && y < screen.y + screen.height
  );
  if (!contains) return fail("invalid_coordinates");

  const button = String(input.button || "left");
  let mouseButton = $.kCGMouseButtonLeft;
  let downType = $.kCGEventLeftMouseDown;
  let upType = $.kCGEventLeftMouseUp;
  if (button === "right") {
    mouseButton = $.kCGMouseButtonRight;
    downType = $.kCGEventRightMouseDown;
    upType = $.kCGEventRightMouseUp;
  } else if (button === "middle") {
    mouseButton = $.kCGMouseButtonCenter;
    downType = $.kCGEventOtherMouseDown;
    upType = $.kCGEventOtherMouseUp;
  } else if (button !== "left") {
    return fail("invalid_button");
  }

  const point = $.CGPointMake(x, y);
  const count = Number(input.clicks || 1);
  for (let i = 0; i < count; i += 1) {
    const down = $.CGEventCreateMouseEvent($(), downType, point, mouseButton);
    const up = $.CGEventCreateMouseEvent($(), upType, point, mouseButton);
    if (!down || !up) return fail("input_failed");
    if (count > 1) {
      const clickState = i + 1;
      $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, clickState);
      $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, clickState);
    }
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
    $.CFRelease(down);
    $.CFRelease(up);
    if (i + 1 < count) $.NSThread.sleepForTimeInterval(0.08);
  }
  return ok();
}

function windowList(input) {
  const limit = Math.max(1, Math.min(100, Number(input.limit || 50)));
  const system = Application("System Events");
  const processes = system.applicationProcesses();
  const windows = [];

  for (let p = 0; p < processes.length && windows.length < limit; p += 1) {
    const processRef = processes[p];
    let pid;
    let items;
    try {
      pid = Number(processRef.unixId());
      items = processRef.windows();
    } catch (_) {
      continue;
    }

    for (let i = 0; i < items.length && windows.length < limit; i += 1) {
      const windowRef = items[i];
      try {
        const position = windowRef.position();
        const size = windowRef.size();
        const title = String(windowRef.name() || "");
        const width = Number(size[0]);
        const height = Number(size[1]);
        if (!(width > 0 && height > 0)) continue;
        windows.push({
          windowId: String(pid * 10000 + i + 1),
          processId: pid,
          title,
          x: Number(position[0]),
          y: Number(position[1]),
          width,
          height,
          isForeground: processRef.frontmost() === true,
        });
      } catch (_) {}
    }
  }

  return ok({ windows, count: windows.length });
}

function windowFocus(input) {
  const encoded = Number(input.windowId);
  if (!Number.isFinite(encoded) || encoded <= 0) return fail("invalid_window_id");
  const pid = Math.floor(encoded / 10000);
  const index = (encoded % 10000) - 1;
  if (!(pid > 0 && index >= 0)) return fail("invalid_window_id");

  const system = Application("System Events");
  const matches = system.applicationProcesses.whose({ unixId: pid });
  if (!matches.length) return fail("window_not_found");
  const processRef = matches[0];
  const items = processRef.windows();
  if (index >= items.length) return fail("window_not_found");

  processRef.frontmost = true;
  try {
    const action = items[index].actions.byName("AXRaise");
    action.perform();
  } catch (_) {}
  return ok();
}

function run(argv) {
  try {
    const operation = String(argv[0] || "");
    const input = argv[1] ? JSON.parse(argv[1]) : {};
    if (operation === "screen_info") return JSON.stringify(screenInfo());
    if (operation === "keyboard_input") return JSON.stringify(keyboardInput(input));
    if (operation === "mouse_click") return JSON.stringify(mouseClick(input));
    if (operation === "window_list") return JSON.stringify(windowList(input));
    if (operation === "window_focus") return JSON.stringify(windowFocus(input));
    return JSON.stringify(fail("unsupported_operation"));
  } catch (error) {
    return JSON.stringify(fail(error && error.message ? error.message : "input_failed"));
  }
}
