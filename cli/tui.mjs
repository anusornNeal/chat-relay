import { humanizeToolCall } from "../agent/toolcall-summary.mjs";

const ESC = "\x1b[";
const LABEL_WIDTH = 12;
const GAP = 3;
const MIN_FRAME_WIDTH = 60;
const MAX_FRAME_WIDTH = 179;
const FRAME_FIXED_ROWS = 11;
const FRAME_BOTTOM_MARGIN = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function truncate(value, width) {
  const text = String(value ?? "");
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}

function field(label, value, width) {
  const valueWidth = Math.max(1, width - LABEL_WIDTH);
  return truncate(String(label).padEnd(LABEL_WIDTH) + truncate(value, valueWidth), width).padEnd(width);
}

export function formatTwoColumnHeader(state, width = 110) {
  const usable = clamp(Number(width) || 110, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH);
  const leftWidth = Math.floor((usable - GAP) / 2);
  const rightWidth = usable - GAP - leftWidth;
  const rows = [
    ["Account", state.account || "-", "Agent", state.agent || "-"],
    ["Status", statusText(state.status), "Relay", state.relay || "-"],
    ["Uptime", formatUptime(state.uptimeMs), "Reconnects", String(state.reconnects ?? 0)],
    ["Terminal", state.terminal ? "enabled" : "disabled", "Desktop", state.desktop ? "enabled" : "disabled"],
  ];
  return rows
    .map(([leftLabel, leftValue, rightLabel, rightValue]) =>
      field(leftLabel, leftValue, leftWidth) + " ".repeat(GAP) + field(rightLabel, rightValue, rightWidth).trimEnd(),
    )
    .join("\n");
}

function statusText(value) {
  switch (String(value || "").toLowerCase()) {
    case "connected": return "● Connected";
    case "connecting": return "◐ Connecting";
    case "reconnecting": return "◐ Reconnecting";
    case "stopping": return "○ Stopping";
    case "offline": return "○ Offline";
    default: return "○ Starting";
  }
}

function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatDuration(ms, status) {
  if (status === "running") return "running";
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return Math.round(value) + "ms";
  return (value / 1000).toFixed(value < 10000 ? 1 : 0) + "s";
}

function clock(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function wrapText(value, width, maxLines = 3) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const usable = Math.max(1, Number(width) || 1);
  if (!text) return [""];
  const lines = [];
  let remaining = text;

  while (remaining && lines.length < maxLines) {
    if (remaining.length <= usable) {
      lines.push(remaining);
      remaining = "";
      break;
    }

    let cut = remaining.lastIndexOf(" ", usable);
    if (cut < Math.floor(usable * 0.45)) cut = usable;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining && lines.length) {
    const index = lines.length - 1;
    lines[index] = truncate(lines[index] + " " + remaining, usable);
  }

  return lines.length ? lines : [""];
}

export function formatTransactionRows(item, width = 110) {
  const usable = clamp(Number(width) || 110, 60, 180);
  const status = item.status === "running" ? "●" : item.ok === false ? "✕" : "✓";
  const prefix = `${clock(item.at)}  ${status}  `;
  const continuationPrefix = " ".repeat(prefix.length);
  const duration = formatDuration(item.durationMs, item.status);
  const suffix = "  " + duration.padStart(8);
  const summaryWidth = Math.max(18, usable - prefix.length - suffix.length);
  const summaryLines = wrapText(item.summary || item.action || "Tool call", summaryWidth, 3);

  return summaryLines.map((line, index) => {
    if (index === 0) {
      return prefix + line.padEnd(summaryWidth) + suffix;
    }
    return continuationPrefix + line;
  });
}

export function formatTransactionRow(item, width = 110) {
  return formatTransactionRows(item, width).join("\n");
}

