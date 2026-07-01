import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ClaudePermissionMode } from "../config.js";
import type { TelegramContextKey } from "../context-key.js";
import { parseJsonFileText } from "../json.js";

export interface ClaudeSessionStateRecord {
  telegramContextKey: TelegramContextKey;
  sessionId: string;
  transcriptPath?: string;
  workspace: string;
  displayName?: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  createdAt: number;
  lastUsedAt: number;
}

export interface ClaudeProviderState {
  version: 1;
  sessions: ClaudeSessionStateRecord[];
}

export function claudeProviderStatePath(workspace: string): string {
  return path.join(workspace, ".telecodex", "provider-state", "claude.json");
}

export class ClaudeStateStore {
  constructor(private readonly filePath: string) {}

  load(): ClaudeProviderState {
    if (!existsSync(this.filePath)) {
      return { version: 1, sessions: [] };
    }

    const parsed = parseJsonFileText<ClaudeProviderState>(readFileSync(this.filePath, "utf8"));
    if (parsed.version !== 1) {
      throw new Error(`Unsupported Claude provider state version: ${parsed.version}`);
    }
    return {
      version: 1,
      sessions: parsed.sessions ?? [],
    };
  }

  save(state: ClaudeProviderState): void {
    if (state.version !== 1) {
      throw new Error(`Unsupported Claude provider state version: ${state.version}`);
    }
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}

export class ClaudeSessionStateIndex {
  private state: ClaudeProviderState;

  constructor(private readonly store: ClaudeStateStore) {
    this.state = store.load();
  }

  get(contextKey: TelegramContextKey): ClaudeSessionStateRecord | undefined {
    return this.state.sessions.find((session) => session.telegramContextKey === contextKey);
  }

  upsert(record: ClaudeSessionStateRecord): void {
    const index = this.state.sessions.findIndex(
      (session) => session.telegramContextKey === record.telegramContextKey,
    );
    if (index === -1) {
      this.state.sessions.push(record);
    } else {
      this.state.sessions[index] = record;
    }
    this.store.save(this.state);
  }

  remove(contextKey: TelegramContextKey): void {
    const nextSessions = this.state.sessions.filter((session) => session.telegramContextKey !== contextKey);
    if (nextSessions.length === this.state.sessions.length) {
      return;
    }
    this.state = { version: 1, sessions: nextSessions };
    this.store.save(this.state);
  }
}
