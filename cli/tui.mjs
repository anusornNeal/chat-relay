import { humanizeToolCall } from "../agent/toolcall-summary.mjs";

const ESC = "\x1b[";
const RESET = "\x1b[0m";
const STYLE = {
  reset: RESET,
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};
const LABEL_WIDTH = 12;
const GAP = 3;
const MIN_FRAME_WIDTH = 60;
const MAX_FRAME_WIDTH = 179; // Legacy fixed-width formatter only.
const MAX_TUI_VIEWPORT_WIDTH = 2048; // Full-width monitor, bounded for unusual terminals.
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

function codePointCellWidth(codePoint) {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || codePoint === 0xfe0f
    || codePoint === 0x0e31
    || (codePoint >= 0x0e34 && codePoint <= 0x0e3a)
    || (codePoint >= 0x0e47 && codePoint <= 0x0e4e)
    || codePoint === 0x200d
  ) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f000 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

export function terminalCellWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) width += codePointCellWidth(char.codePointAt(0));
  return width;
}

function truncateCells(value, width) {
  const text = String(value ?? "");
  const limit = Math.max(0, Number(width) || 0);
  if (limit === 0) return "";
  if (terminalCellWidth(text) <= limit) return text;
  if (limit === 1) return "…";
  let output = "";
  let used = 0;
  for (const char of text) {
    const cells = codePointCellWidth(char.codePointAt(0));
    if (used + cells > limit - 1) break;
    output += char;
    used += cells;
  }
  return output + "…";
}

function paint(value, ...styles) {
  if (!styles.length) return String(value ?? "");
  return styles.join("") + String(value ?? "") + RESET;
}

function field(label, value, width, color = false, valueStyle = null) {
  const valueWidth = Math.max(1, width - LABEL_WIDTH);
  const plainLabel = String(label).padEnd(LABEL_WIDTH);
  const plainValue = truncate(value, valueWidth);
  const plain = truncate(plainLabel + plainValue, width).padEnd(width);
  if (!color) return plain;
  const renderedLabel = paint(plainLabel, STYLE.gray);
  const renderedValue = valueStyle ? paint(plainValue, valueStyle) : plainValue;
  return renderedLabel + renderedValue + " ".repeat(Math.max(0, width - plainLabel.length - plainValue.length));
}

function relayIsOnline(health) {
  const code = Number(health?.code);
  if (Number.isFinite(code)) return code >= 200 && code < 300;
  return health?.state === "reachable";
}

function combinedStatusText(status, relayHealth) {
  return String(status || "").toLowerCase() === "connected" && relayIsOnline(relayHealth)
    ? "● Online"
    : "○ Offline";
}

function combinedStatusStyle(status, relayHealth) {
  return String(status || "").toLowerCase() === "connected" && relayIsOnline(relayHealth)
    ? STYLE.green
    : STYLE.red;
}

function learnStatusText(value) {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "checking";
}

function learnStatusStyle(value) {
  if (value === true) return STYLE.green;
  if (value === false) return STYLE.red;
  return STYLE.yellow;
}

function compactLearnStatus(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return "checking";
}

export function formatTwoColumnHeader(state, width = 110, { color = false } = {}) {
  const usable = clamp(Number(width) || 110, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH);
  const leftWidth = Math.floor((usable - GAP) / 2);
  const rightWidth = usable - GAP - leftWidth;
  const rows = [
    ["Account", state.account || "-", "Agent", state.agent || "-"],
    ["Status", combinedStatusText(state.status, state.relayHealth), "Relay", state.relay || "-"],
    ["Root", state.root || "-", "Reconnects", String(state.reconnects ?? 0)],
    ["Session up", formatUptime(state.uptimeMs), "Terminal", state.terminal ? "enabled" : "disabled"],
    ["Desktop", state.desktop ? "enabled" : "disabled", "Learn", learnStatusText(state.learn)],
  ];
  return rows
    .map(([leftLabel, leftValue, rightLabel, rightValue]) => {
      const leftStyle = leftLabel === "Status"
        ? combinedStatusStyle(state.status, state.relayHealth)
        : null;
      const rightStyle = rightLabel === "Reconnects" && Number(state.reconnects || 0) > 0
        ? STYLE.yellow
        : rightLabel === "Learn"
          ? learnStatusStyle(state.learn)
          : null;
      return field(leftLabel, leftValue, leftWidth, color, leftStyle)
        + " ".repeat(GAP)
        + field(rightLabel, rightValue, rightWidth, color, rightStyle).trimEnd();
    })
    .join("\n");
}

