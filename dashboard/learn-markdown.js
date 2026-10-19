// Render a safe, bounded Markdown subset for Learn memories without runtime dependencies.
// User-controlled source is always escaped; raw HTML and unsupported links remain text.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function renderInline(value) {
  const tokens = [];
  const reserve = (html) => "\uE000" + (tokens.push(html) - 1) + "\uE001";
  let text = String(value).replace(/[\uE000\uE001]/g, "");
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    reserve("<code>" + escapeHtml(code) + "</code>"));
  text = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s<>"')]+)\)/gi, (original, label, href) => {
    try {
      const target = new URL(href);
      if (target.protocol !== "https:" && target.protocol !== "http:") return original;
      return reserve('<a href="' + escapeHtml(target.href) +
        '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(label) + "</a>");
    } catch {
      return original;
    }
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;!?])/g, "$1<em>$2</em>");
  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || "");
}

function renderLegacyMemory(source) {
  if (source.length < 180 || source.includes("\n") ||
    /(?:\*\*|`|\[.+\]\(https?:\/\/)/.test(source)) return null;
  // Older notes were stored as one paragraph. Separate sentences only for display.
  const title = source.match(/^([^:\n]{8,95}):\s+(.+)$/s);
  const body = title ? title[2] : source;
  const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z0-9])/u).filter(Boolean);
  if (sentences.length < 3) return null;
  if (title) {
    return '<p class="learn-memory-lead"><strong>' + renderInline(title[1]) +
      '</strong></p><ul>' + sentences.map((sentence) =>
        "<li>" + renderInline(sentence) + "</li>").join("") + "</ul>";
  }
  return sentences.map((sentence) => "<p>" + renderInline(sentence) + "</p>").join("");
}

const heading = (line) => /^ {0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
const listItem = (line) => /^ {0,3}([-+*]|\d{1,3}[.)])\s+(.+)$/.exec(line);
const fenceStart = (line) => /^ {0,3}(`{3,}|~{3,})([a-z\d_-]*)\s*$/i.exec(line);
const isBlock = (line) => Boolean(
  heading(line) || listItem(line) || fenceStart(line) ||
  /^ {0,3}>\s?/.test(line) || /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line));

export function renderLearnMarkdown(value) {
  const source = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  const legacy = renderLegacyMemory(source);
  if (legacy) return legacy;

  const lines = source.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = fenceStart(line);
    if (fence) {
      const start = fence[1];
      const code = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === start[0] && close[1].length >= start.length) { i++; break; }
        code.push(lines[i++]);
      }
      blocks.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
      continue;
    }

    const title = heading(line);
    if (title) {
      const level = title[1].length + 1; // h2-h5; the memory title above remains h3.
      blocks.push("<h" + level + ">" + renderInline(title[2]) + "</h" + level + ">");
      i++;
      continue;
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }
    const item = listItem(line);
    if (item) {
      const kind = /^\d/.test(item[1]) ? "ol" : "ul";
      const entries = [];
      while (i < lines.length) {
        const next = listItem(lines[i]);
        if (!next || (/^\d/.test(next[1]) ? "ol" : "ul") !== kind) break;
        entries.push("<li>" + renderInline(next[2]) + "</li>");
        i++;
      }
      blocks.push("<" + kind + ">" + entries.join("") + "</" + kind + ">");
      continue;
    }
    if (/^ {0,3}>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^ {0,3}>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^ {0,3}>\s?/, ""));
      }
      blocks.push("<blockquote><p>" + renderInline(quote.join(" ")) + "</p></blockquote>");
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) {
      paragraph.push(lines[i++].trim());
    }
    if (paragraph.length) blocks.push("<p>" + renderInline(paragraph.join(" ")) + "</p>");
  }
  return blocks.join("");
}
