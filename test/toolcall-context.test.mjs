import assert from "node:assert/strict";
import test from "node:test";
import { describeToolActivity, resolveToolProject } from "../agent/toolcall-context.mjs";

const roots = ["C:\\Users\\tatar\\Projects"];

test("uses exact project folder for filesystem and terminal tools", () => {
  const file = "C:\\Users\\tatar\\Projects\\flowly\\apps\\web\\src\\SkillAdmin.tsx";
  assert.equal(resolveToolProject({ action: "fs.write", path: file }, roots), "flowly");
  assert.equal(resolveToolProject({ action: "terminal.exec", cwd: "C:\\Users\\tatar\\Projects\\chat-relay", command: "git status" }, roots), "chat-relay");
  assert.deepEqual(describeToolActivity({ action: "fs.write", path: file, mode: "rewrite" }, roots), {
    project: "flowly", category: "Filesystem", operation: "Write SkillAdmin.tsx", detail: "apps/web/src/SkillAdmin.tsx",
  });
});

test("supports relative paths with a supplied cwd, workspace roots and POSIX", () => {
  assert.equal(resolveToolProject({
    action: "fs.read", path: "src/App.tsx", cwd: "C:\\Users\\tatar\\Projects\\flowly",
  }, roots), "flowly");
  assert.equal(resolveToolProject({
    action: "fs.list", path: "/home/ci/Projects/chat-relay",
  }, ["/home/ci/Projects"]), "chat-relay");
  assert.equal(resolveToolProject({
    action: "fs.read", path: "/home/ci/Projects/chat-relay/cli/tui.mjs",
  }, ["/home/ci/Projects"]), "chat-relay");
  assert.equal(resolveToolProject({
    action: "fs.read", path: "/opt/chat-relay/cli/tui.mjs",
  }, ["/opt/chat-relay"]), "chat-relay");
});

test("never labels ambiguous or unrelated activities as a project", () => {
  assert.equal(resolveToolProject({ action: "ping" }, roots), null);
  assert.equal(resolveToolProject({ action: "terminal.exec", cwd: "C:\\Users\\tatar\\Projects", command: "git status" }, roots), null);
  assert.equal(resolveToolProject({ action: "fs.read", path: "C:\\Users\\tatar\\Projects\\readme.md" }, roots), null);
  assert.equal(resolveToolProject({ action: "fs.read", path: "C:\\Other\\project\\secret.js" }, roots), null);
  assert.equal(resolveToolProject({ action: "fs.read", path: "src/App.tsx" }, roots), null);
  assert.equal(resolveToolProject({ action: "fs.stat", projectKey: "../unsafe", path: "C:\\Other\\x" }, roots), null);
});

test("reports mixed projects accurately for cross-project filesystem and terminal batches", () => {
  assert.equal(resolveToolProject({ action: "fs.batch", operations: [
    { op: "read", path: "C:\\Users\\tatar\\Projects\\flowly\\apps\\web\\src\\App.tsx" },
    { op: "read", path: "C:\\Users\\tatar\\Projects\\chat-relay\\cli\\tui.mjs" },
  ] }, roots), "Multiple projects");
  assert.equal(resolveToolProject({ action: "terminal.batch.start", jobs: [
    { command: "git status", cwd: "C:\\Users\\tatar\\Projects\\flowly" },
    { command: "git status", cwd: "C:\\Users\\tatar\\Projects\\chat-relay" },
  ] }, roots), "Multiple projects");
  assert.equal(resolveToolProject({ action: "terminal.batch.start", jobs: [
    { command: "git status", cwd: "C:\\Users\\tatar\\Projects\\flowly" },
    { command: "git log", cwd: "C:\\Users\\tatar\\Projects\\flowly" },
  ] }, roots), "flowly");
});

test("uses bounded local batch/session correlation without network calls", () => {
  const ctx = new Map([["test-batch", "flowly"], ["test-session", "chat-relay"]]);
  assert.equal(resolveToolProject({ action: "terminal.batch.read", batchId: "test-batch" }, roots, ctx), "flowly");
  assert.equal(resolveToolProject({ action: "terminal.read", sessionId: "test-session" }, roots, ctx), "chat-relay");
  assert.equal(resolveToolProject({ action: "terminal.batch.status", batchId: "unknown" }, roots, ctx), null);
  assert.equal(resolveToolProject({ action: "desktop.screenshot", projectKey: "Buddy2" }, roots), "Buddy2");
});

test("humanizes raw commands without dumping shell syntax or secrets in UI headline", () => {
  const long = "Write-Output ('RG=' + (Get-Command rg -ErrorAction SilentlyContinue | Select-Object -First 1))";
  const context = describeToolActivity({ action: "terminal.exec", cwd: "C:\\Users\\tatar\\Projects\\flowly", command: long }, roots);
  assert.equal(context.operation, "Check ripgrep availability");
  assert.equal(context.project, "flowly");
  const generic = describeToolActivity({
    action: "terminal.exec",
    cwd: "C:\\Users\\tatar\\Projects\\chat-relay",
    command: "curl --header 'Authorization: Bearer SUPERSECRET' https://api.example.test",
  }, roots);
  assert.equal(generic.operation, "Execute terminal command");
  assert.ok(!JSON.stringify(generic).includes("SUPERSECRET"));
  assert.equal(describeToolActivity({ action: "terminal.batch.start", jobs: [{}, {}, {}] }, roots).operation, "Run 3 terminal tasks");
  assert.equal(describeToolActivity({ action: "terminal.batch.read", batchId: "abcdef123" }, roots).operation, "Review terminal batch results");
  assert.equal(describeToolActivity({ action: "fs.batch", operations: Array(8).fill({ op: "stat" }) }, roots).operation, "Inspect 8 filesystem items");
});

test("missing or invalid payloads are treated as General, not as crashes", () => {
  assert.equal(resolveToolProject(null, roots), null);
  assert.equal(resolveToolProject(undefined, roots), null);
  assert.equal(describeToolActivity(null, roots).project, null);
  assert.equal(describeToolActivity(null, roots).category, "Agent");
});

test("recognizes common test, Git, and source inspection commands", () => {
  const projectCwd = "C:\\Users\\tatar\\Projects\\flowly";
  const actual = (command) => describeToolActivity({ action: "terminal.exec", command, cwd: projectCwd }, roots).operation;
  assert.equal(actual("npm run test:tui; git diff --check"), "Run terminal UI tests");
  assert.equal(actual("npm run test:hardening"), "Run hardening tests");
  assert.equal(actual("npm run verify:publish"), "Verify release package");
  assert.equal(actual("node --test test/cli-tui.test.mjs"), "Run unit tests");
  assert.equal(actual("Get-ChildItem -Force -Name"), "Inspect project files");
  assert.equal(actual("git push origin main"), "Push main to origin");
});