function statusText(value) {
  switch (String(value || "").toLowerCase()) {
    case "connected": return "● WebSocket open";
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

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + " KB";
  return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + " MB";
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

export function formatTransactionRows(item, width = 110, { color = false } = {}) {
  const requested = Number(width) || 110;
  const usable = clamp(requested, Math.min(60, Math.max(1, requested)), 180);
  const status = item.status === "running" ? "🟡" : item.ok === false ? "❌" : "✅";
  if (usable < 32) {
    const compact = truncateCells(`${clock(item.at)} ${status} ${item.summary || item.action || "Tool call"}`, usable);
    if (!color) return [compact];
    const glyphStyle = item.status === "running" ? STYLE.yellow : item.ok === false ? STYLE.red : STYLE.green;
    return [paint(compact, glyphStyle)];
  }
  const prefix = `${clock(item.at)}  ${status}  `;
  const prefixWidth = terminalCellWidth(prefix);
  const continuationPrefix = " ".repeat(prefixWidth);
  const duration = formatDuration(item.durationMs, item.status);
  const transfer = [
    Number.isFinite(Number(item.requestBytes)) ? "↑ " + formatBytes(item.requestBytes) : null,
    Number.isFinite(Number(item.responseBytes)) ? "↓ " + formatBytes(item.responseBytes) : null,
  ].filter(Boolean).join("  ");
  const suffix = "  " + (transfer ? transfer + "  " : "") + duration.padStart(8);
  const summaryWidth = Math.max(4, usable - prefixWidth - terminalCellWidth(suffix));
  const summaryLines = wrapText(item.summary || item.action || "Tool call", summaryWidth, 3);

  return summaryLines.map((line, index) => {
    if (index === 0) {
      const plainRow = prefix + line.padEnd(summaryWidth) + suffix;
      if (!color) return plainRow;
      if (item.ok === false) return paint(plainRow, STYLE.red);
      const time = paint(clock(item.at), STYLE.gray);
      const glyphStyle = item.status === "running" ? STYLE.yellow : STYLE.green;
      const glyph = paint(status, glyphStyle, STYLE.bold);
      const summary = item.status === "running" ? paint(line.padEnd(summaryWidth), STYLE.bold) : line.padEnd(summaryWidth);
      const timing = paint(suffix, STYLE.gray);
      return `${time}  ${glyph}  ${summary}${timing}`;
    }
    if (!color) return continuationPrefix + line;
    if (item.ok === false) return continuationPrefix + paint(line, STYLE.red);
    return continuationPrefix + paint(line, STYLE.dim);
  });
}

export function formatTransactionRow(item, width = 110, options) {
  return formatTransactionRows(item, width, options).join("\n");
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

export function shouldUseColor(stdout = process.stdout, env = process.env) {
  if (!stdout?.isTTY) return false;
  if (Object.prototype.hasOwnProperty.call(env || {}, "NO_COLOR")) return false;
  if (String(env?.TERM || "").toLowerCase() === "dumb") return false;
  return true;
}

const MONITOR = {
  accent: "\x1b[38;2;93;218;203m",
  bright: "\x1b[38;2;235;241;248m",
  muted: "\x1b[38;2;128;145;164m",
  dim: "\x1b[38;2;104;121;139m",
  border: "\x1b[38;2;45;60;77m",
  good: "\x1b[38;2;91;218;163m",
  bad: "\x1b[38;2;247;114;114m",
  warning: "\x1b[38;2;243;192;101m",
  liveBg: "\x1b[48;2;20;62;55m",
};

function tint(value, style, enabled) {
  return enabled ? paint(value, style) : value;
}

function cellPad(value, width) {
  const clipped = truncateCells(value, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - terminalCellWidth(clipped)));
}

function activityCategory(item) {
  if (item.category) return String(item.category);
  const action = String(item.action || "");
  if (action.startsWith("fs.")) return "Filesystem";
  if (action.startsWith("terminal.")) return "Terminal";
  if (action.startsWith("desktop.")) return "Desktop";
  if (action.startsWith("learn")) return "Learn";
  return "Agent";
}

function activityTitle(item) {
  const value = String(item.operation || item.summary || item.action || "Tool call").replace(/\s+/g, " ").trim();
  if (!item.operation && /^Run (?:Write-Output|Get-Command|Get-Content|Set-Variable|Start-Process)\b/i.test(value)) {
    return "Execute terminal command";
  }
  return value;
}

function activityRows(item, width, { color = false, twoLines = false } = {}) {
  const limit = Math.max(1, width);
  const project = String(item.project || "General");
  const title = activityTitle(item);
  const symbol = item.status === "running" ? "◌" : item.ok === false ? "×" : "✓";
  const symbolColor = item.status === "running" ? MONITOR.warning : item.ok === false ? MONITOR.bad : MONITOR.good;
  const time = clock(item.at);
  if (limit < 52) {
    if (limit <= 2) return [tint(truncateCells(symbol, limit), symbolColor, color)];
    const prefix = limit >= 37 ? time.slice(0, 5) + " " : "";
    const bodyWidth = Math.max(0, limit - terminalCellWidth(prefix) - 2);
    const projectText = truncateCells(project + " · ", bodyWidth);
    const titleText = truncateCells(title, Math.max(0, bodyWidth - terminalCellWidth(projectText)));
    const plain = prefix + symbol + " " + projectText + titleText;
    return [color
      ? tint(prefix, MONITOR.dim, true) + tint(symbol, symbolColor, true) + " "
        + tint(projectText, MONITOR.muted, true) + tint(titleText, MONITOR.bright, true)
      : plain];
  }
  const opStart = 13;
  const durationWidth = 10;
  const operationWidth = Math.max(1, limit - opStart - durationWidth);
  const duration = formatDuration(item.durationMs, item.status);
  const operation = cellPad(title, operationWidth);
  const prefix = cellPad(time, 8) + "  ";
  const ending = cellPad(duration, durationWidth);
  const headline = color
    ? tint(prefix, MONITOR.dim, true) + tint(symbol, symbolColor, true) + "  " + tint(operation, MONITOR.bright, true) + tint(ending, MONITOR.dim, true)
    : prefix + symbol + "  " + operation + ending;
  if (!twoLines) return [headline];

  const category = activityCategory(item);
  const extra = item.error && item.ok === false
    ? " · Error: " + String(item.error).replace(/\s+/g, " ").slice(0, 70)
    : item.detail ? " · " + String(item.detail).replace(/\s+/g, " ").slice(0, 100) : "";
  const secondary = " · " + category + extra;
  // Keep request/response telemetry in transaction state but leave it out of
  // the monitoring view, where it competes with operation and project context.
  const textWidth = Math.max(1, limit - opStart);
  const name = truncateCells(project, textWidth);
  const rest = truncateCells(secondary, Math.max(0, textWidth - terminalCellWidth(name)));
  const metadata = " ".repeat(opStart)
    + (color
      ? tint(name, item.project ? MONITOR.muted : MONITOR.dim, true)
        + tint(rest, item.ok === false ? MONITOR.bad : MONITOR.dim, true)
      : name + rest);
  return [headline, metadata];
}

function monitorCapabilities(state, width, color) {
  const parts = [
    { text: (state.terminal ? "✓" : "×") + " Terminal", color: state.terminal ? MONITOR.good : MONITOR.dim },
    { text: (state.desktop ? "✓" : "×") + " Desktop", color: state.desktop ? MONITOR.good : MONITOR.dim },
    { text: (state.learn === null ? "◌" : state.learn ? "✓" : "×") + " Learn",
      color: state.learn === null ? MONITOR.warning : state.learn ? MONITOR.good : MONITOR.dim },
  ];
  const plain = parts.map((part) => part.text).join("    ");
  if (terminalCellWidth(plain) > width) return tint(truncateCells(plain, width), MONITOR.muted, color);
  return parts.map((part) => tint(part.text, part.color, color)).join("    ");
}

function monitoringSummary(state, width, layout, color) {
  if (layout === "tiny") {
    return [tint(truncateCells((state.agent || "Agent") + " · " + formatUptime(state.uptimeMs), width), MONITOR.muted, color)];
  }
  if (layout === "medium") {
    const line = "Agent  " + String(state.agent || "-") + "    Session  " + formatUptime(state.uptimeMs)
      + "    Reconnects  " + (state.reconnects ?? 0);
    return [
      tint(truncateCells(line, width), MONITOR.bright, color),
      tint(truncateCells("Root  " + String(state.root || "-"), width), MONITOR.muted, color),
      monitorCapabilities(state, width, color),
    ];
  }
  const w1 = Math.floor(width * 0.49);
  const w2 = Math.floor(width * 0.29);
  const w3 = width - w1 - w2;
  const headings = [
    tint(cellPad("AGENT", w1), MONITOR.muted, color),
    tint(cellPad("SESSION", w2), MONITOR.muted, color),
    tint(cellPad("RECONNECTS", w3), MONITOR.muted, color),
  ].join("");
  const stats = [
    tint(cellPad(state.agent || "-", w1), MONITOR.bright, color),
    tint(cellPad(formatUptime(state.uptimeMs), w2), MONITOR.bright, color),
    tint(cellPad(String(state.reconnects ?? 0), w3), state.reconnects > 0 ? MONITOR.warning : MONITOR.bright, color),
  ].join("");
  return [
    headings,
    stats,
    tint(truncateCells("Root  " + String(state.root || "-"), width), MONITOR.muted, color),
    monitorCapabilities(state, width, color),
  ];
}

function headingRow(width, color) {
  const left = cellPad("TIME", 13);
  const op = cellPad("OPERATION", Math.max(1, width - 23));
  const right = cellPad("DURATION", 10);
  return tint(left + op + right, MONITOR.muted, color);
}

function monitorFooter(width, color, online, demo = false) {
  const hint = width >= 65
    ? "↑↓ Scroll  ·  End " + (demo ? "Newest" : "Live") + "  ·  Ctrl+C Exit"
    : "Ctrl+C Exit";
  const status = demo ? "◈ Offline preview" : online ? "● Connected" : "○ Disconnected";
  if (terminalCellWidth(hint) + terminalCellWidth(status) + 3 > width) {
    return tint(truncateCells(hint, width), MONITOR.dim, color);
  }
  return tint(hint, MONITOR.dim, color)
    + " ".repeat(width - terminalCellWidth(hint) - terminalCellWidth(status))
    + tint(status, demo ? MONITOR.accent : online ? MONITOR.accent : MONITOR.warning, color);
}

export class RemoteTui {
  constructor({
    config,
    version,
    output = process.stdout,
    input = process.stdin,
    env = process.env,
    onInterrupt = () => process.emit("SIGINT"),
    demo = false,
  }) {
    this.output = output;
    this.input = input;
    this.onInterrupt = onInterrupt;
    this.startedAt = Date.now();
    this.state = {
      account: config.user?.name || config.user?.login || "signed in",
      agent: config.agentName || config.agentId || "-",
      relay: normalizeRelay(config.relayUrl),
      root: config.allowedRoots || "-",
      status: "starting",
      relayHealth: { state: "checking" },
      reconnects: 0,
      terminal: config.terminalEnabled !== false,
      desktop: config.desktopEnabled === true,
      learn: null,
    };
    this.version = version || "-";
    this.colorEnabled = shouldUseColor(output, env);
    this.demoMode = demo === true;
    this.transactions = [];
    this.timer = null;
    this.closed = false;
    this.renderPending = false;
    this.scrollOffset = 0;
    this.unseenTransactions = 0;
    this.inputWasRaw = false;
    this.inputWasPaused = false;
    this.inputFlowingState = null;
    this.mouseEnabled = false;
    this.onInput = (chunk) => this.handleInput(chunk);
  }

  start() {
    if (this.closed) return;
    // Use the terminal's alternate screen so periodic redraws never accumulate
    // in scrollback. Mouse reporting is enabled only when stdin can actually
    // consume the events, otherwise ordinary terminal scrollback remains usable.
    const interactiveInput = Boolean(this.input?.isTTY && typeof this.input.setRawMode === "function");
    if (interactiveInput) {
      this.inputWasRaw = Boolean(this.input.isRaw);
      this.inputWasPaused = Boolean(this.input.isPaused?.());
      this.inputFlowingState = this.input.readableFlowing ?? null;
      try {
        this.input.setRawMode(true);
        this.input.resume?.();
        this.input.on?.("data", this.onInput);
        this.mouseEnabled = true;
      } catch {
        this.mouseEnabled = false;
      }
    }
    this.output.write(
      ESC + "?1049h"
      + ESC + "?25l"
      + (this.mouseEnabled ? ESC + "?1000h" + ESC + "?1006h" : "")
      + ESC + "2J"
      + ESC + "H",
    );
    this.render();
    this.timer = setInterval(() => this.render(), 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.input?.removeListener?.("data", this.onInput);
    if (this.input?.isTTY && typeof this.input.setRawMode === "function" && !this.inputWasRaw) {
      try { this.input.setRawMode(false); } catch {}
    }
    if (this.inputFlowingState !== true) this.input?.pause?.();
    this.output.write(
      (this.mouseEnabled ? ESC + "?1000l" + ESC + "?1006l" : "")
      + ESC + "?25h"
      + ESC + "?1049l",
    );
    this.mouseEnabled = false;
  }

  viewportMetrics() {
    const columns = Math.max(1, Number(this.output.columns) || 110);
    // Fill the actual terminal width; reserve one cell to avoid line wrapping.
    const width = Math.min(Math.max(1, columns - 1), MAX_TUI_VIEWPORT_WIDTH);
    const height = Math.max(1, Number(this.output.rows) || 30);
    const usableHeight = Math.max(1, height - FRAME_BOTTOM_MARGIN);
    let layout = width >= 88 && usableHeight >= 15 ? "wide"
      : width >= 54 && usableHeight >= 11 ? "medium" : "tiny";
    let topLine = layout === "wide" ? 1 : 0;
    let summaryRows = layout === "wide" ? 4 : layout === "medium" ? 3 : 1;
    let dividerRows = usableHeight >= 6 ? 1 : 0;
    let headingRows = layout === "tiny" ? 0 : 2;
    const footerRows = usableHeight >= 6 ? 1 : 0;
    let fixedRows = 1 + topLine + summaryRows + dividerRows + 1 + headingRows + footerRows;
    if (fixedRows >= usableHeight && layout !== "tiny") {
      layout = "tiny";
      topLine = 0;
      summaryRows = 1;
      headingRows = 0;
      fixedRows = 1 + summaryRows + dividerRows + 1 + footerRows;
    }
    return {
      width, height, layout, usableHeight, topLine, dividerRows, headingRows, footerRows,
      availableRows: Math.max(0, usableHeight - fixedRows),
      twoLines: layout !== "tiny" && height >= 17,
    };
  }

  transactionRows(width, twoLines = this.viewportMetrics().twoLines) {
    return this.transactions.flatMap((item) => activityRows(item, width, { color: this.colorEnabled, twoLines }));
  }

  maxScrollOffset() {
    const { width, twoLines, availableRows } = this.viewportMetrics();
    return Math.max(0, this.transactionRows(width, twoLines).length - availableRows);
  }

  scrollBy(lines) {
    const next = clamp(this.scrollOffset + Number(lines || 0), 0, this.maxScrollOffset());
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    if (this.scrollOffset === 0) this.unseenTransactions = 0;
    this.scheduleRender();
  }

  handleInput(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    if (!data) return;

    // Raw mode turns Ctrl+C into input data, so forward it to the existing
    // shutdown handler instead of swallowing it.
    if (data.includes("\x03")) {
      this.onInterrupt?.();
      return;
    }

    let handledMouse = false;
    const mouse = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
    let match;
    while ((match = mouse.exec(data)) !== null) {
      const button = Number(match[1]);
      if ((button & 64) !== 64) continue;
      this.scrollBy((button & 1) === 0 ? 3 : -3);
      handledMouse = true;
    }
    if (handledMouse) return;

    if (data.includes("\x1b[5~")) return this.scrollBy(this.viewportMetrics().availableRows);
    if (data.includes("\x1b[6~")) return this.scrollBy(-this.viewportMetrics().availableRows);
    if (data.includes("\x1b[H") || data.includes("\x1b[1~")) {
      this.scrollOffset = this.maxScrollOffset();
      return this.scheduleRender();
    }
    if (data.includes("\x1b[F") || data.includes("\x1b[4~")) {
      this.scrollOffset = 0;
      this.unseenTransactions = 0;
      return this.scheduleRender();
    }
    if (data.includes("\x1b[A")) return this.scrollBy(1);
    if (data.includes("\x1b[B")) return this.scrollBy(-1);
  }

  appendTransaction(item) {
    if (this.scrollOffset > 0) {
      const { width, twoLines } = this.viewportMetrics();
      this.scrollOffset += activityRows(item, width, { twoLines }).length;
      this.unseenTransactions += 1;
    }
    this.transactions.push(item);
    if (this.transactions.length > 100) this.transactions.splice(0, this.transactions.length - 100);
  }

  handleMessage(message) {
    if (!message || message.type !== "chat-relay-ui") return;
    if (message.event === "connection") {
      this.state.status = message.state || this.state.status;
      if (Number.isFinite(Number(message.reconnects))) this.state.reconnects = Number(message.reconnects);
    } else if (message.event === "tool:start") {
      this.appendTransaction({
        requestId: message.requestId,
        at: message.at || new Date().toISOString(),
        action: message.action,
        summary: message.summary || humanizeToolCall({ action: message.action }),
        operation: typeof message.operation === "string" ? message.operation : undefined,
        project: typeof message.project === "string" ? message.project : null,
        category: typeof message.category === "string" ? message.category : undefined,
        detail: typeof message.detail === "string" ? message.detail : "",
        status: "running",
        ok: null,
        requestBytes: Number.isFinite(Number(message.requestBytes)) ? Number(message.requestBytes) : undefined,
      });
    } else if (message.event === "tool:end") {
      const item = [...this.transactions].reverse().find((entry) => entry.requestId === message.requestId);
      if (item) {
        item.status = "done";
        item.ok = message.ok !== false;
        item.durationMs = message.durationMs;
        if (Number.isFinite(Number(message.responseBytes))) item.responseBytes = Number(message.responseBytes);
        if (message.error && message.ok === false) item.error = truncate(message.error, 90);
      }
    } else if (message.event === "learn") {
      const activity = message.activity && typeof message.activity === "object" ? message.activity : null;
      if (activity) {
        const tool = String(activity.tool || "learn");
        const change = activity.change && typeof activity.change === "object" ? activity.change : null;
        const scopeSummary = String(activity.scopeSummary || "").trim();
        const kind = String(change?.kind || activity.kind || "memory").trim() || "memory";
        const key = String(change?.key || "").trim();
        const verbs = {
          created: "created",
          updated: "updated",
          reinforced: "reinforced",
          weakened: "weakened",
          removed: "removed",
        };
        let detail;
        if (tool === "learn_prepare") {
          detail = "prepare " + (scopeSummary || "relevant") + " context";
        } else if (tool === "learn_get") {
          detail = "read " + (scopeSummary || "memory") + " context";
        } else if (change) {
          detail = (verbs[String(change.type || "")] || "updated") + " " + kind + (key ? " · " + key : "");
        } else if (tool === "learn_put") {
          detail = "write " + kind + " · no change";
        } else if (tool === "learn_delete") {
          detail = "delete memory · no change";
        } else if (tool === "learn_feedback") {
          detail = String(activity.feedback || "feedback") + " memory · no change";
        } else {
          detail = tool.replace(/^learn_/, "").replace(/_/g, " ");
        }
        const durationMs = Number(activity.durationMs);
        this.appendTransaction({
          requestId: String(activity.eventId || "learn-call-" + Date.now()),
          at: activity.at || message.at || new Date().toISOString(),
          action: tool,
          summary: "🧠 Learn · " + truncate(detail, 120),
          operation: tool === "learn_prepare" ? "Load relevant Learn context"
            : tool === "learn_get" ? "Read Learn memories"
              : tool === "learn_delete" ? "Delete Learn memory" : "Update Learn memory",
          category: "Learn",
          project: typeof activity.projectKey === "string" ? activity.projectKey
            : activity.scope === "project" && typeof activity.scopeKey === "string" ? activity.scopeKey : null,
          status: "done",
          ok: activity.ok !== false,
          ...(Number.isFinite(durationMs) ? { durationMs } : {}),
        });
      } else {
        const change = message.change && typeof message.change === "object" ? message.change : {};
        const marker = {
          created: "+",
          updated: "~",
          reinforced: "^",
          weakened: "v",
          removed: "-",
        }[String(change.type || "")] || "~";
        const detail = String(change.summary || change.key || "Learn updated").replace(/\s+/g, " ").trim();
        this.appendTransaction({
          requestId: "learn-" + String(change.eventId || Date.now()),
          at: change.at || message.at || new Date().toISOString(),
          action: "learn",
          summary: "Learn " + marker + " " + truncate(detail, 120),
          operation: "Update Learn memory",
          category: "Learn",
          project: typeof change.projectKey === "string" ? change.projectKey : null,
          status: "done",
          ok: true,
        });
      }
    } else if (message.event === "system") {
      this.appendTransaction({
        requestId: "system-" + Date.now() + "-" + Math.random(),
        at: message.at || new Date().toISOString(),
        summary: message.message || "Agent event",
        status: "done",
        ok: message.level !== "error",
      });
    }
    this.scheduleRender();
  }

  setRelayHealth(health) {
    if (this.closed) return;
    this.state.relayHealth = {
      ...(health && typeof health === "object" ? health : { state: "unavailable" }),
      checkedAt: Date.now(),
    };
    if (health?.features && Object.prototype.hasOwnProperty.call(health.features, "learn")) {
      this.state.learn = health.features.learn === true;
    } else if (health?.state === "reachable") {
      this.state.learn = false;
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
    const { width, height, layout, usableHeight, topLine, dividerRows,
      headingRows, footerRows, availableRows, twoLines } = this.viewportMetrics();
    const state = { ...this.state, uptimeMs: Date.now() - this.startedAt };
    const online = state.status === "connected" && relayIsOnline(state.relayHealth);
    const health = this.demoMode ? "◈ DEMO" : online ? "● ONLINE" : state.status === "connected" ? "○ OFFLINE" : statusText(state.status);
    const headline = "Chat Relay  v" + this.version + (this.demoMode ? "  · PREVIEW" : "");
    const headlineRoom = width - terminalCellWidth(health) - 2;
    const title = headlineRoom >= 12
      ? tint(truncateCells(headline, headlineRoom), MONITOR.accent, this.colorEnabled)
        + " ".repeat(width - terminalCellWidth(truncateCells(headline, headlineRoom)) - terminalCellWidth(health))
        + tint(health, online ? MONITOR.good : MONITOR.warning, this.colorEnabled)
      : tint(truncateCells(headline, width), MONITOR.accent, this.colorEnabled);
    const divider = tint("─".repeat(width), MONITOR.border, this.colorEnabled);
    const allRows = this.transactionRows(width, twoLines);
    this.scrollOffset = clamp(this.scrollOffset, 0, Math.max(0, allRows.length - availableRows));
    if (this.scrollOffset === 0) this.unseenTransactions = 0;
    const end = Math.max(0, allRows.length - this.scrollOffset);
    const begin = Math.max(0, end - availableRows);
    const visible = allRows.slice(begin, end);
    const badge = this.demoMode ? "◈ SAMPLE" : this.scrollOffset === 0 ? "● LIVE"
      : this.unseenTransactions ? "+" + this.unseenTransactions + " NEW" : "HISTORY";
    const left = "Activity  " + badge;
    const count = this.transactions.length + (this.transactions.length === 1 ? " operation" : " operations");
    const showCount = width >= terminalCellWidth(left) + terminalCellWidth(count) + 3;
    const section = terminalCellWidth(left) > width
      ? tint(truncateCells(left, width), MONITOR.accent, this.colorEnabled)
      : this.colorEnabled
      ? tint("Activity", MONITOR.bright, true) + "  "
        + (this.scrollOffset === 0 ? paint(badge, MONITOR.good, MONITOR.liveBg) : tint(badge, MONITOR.warning, true))
        + (showCount ? " ".repeat(width - terminalCellWidth(left) - terminalCellWidth(count))
          + tint(count, MONITOR.muted, true) : "")
      : left + (showCount ? " ".repeat(width - terminalCellWidth(left) - terminalCellWidth(count)) + count : "");
    const lines = [title];
    if (topLine) lines.push(divider);
    lines.push(...monitoringSummary(state, width, layout, this.colorEnabled));
    if (dividerRows) lines.push(divider);
    lines.push(section);
    if (headingRows) lines.push(headingRow(width, this.colorEnabled), divider);
    if (availableRows > 0 && visible.length === 0) {
      visible.push(tint("  No recent activity", MONITOR.dim, this.colorEnabled));
    }
    lines.push(...visible);
    while (lines.length < usableHeight - footerRows) lines.push("");
    if (footerRows) lines.push(monitorFooter(width, this.colorEnabled, online, this.demoMode));
    const screen = lines.slice(0, Math.max(1, usableHeight)).join("\n");
    if (screen !== this.previousFrame) {
      this.previousFrame = screen;
      this.output.write(ESC + "2J" + ESC + "H" + screen);
    }
  }
}
