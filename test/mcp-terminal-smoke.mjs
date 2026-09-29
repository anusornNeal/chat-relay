const base = "http://127.0.0.1:8794/mcp?key=test-caller";

async function rpc(id, method, params = {}) {
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  const line = text.split(/\r?\n/).find((value) => value.startsWith("data: "));
  if (!line) throw new Error(`missing MCP data: ${text}`);
  return JSON.parse(line.slice(6));
}

async function tool(id, name, args = {}) {
  const result = await rpc(id, "tools/call", { name, arguments: args });
  if (result.result?.isError) throw new Error(result.result.content?.[0]?.text ?? name);
  const relay = JSON.parse(result.result.content[0].text);
  return relay.payload;
}

const listed = await rpc(1, "tools/list");
const names = listed.result.tools.map((item) => item.name);
console.log("tools", names.join(", "));

const execResult = await tool(2, "terminal_exec", { command: "Get-Location" });
if (!execResult.ok || !execResult.stdout.includes("chat-relay")) {
  throw new Error(`terminal_exec failed: ${JSON.stringify(execResult)}`);
}
console.log("exec ok");

const started = await tool(3, "terminal_start", {
  command: "1..3 | ForEach-Object { Write-Output ('tick ' + $_); Start-Sleep -Milliseconds 150 }",
});
await new Promise((resolve) => setTimeout(resolve, 700));
const output = await tool(4, "terminal_read", { sessionId: started.sessionId, afterSeq: 0 });
const joined = output.chunks.map((chunk) => chunk.text).join("");
if (!joined.includes("tick 1") || !joined.includes("tick 3")) {
  throw new Error(`terminal_start/read failed: ${JSON.stringify(output)}`);
}
console.log("long-running session ok");

const shell = await tool(5, "terminal_start_shell");
await new Promise((resolve) => setTimeout(resolve, 300));
await tool(6, "terminal_write", {
  sessionId: shell.sessionId,
  input: "Write-Output shell-ok",
});
await new Promise((resolve) => setTimeout(resolve, 500));
const shellOutput = await tool(7, "terminal_read", { sessionId: shell.sessionId, afterSeq: 0 });
const shellText = shellOutput.chunks.map((chunk) => chunk.text).join("");
if (!shellText.includes("shell-ok")) {
  throw new Error(`interactive shell failed: ${JSON.stringify(shellOutput)}`);
}
console.log("interactive shell ok");

const sessions = await tool(8, "terminal_list");
if (!Array.isArray(sessions) || sessions.length < 2) {
  throw new Error(`terminal_list failed: ${JSON.stringify(sessions)}`);
}
console.log("list ok");

await tool(9, "terminal_kill", { sessionId: shell.sessionId });
console.log("kill ok");
console.log("terminal MCP smoke test passed");