function normalizeRelay(value) {
  try {
    const url = new URL(String(value));
    return url.host + (url.pathname && url.pathname !== "/" ? url.pathname : "");
  } catch {
    return String(value || "-").replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

export function shouldUseTui(options = {}, stdout = process.stdout) {
  if (options.tuiEnabled === false) return false;
  if (options.tuiEnabled === true) return true;
  return Boolean(stdout?.isTTY);
}

export class RemoteTui {
  constructor({ config, version, output = process.stdout }) {
    this.output = output;
    this.startedAt = Date.now();
    this.state = {
      account: config.user?.name || config.user?.login || "signed in",
      agent: config.agentName || config.agentId || "-",
      relay: normalizeRelay(config.relayUrl),
      status: "starting",
      reconnects: 0,
      terminal: config.terminalEnabled !== false,
      desktop: config.desktopEnabled === true,
    };
    this.version = version || "-";
    this.transactions = [];
    this.timer = null;
    this.closed = false;
    this.renderPending = false;
  }

  start() {
    if (this.closed) return;
    // Use the terminal's alternate screen so periodic redraws never accumulate
    // in scrollback. Keep one column unused to avoid automatic line wrapping.
    this.output.write(ESC + "?1049h" + ESC + "?25l" + ESC + "2J" + ESC + "H");
    this.render();
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.output.write(ESC + "?25h" + ESC + "?1049l");
  }

  handleMessage(message) {
    if (!message || message.type !== "chat-relay-ui") return;
    if (message.event === "connection") {
      this.state.status = message.state || this.state.status;
      if (Number.isFinite(Number(message.reconnects))) this.state.reconnects = Number(message.reconnects);
    } else if (message.event === "tool:start") {
      this.transactions.push({
        requestId: message.requestId,
        at: message.at || new Date().toISOString(),
        action: message.action,
        summary: message.summary || humanizeToolCall({ action: message.action }),
        status: "running",
        ok: null,
      });
      if (this.transactions.length > 100) this.transactions.splice(0, this.transactions.length - 100);
    } else if (message.event === "tool:end") {
      const item = [...this.transactions].reverse().find((entry) => entry.requestId === message.requestId);
      if (item) {
        item.status = "done";
        item.ok = message.ok !== false;
        item.durationMs = message.durationMs;
        if (message.error && message.ok === false) item.summary += ` · ${truncate(message.error, 48)}`;
      }
    } else if (message.event === "system") {
      this.transactions.push({
        requestId: "system-" + Date.now() + "-" + Math.random(),
        at: message.at || new Date().toISOString(),
        summary: message.message || "Agent event",
        status: "done",
        ok: message.level !== "error",
      });
      if (this.transactions.length > 100) this.transactions.splice(0, this.transactions.length - 100);
    }
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.closed || this.renderPending) return;
    this.renderPending = true;
    setImmediate(() => {
      this.renderPending = false;
      this.render();
    });
  }

  render() {
    if (this.closed) return;
    const terminalWidth = Number(this.output.columns) || 110;
    const width = clamp(terminalWidth - 1, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH);
    const height = Math.max(16, Number(this.output.rows) || 30);
    const separator = "─".repeat(width);
    const header = formatTwoColumnHeader({
      ...this.state,
      uptimeMs: Date.now() - this.startedAt,
    }, width);
    // Fixed frame content occupies 11 rows. Leave one spare row at the
    // bottom so Windows Terminal never scrolls the screen while repainting.
    const availableRows = Math.max(1, height - FRAME_FIXED_ROWS - FRAME_BOTTOM_MARGIN);
    const rows = [];
    for (let index = this.transactions.length - 1; index >= 0 && rows.length < availableRows; index--) {
      const group = formatTransactionRows(this.transactions[index], width);
      const remaining = availableRows - rows.length;
      if (group.length <= remaining) {
        rows.unshift(...group);
      } else if (rows.length === 0) {
        rows.unshift(...group.slice(0, remaining));
      } else {
        break;
      }
    }
    while (rows.length < Math.min(availableRows, 4)) rows.unshift("");

    const screen = [
      `Chat Relay  v${this.version}`,
      separator,
      "",
      header,
      "",
      separator,
      "Transactions",
      "",
      ...rows,
    ].join("\n");

    this.output.write(ESC + "2J" + ESC + "H" + screen);
  }
}
