import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TelegramContextKey } from "./context-key.js";
import { parseJsonFileText } from "./json.js";

export type ClaudeQueuedPromptKind = "prompt" | "steer";

export interface ClaudePromptQueueEntry {
  id: string;
  contextKey: TelegramContextKey;
  chatId: number | string;
  messageThreadId?: number;
  text: string;
  queuedAt: number;
  kind?: ClaudeQueuedPromptKind;
}

interface ClaudePromptQueueState {
  version: 1;
  entries: ClaudePromptQueueEntry[];
}

export function claudePromptQueuePath(workspace: string): string {
  return path.join(workspace, ".telecodex", "provider-state", "claude-queue.json");
}

export class ClaudePromptQueue {
  private entries: ClaudePromptQueueEntry[];

  constructor(private readonly filePath: string) {
    this.entries = this.load();
  }

  enqueue(entry: ClaudePromptQueueEntry): number {
    this.entries.push(entry);
    this.save();
    return this.depth(entry.contextKey);
  }

  enqueueFront(entry: ClaudePromptQueueEntry): number {
    const firstSameLane = this.entries.findIndex((candidate) => candidate.contextKey === entry.contextKey);
    if (firstSameLane === -1) {
      this.entries.push(entry);
    } else {
      this.entries.splice(firstSameLane, 0, entry);
    }
    this.save();
    return this.depth(entry.contextKey);
  }

  dequeue(contextKey: TelegramContextKey): ClaudePromptQueueEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.contextKey === contextKey);
    if (index === -1) {
      return undefined;
    }
    const [entry] = this.entries.splice(index, 1);
    this.save();
    return entry;
  }

  peek(contextKey: TelegramContextKey): ClaudePromptQueueEntry | undefined {
    return this.entries.find((entry) => entry.contextKey === contextKey);
  }

  depth(contextKey: TelegramContextKey): number {
    return this.entries.filter((entry) => entry.contextKey === contextKey).length;
  }

  list(contextKey?: TelegramContextKey): ClaudePromptQueueEntry[] {
    return contextKey
      ? this.entries.filter((entry) => entry.contextKey === contextKey)
      : [...this.entries];
  }

  contextKeys(): TelegramContextKey[] {
    return [...new Set(this.entries.map((entry) => entry.contextKey))];
  }

  removeContext(contextKey: TelegramContextKey): void {
    const next = this.entries.filter((entry) => entry.contextKey !== contextKey);
    if (next.length === this.entries.length) {
      return;
    }
    this.entries = next;
    this.save();
  }

  private load(): ClaudePromptQueueEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const parsed = parseJsonFileText<ClaudePromptQueueState>(readFileSync(this.filePath, "utf8"));
      if (parsed.version !== 1) {
        return [];
      }
      return (parsed.entries ?? []).filter(isClaudePromptQueueEntry);
    } catch {
      return [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const state: ClaudePromptQueueState = { version: 1, entries: this.entries };
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}

function isClaudePromptQueueEntry(value: unknown): value is ClaudePromptQueueEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<ClaudePromptQueueEntry>;
  return typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.contextKey === "string" &&
    entry.contextKey.length > 0 &&
    (typeof entry.chatId === "number" || typeof entry.chatId === "string") &&
    typeof entry.text === "string" &&
    entry.text.length > 0 &&
    Number.isFinite(entry.queuedAt) &&
    (entry.messageThreadId === undefined || Number.isInteger(entry.messageThreadId)) &&
    (entry.kind === undefined || entry.kind === "prompt" || entry.kind === "steer");
}
