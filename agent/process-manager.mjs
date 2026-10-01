import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

function execCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15000,
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 256 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim()));
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

function execPowerShell(script, timeout = 15000) {
  return execCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout },
  );
}

function parsePosixProcesses(stdout, filter = "") {
  const query = String(filter || "").toLowerCase();
  const items = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const processId = Number(match[1]);
    const parentProcessId = Number(match[2]);
    const commandLine = match[3].trim();
    if (!commandLine) continue;
    const executablePath = commandLine.split(/\s+/)[0] || "";
    const name = path.basename(executablePath) || executablePath;
    if (query && !name.toLowerCase().includes(query) && !commandLine.toLowerCase().includes(query)) continue;
    items.push({
      ProcessId: processId,
      ParentProcessId: parentProcessId,
      Name: name,
      CommandLine: commandLine,
      ExecutablePath: executablePath,
    });
  }
  return items;
}

export class ProcessManager {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
  }

  async list(filter = "") {
    if (this.platform === "win32") {
      const escaped = String(filter).replace(/'/g, "''");
      const where = escaped
        ? ` | Where-Object { $_.Name -like '*${escaped}*' -or $_.CommandLine -like '*${escaped}*' }`
        : "";
      const script =
        "$items = Get-CimInstance Win32_Process" + where +
        " | Select-Object ProcessId,Name,CommandLine,ExecutablePath;" +
        "$items | ConvertTo-Json -Compress -Depth 3";
      const stdout = await execPowerShell(script);
      if (!stdout.trim()) return [];
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    }

    if (this.platform === "darwin" || this.platform === "linux") {
      const stdout = await execCommand("/bin/ps", ["-axo", "pid=,ppid=,command="]);
      return parsePosixProcesses(stdout, filter);
    }

    throw new Error("unsupported_platform");
  }

  async kill(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 100 || value === process.pid) {
      throw new Error("invalid_or_protected_pid");
    }

    if (this.platform === "win32") {
      return new Promise((resolve, reject) => {
        execFile("taskkill.exe", ["/PID", String(value), "/T", "/F"], { windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }
          resolve({ ok: true, pid: value, output: stdout.trim() });
        });
      });
    }

    if (this.platform === "darwin" || this.platform === "linux") {
      const processes = await this.list();
      const children = new Map();
      for (const item of processes) {
        const parent = Number(item.ParentProcessId);
        const child = Number(item.ProcessId);
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(child);
      }
      const ordered = [];
      const visit = (parent) => {
        for (const child of children.get(parent) || []) {
          visit(child);
          ordered.push(child);
        }
      };
      visit(value);
      ordered.push(value);
      for (const target of ordered) {
        try { process.kill(target, "SIGKILL"); } catch (error) {
          if (target === value && error?.code !== "ESRCH") throw error;
        }
      }
      return { ok: true, pid: value, output: "" };
    }

    throw new Error("unsupported_platform");
  }

  info(extra = {}) {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      hostname: os.hostname(),
      username: os.userInfo().username,
      homeDir: os.homedir(),
      cwd: process.cwd(),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      ...extra,
    };
  }
}

export { parsePosixProcesses };
