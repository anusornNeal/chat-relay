// A bounded intent hint for explicit Learn preparation. Never run on ordinary MCP calls.
export type LearnPhase = "general" | "read" | "plan" | "implement" | "review" | "test";

const PHASE_SIGNALS: ReadonlyArray<[LearnPhase, RegExp]> = [
  ["implement", /\b(?:implement(?:ation)?|coding|code|refactor(?:ing)?|develop(?:ment)?|patch|fix\s+bug|write\s+code)\b|(?:ลงมือ(?:ทำ|แก้)|เขียน(?:โค้ด|โค๊ด|โปรแกรม)|แก้(?:โค้ด|บั๊ก|บัก)|รีแฟกเตอร์|รีแฟคเตอร์|พัฒนา(?:ระบบ|ฟีเจอร์)|ลงโค้ด)/i],
  ["test", /\b(?:test(?:ing)?|unit\s+tests?|regression|e2e|qa|verify|benchmark)\b|(?:ทดสอบ|เทส|รันเทส|รันทดสอบ|ตรวจสอบผล)/i],
  ["review", /\b(?:code\s+review|review\s+(?:code|implementation|pr)|inspect\s+code|audit\s+code|read\s+code)\b|(?:รีวิว(?:โค้ด|โค๊ด)|ตรวจ(?:สอบ)?โค้ด|ตรวจ(?:สอบ)?ซอร์ส|อ่านโค้ด)/i],
  ["plan", /\b(?:plan(?:ning)?|design\s+architecture|architectural\s+design)\b|(?:วางแผน|ออกแบบสถาปัตยกรรม|วางโครงสร้าง)/i],
  ["read", /\b(?:read|summari[sz]e|ticket|jira|requirements|review\s+(?:card|ticket|issue))\b|(?:อ่าน|สรุป|เปิดการ์ด|ดูการ์ด|ตรวจสอบการ์ด)/i],
];

export function resolveLearnPhase(explicit: LearnPhase | undefined, query: unknown, toolHint?: string): LearnPhase {
  if (explicit && ["general", "read", "plan", "implement", "review", "test"].includes(explicit)) return explicit;
  const goal = String(query ?? "").slice(0, 1200);
  for (const [phase, pattern] of PHASE_SIGNALS) if (pattern.test(goal)) return phase;
  const tool = String(toolHint ?? "").slice(0, 80);
  if (/\b(?:edit|write|patch|code|build)\b/i.test(tool) || /(?:edit_block|write_file)/i.test(tool)) return "implement";
  if (/(?:test|verify)/i.test(tool)) return "test";
  return "general";
}
