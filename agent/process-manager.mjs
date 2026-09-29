import { execFile } from "node:child_process";
import os from "node:os";

function execPowerShell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { timeout, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class ProcessManager {
  async list(filter = "") {
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

  async kill(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 100 || value === process.pid) {
      throw new Error("invalid_or_protected_pid");
    }
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
