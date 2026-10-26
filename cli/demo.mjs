import { getAgentVersion } from "../agent/protocol.mjs";
import { describeToolActivity } from "../agent/toolcall-context.mjs";
import { RemoteTui } from "./tui.mjs";

// Demo uses only synthetic inputs. It neither loads credentials nor starts an
// agent, a child process, a health monitor, or a network request.
const DEMO_ROOT = "C:\\Projects";
const DEMO_ROOTS = [DEMO_ROOT];
const SIMULATED_AGENT = {
  user: { name: "Demo Account" },
  agentName: "DESKTOP-DEMO",
  allowedRoots: DEMO_ROOT,
  relayUrl: "https://demo.invalid",
  terminalEnabled: true,
  desktopEnabled: true,
};

const SAMPLES = [
  {
    action: "fs.write",
    path: "C:\\Projects\\flowly\\apps\\web\\src\\SkillAdminOverview.tsx",
    mode: "rewrite",
    content: "",
    durationMs: 2,
    requestBytes: 6800,
    responseBytes: 330,
  },
  {
    action: "terminal.exec", cwd: "C:\\Projects\\chat-relay",
    command: "git status --short",
    durationMs: 162, requestBytes: 264, responseBytes: 1200,
  },
  {
    action: "terminal.exec", cwd: "C:\\Projects\\flowly",
    command: "Get-Command rg -ErrorAction SilentlyContinue",
    durationMs: 18, requestBytes: 741, responseBytes: 994,
  },
  {
    action: "terminal.batch.start", cwd: "C:\\Projects\\flowly",
    jobs: [
      { command: "npm run test:tui" },
      { command: "git status --short" },
      { command: "node --check cli/tui.mjs" },
    ],
    concurrency: 3,
    durationMs: 31, requestBytes: 1800, responseBytes: 1100,
  },
  {
    action: "terminal.batch.read", batchId: "demo-batch",
    durationMs: 16, requestBytes: 455, responseBytes: 9800,
  },
  {
    action: "fs.batch",
    operations: [
      { op: "read", path: "C:\\Projects\\flowly\\apps\\web\\src\\App.tsx" },
      { op: "read", path: "C:\\Projects\\chat-relay\\cli\\tui.mjs" },
    ],
    durationMs: 7, requestBytes: 1600, responseBytes: 2600,
  },
  {
    action: "fs.readMany",
    paths: [
      "C:\\Projects\\buddy-android\\app\\src\\main\\java\\NotificationHome.kt",
      "C:\\Projects\\buddy-android\\app\\src\\main\\java\\NewsDetail.kt",
    ],
    durationMs: 12, requestBytes: 1300, responseBytes: 4900,
  },
  {
    action: "terminal.exec", cwd: "C:\\Projects\\chat-relay",
    command: "npm run test:hardening",
    durationMs: 380, requestBytes: 450, responseBytes: 240,
    ok: false, error: "Test failed",
  },
  {
    action: "terminal.start", cwd: "C:\\Projects\\flowly",
    command: "npm run build",
    requestBytes: 310, running: true,
  },
];

export function buildDemoConfig() {
  return {
    ...SIMULATED_AGENT,
    user: { ...SIMULATED_AGENT.user },
  };
}

function demoTui({ output, input, env, onInterrupt } = {}) {
  return new RemoteTui({
    config: buildDemoConfig(),
    version: getAgentVersion(),
    output, input, env, onInterrupt, demo: true,
  });
}

export function seedDemo(tui, { now = Date.now() } = {}) {
  // Synthetic states: they are deliberately not connected to Relay or a real
  // Agent. The TUI marks this status as DEMO rather than Connected.
  tui.state.status = "connected";
  tui.state.relayHealth = { state: "reachable", code: 200 };
  tui.state.learn = true;
  tui.state.reconnects = 0;
  tui.startedAt = now - (3 * 3600 + 24 * 60 + 7) * 1000;
  const linked = new Map([["demo-batch", "flowly"]]);

  for (let index = 0; index < SAMPLES.length; index += 1) {
    const sample = SAMPLES[index];
    const { durationMs, requestBytes, responseBytes, running, ok, error, ...payload } = sample;
    const activity = describeToolActivity(payload, DEMO_ROOTS, linked);
    const requestId = "demo-" + (index + 1);
    const at = new Date(now - (SAMPLES.length - index) * 50_000).toISOString();
    tui.handleMessage({
      type: "chat-relay-ui", event: "tool:start", requestId, at,
      action: payload.action, summary: activity.operation, ...activity, requestBytes,
    });
    if (!running) tui.handleMessage({
      type: "chat-relay-ui", event: "tool:end", requestId, at,
      ok: ok !== false, durationMs, responseBytes, ...(error ? { error } : {}),
    });
  }
  return tui;
}

function boundedDimension(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function renderDemoSnapshot({ width = 112, height = 30, now } = {}) {
  const fragments = [];
  const output = {
    isTTY: false,
    columns: boundedDimension(width, 112, 1, 2048),
    rows: boundedDimension(height, 30, 1, 90),
    write: (value) => { fragments.push(String(value)); return true; },
  };
  const tui = demoTui({ output, input: { isTTY: false }, env: { NO_COLOR: "1" } });
  seedDemo(tui, { now });
  tui.render();
  const frame = fragments.at(-1) || "";
  tui.stop();
  return frame.replace(/^\x1b\[2J\x1b\[H/, "");
}

export async function runTuiDemo({
  output = process.stdout,
  input = process.stdin,
  env = process.env,
  snapshot = false,
  width,
  height,
} = {}) {
  const interactive = output?.isTTY && input?.isTTY && typeof input.setRawMode === "function";
  if (snapshot || !interactive) {
    output.write(renderDemoSnapshot({
      width: width ?? output?.columns ?? 112,
      height: height ?? output?.rows ?? 30,
    }) + "\n");
    return 0;
  }

  return new Promise((resolve, reject) => {
    let done = false;
    let tui;
    function stop() {
      if (done) return;
      done = true;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      tui?.stop();
      resolve(0);
    }
    try {
      tui = demoTui({ output, input, env, onInterrupt: stop });
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      tui.start();
      seedDemo(tui);
      tui.render();
    } catch (error) {
      if (!done) {
        done = true;
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        tui?.stop();
      }
      reject(error);
    }
  });
}
