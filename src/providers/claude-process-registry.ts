import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { parseJsonFileText } from "../json.js";

const execFileAsync = promisify(execFile);

export interface ClaudeProcessRecord {
  pid: number;
  sessionId: string;
  providerSessionId: string;
  startedAt: number;
}

interface ClaudeProcessState {
  version: 1;
  processes: ClaudeProcessRecord[];
}

interface ProcessInfo {
  name: string;
  commandLine: string;
}

export function claudeProcessRegistryPath(workspace: string): string {
  return path.join(workspace, ".telecodex", "provider-state", "claude-pids.json");
}

export class ClaudeProcessRegistry {
  constructor(private readonly filePath: string) {}

  list(): ClaudeProcessRecord[] {
    return this.load().processes;
  }

  upsert(record: ClaudeProcessRecord): void {
    const state = this.load();
    const processes = state.processes.filter(
      (entry) => entry.pid !== record.pid && entry.sessionId !== record.sessionId,
    );
    processes.push(record);
    this.save({ version: 1, processes });
  }

  removePid(pid: number): void {
    const state = this.load();
    const processes = state.processes.filter((entry) => entry.pid !== pid);
    if (processes.length !== state.processes.length) {
      this.save({ version: 1, processes });
    }
  }

  removeSession(sessionId: string): void {
    const state = this.load();
    const processes = state.processes.filter((entry) => entry.sessionId !== sessionId);
    if (processes.length !== state.processes.length) {
      this.save({ version: 1, processes });
    }
  }

  private load(): ClaudeProcessState {
    if (!existsSync(this.filePath)) {
      return { version: 1, processes: [] };
    }
    try {
      const parsed = parseJsonFileText<ClaudeProcessState>(readFileSync(this.filePath, "utf8"));
      if (parsed.version !== 1) {
        return { version: 1, processes: [] };
      }
      return {
        version: 1,
        processes: (parsed.processes ?? []).filter(isClaudeProcessRecord),
      };
    } catch {
      return { version: 1, processes: [] };
    }
  }

  private save(state: ClaudeProcessState): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}

export async function cleanupRegisteredClaudeProcesses(workspace: string): Promise<number> {
  const registry = new ClaudeProcessRegistry(claudeProcessRegistryPath(workspace));
  let killed = 0;
  for (const record of registry.list()) {
    try {
      const processInfo = await readProcessInfo(record.pid);
      if (processInfo && isRegisteredClaudeProcess(record, processInfo)) {
        await taskkillTree(record.pid);
        killed += 1;
      }
    } finally {
      try {
        registry.removePid(record.pid);
      } catch (error) {
        console.warn("Failed to remove stale TeleCodex Claude process record", error);
      }
    }
  }
  return killed;
}

export function isRegisteredClaudeProcess(record: ClaudeProcessRecord, processInfo: ProcessInfo): boolean {
  const name = processInfo.name.toLowerCase();
  const commandLine = processInfo.commandLine.toLowerCase();
  if (!name.includes("claude") && !commandLine.includes("claude")) {
    return false;
  }
  return commandLine.includes(record.providerSessionId.toLowerCase());
}

async function readProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (process.platform !== "win32") {
    return undefined;
  }

  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
    "if ($p) {",
    "  [Console]::WriteLine($p.Name)",
    "  [Console]::Write($p.CommandLine)",
    "}",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
    });
    const lines = stdout.split(/\r?\n/);
    const name = (lines.shift() ?? "").trim();
    if (!name) {
      return undefined;
    }
    return { name, commandLine: lines.join("\n").trim() };
  } catch {
    return undefined;
  }
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
      resolve();
    });
    child.on("error", () => resolve());
  });
}

function isClaudeProcessRecord(value: unknown): value is ClaudeProcessRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<ClaudeProcessRecord>;
  const pid = record.pid;
  return typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.providerSessionId === "string" &&
    record.providerSessionId.length > 0 &&
    Number.isFinite(record.startedAt);
}
