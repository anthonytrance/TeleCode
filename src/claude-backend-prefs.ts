import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { bridgeLog } from "./bridge-log.js";
import type { TelegramContextKey } from "./context-key.js";
import { parseJsonFileText } from "./json.js";

export type ClaudeBackendChoice = "pty" | "sdk";

interface ClaudeBackendPrefsState {
  version: 1;
  backends: Record<string, ClaudeBackendChoice>;
}

export function claudeBackendPrefsPath(workspace: string): string {
  return path.join(workspace, ".telecodex", "provider-state", "claude-backend.json");
}

/** Per-Telegram-context Claude engine choice; survives restarts (no-BOM JSON). */
export class ClaudeBackendPrefs {
  private backends: Map<TelegramContextKey, ClaudeBackendChoice>;

  constructor(private readonly filePath: string) {
    this.backends = this.load();
  }

  get(contextKey: TelegramContextKey): ClaudeBackendChoice | undefined {
    return this.backends.get(contextKey);
  }

  set(contextKey: TelegramContextKey, backend: ClaudeBackendChoice): void {
    this.backends.set(contextKey, backend);
    this.save();
  }

  private load(): Map<TelegramContextKey, ClaudeBackendChoice> {
    if (!existsSync(this.filePath)) {
      return new Map();
    }
    try {
      const parsed = parseJsonFileText<ClaudeBackendPrefsState>(readFileSync(this.filePath, "utf8"));
      if (parsed.version !== 1) {
        return new Map();
      }
      const entries = Object.entries(parsed.backends ?? {}).filter(
        (entry): entry is [string, ClaudeBackendChoice] => entry[1] === "pty" || entry[1] === "sdk",
      );
      return new Map(entries as Array<[TelegramContextKey, ClaudeBackendChoice]>);
    } catch (error) {
      bridgeLog("backend", `prefs load failed: ${String(error)}`);
      return new Map();
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const state: ClaudeBackendPrefsState = {
      version: 1,
      backends: Object.fromEntries(this.backends),
    };
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
