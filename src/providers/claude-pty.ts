import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import * as pty from "node-pty";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r/g;
const BUFFER_LIMIT = 256 * 1024;

export interface ClaudePtySpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Isolated CLAUDE_CONFIG_DIR so the child does not load the user-scoped telegram plugin. */
  configDir?: string;
  cols?: number;
  rows?: number;
}

export class ClaudePty extends EventEmitter {
  private proc: pty.IPty | null = null;
  private rawBuffer = "";
  private exited = false;

  spawn(options: ClaudePtySpawnOptions): void {
    if (this.proc) {
      throw new Error("Claude PTY is already spawned");
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (options.configDir) {
      env.CLAUDE_CONFIG_DIR = options.configDir;
    }

    this.proc = pty.spawn(options.bin, options.args, {
      cwd: options.cwd,
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      env,
      name: process.platform === "win32" ? "xterm-256color" : "xterm-color",
    });

    this.proc.onData((data) => {
      this.rawBuffer += data;
      if (this.rawBuffer.length > BUFFER_LIMIT) {
        this.rawBuffer = this.rawBuffer.slice(-BUFFER_LIMIT);
      }
    });

    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.emit("exit", exitCode);
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isAlive(): boolean {
    return Boolean(this.proc && !this.exited);
  }

  strippedText(): string {
    return this.rawBuffer.replace(ANSI_PATTERN, "");
  }

  async waitForMarker(patterns: RegExp[], timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const compact = this.strippedText().replace(/\s+/g, "").toLowerCase();
      for (const pattern of patterns) {
        if (pattern.test(compact)) {
          return pattern.source;
        }
      }
      await sleep(250);
    }
    return null;
  }

  typeText(text: string): void {
    this.requireProc().write(text);
  }

  pressEnter(): void {
    this.requireProc().write("\r");
  }

  pressEscape(): void {
    this.requireProc().write("\x1b");
  }

  async sendPrompt(text: string): Promise<void> {
    this.requireProc().write(`\x1b[200~${text}\x1b[201~`);
    await sleep(400);
    this.pressEnter();
  }

  async sendCommand(command: string): Promise<void> {
    this.requireProc().write(command);
    await sleep(150);
    this.pressEnter();
  }

  async dispose(graceful: boolean): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      return;
    }

    if (graceful && !this.exited) {
      try {
        proc.write("/exit");
        await sleep(150);
        proc.write("\r");
        if (await this.waitForExit(10000)) {
          this.proc = null;
          return;
        }
      } catch {
        // Fall through to kill.
      }
    }

    try {
      proc.kill();
    } catch {
      // Fall through to taskkill.
    }

    if (proc.pid && process.platform === "win32" && !(await this.waitForExit(1500))) {
      await taskkill(proc.pid);
    }
    this.proc = null;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) {
      return true;
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("exit", onExit);
    });
  }

  private requireProc(): pty.IPty {
    if (!this.proc || this.exited) {
      throw new Error("Claude PTY is not running");
    }
    return this.proc;
  }
}

export const CLAUDE_TRUST_MARKERS = [/trustthisfolder/];
export const CLAUDE_READY_MARKERS = [/shift\+tab/, /bypasspermissions/, /\?forshortcuts/];

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
