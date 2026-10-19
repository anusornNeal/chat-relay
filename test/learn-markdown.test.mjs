import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderLearnMarkdown } from "../dashboard/learn-markdown.js";

const md = `# Instructions

Apply **this rule** and *that note* with \`inline_code\`.

- Preserve translated strings
- Do not populate #comment

1. Review translation
2. Commit changes

> Keep existing notes.

\`\`\`json
{"key": "<script>alert(1)</script>"}
\`\`\`

Visit [the docs](https://example.com/a?b=1&c=2).`;
const html = renderLearnMarkdown(md);
assert.match(html, /<h2>Instructions<\/h2>/);
assert.match(html, /<strong>this rule<\/strong>/);
assert.match(html, /<em>that note<\/em>/);
assert.match(html, /<code>inline_code<\/code>/);
assert.match(html, /<ul><li>Preserve translated strings<\/li><li>Do not populate #comment<\/li><\/ul>/);
assert.match(html, /<ol><li>Review translation<\/li><li>Commit changes<\/li><\/ol>/);
assert.match(html, /<blockquote><p>Keep existing notes\.<\/p><\/blockquote>/);
assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.doesNotMatch(html, /<script>/);
assert.match(html, /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
assert.match(html, /rel="noopener noreferrer nofollow"/);

const attack = '<img src=x onerror=alert(1)> **danger** [run](javascript:alert(1)) ' +
  '[safe](https://example.com/"onmouseover="alert(1))';
const secured = renderLearnMarkdown(attack);
assert.doesNotMatch(secured, /<img\b|<script\b|href="javascript:|<a[^>]+onmouseover=/);
assert.match(secured, /&lt;img/);
assert.match(secured, /<strong>danger<\/strong>/);

const oldMemory = "Buddy2 Android localization workflow: When appending translation rows, " +
  "do not fill the #comment column with ticket numbers. Keep #comment empty unless asked. " +
  "Preserve existing comments and other unrelated rows. Record repeated corrections promptly.";
const oldHtml = renderLearnMarkdown(oldMemory);
assert.match(oldHtml, /<p class="learn-memory-lead"><strong>Buddy2 Android localization workflow<\/strong><\/p>/);
assert.match(oldHtml, /<ul><li>When appending translation rows/);
assert.equal((oldHtml.match(/<li>/g) || []).length, 4);
assert.match(oldHtml, /#comment/);

const plain = renderLearnMarkdown("Do not replace existing text.");
assert.equal(plain, "<p>Do not replace existing text.</p>");
assert.equal(renderLearnMarkdown(""), "");
assert.match(renderLearnMarkdown("~~~js\nconst payload = '<svg>'"), /&lt;svg&gt;/);
assert.match(renderLearnMarkdown("## Heading\n\n- First\n- Second"), /<h3>Heading<\/h3><ul>/);

// Dashboard renders the safe output and scrolls the detail independently of its footer.
const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../dashboard/styles.css", import.meta.url), "utf8");
assert.match(app, /import \{ renderLearnMarkdown \} from "\.\/learn-markdown\.js"/);
assert.match(app, /renderLearnMarkdown\(selected\.content\)/);
assert.match(app, /learn-detail-scroll/);
assert.match(css, /\.learn-detail-scroll\{[^}]*overflow-y:auto/);
assert.match(css, /\.learn-folder-workspace\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
console.log("PASS safe Learn Markdown, legacy prose readability, detail scrolling and split layout");
