import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents: 'export { buildLearnRelevanceContext, selectRelevantLearnRecords } from "./src/learning-relevance";',
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [{
    name: "host",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "host", namespace: "host" }));
      b.onLoad({ filter: /.*/, namespace: "host" }, () => ({
        contents: "export class DurableObject {}",
      }));
    },
  }],
});
const { buildLearnRelevanceContext, selectRelevantLearnRecords } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64")
);
const now = new Date().toISOString();
const mem = (id, key, content) => ({
  id, key, content, kind: "problem_solving", scope: "project", scopeKey: "buddy2",
  confidence: 90, positiveFeedback: 0, negativeFeedback: 0, createdAt: now, updatedAt: now,
});
const memories = [
  mem("gallery", "image-gallery", "แก้ปัญหารูปภาพไม่แสดงในแกลเลอรีและซิงก์รูปภาพ"),
  mem("skeleton", "skeleton-load", "ปิดการเลื่อนหน้ารายการขณะโหลด skeleton"),
  mem("network", "network-trace", "ตรวจสอบการเชื่อมต่อ API timeout"),
];
const cases = [
  ["รูปภาพไม่แสดง", "gallery"],
  ["skeleton หน้ารายการเลื่อนได้", "skeleton"],
  ["ตรวจสอบ API timeout", "network"],
  ["แก้ปัญหารูปภาพไม่แสดงในแกลเลอรี", "gallery"],
];
for (const [query, best] of cases) {
  const ctx = buildLearnRelevanceContext("learn_prepare", {}, "buddy2", null, query);
  const ranked = selectRelevantLearnRecords(memories, ctx, 3);
  assert.equal(ranked[0].id, best, "best relevant memory for query: " + query);
  assert.deepEqual(selectRelevantLearnRecords(memories, ctx, 3).map((x) => x.id),
    ranked.map((x) => x.id), "ranking must be deterministic");
}
console.log("PASS Thai/English mixed Learn relevance fixtures (4 cases)");
