import test from "node:test";
import assert from "node:assert/strict";
import { toolErrorGuidance } from "../agent/tool-error-guidance.mjs";
import { validateCommand } from "../agent/terminal-manager.mjs";

test("safe PowerShell formatting cmdlets do not trigger disk format safety rule", () => {
  assert.doesNotThrow(() => validateCommand("Get-CimInstance Win32_Process | Format-List"));
  assert.doesNotThrow(() => validateCommand("Select-String -Path apps/api/src/*.ts -Pattern 'test' | Format-Table -Wrap"));
  for (const command of ["format C:", "FORMAT.COM D: /Q", "diskpart", "Format-Volume -DriveLetter C", "Get-Item .; shutdown /s"]) {
    assert.throws(() => validateCommand(command), /command_blocked/, command);
  }
});

test("blocked process and search commands get safe, actionable alternatives", () => {
  const processAdvice = toolErrorGuidance("terminal.exec", "command_blocked", { command: "Get-CimInstance Win32_Process" });
  assert.equal(processAdvice.suggestedTool, "list_processes");
  assert.equal(processAdvice.retryable, false);
  const searchAdvice = toolErrorGuidance("terminal.exec", "command_blocked", { command: "Select-String -Path src/*.ts" });
  assert.equal(searchAdvice.suggestedTool, "start_search");
  const other = toolErrorGuidance("terminal.exec", "command_blocked", { command: "diskpart" });
  assert.equal(other.suggestedTool, "get_config");
  assert.match(other.suggestedAction, /do not retry/i);
});

test("filesystem restriction and stale edits preserve error codes and do not suggest bypass", () => {
  const denied = toolErrorGuidance("fs.list", "path_not_allowed", { path: "C:/Secret" });
  assert.equal(denied.suggestedTool, "get_config");
  assert.match(denied.suggestedAction, /authorized root/);
  assert.equal(denied.retryable, false);
  const stale = toolErrorGuidance("fs.edit", "replacement_count_mismatch:0");
  assert.equal(stale.errorCode, "replacement_count_mismatch");
  assert.equal(stale.suggestedTool, "read_file");
  assert.deepEqual(toolErrorGuidance("fs.read", "ENOENT"), {});
});
