import { existsSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AgentProviderEvent } from "./types.js";

export interface ClaudeUsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  contextTokens: number;
}

export interface ClaudeTranscriptProjection {
  events: AgentProviderEvent[];
  assistantText: string;
  turnEnded: boolean;
  compactBoundary?: { preTokens?: number; postTokens?: number };
  usage?: ClaudeUsageSnapshot;
}

export interface TranscriptTailerOptions {
  startAtEnd?: boolean;
  pollIntervalMs?: number;
}

type JsonObject = Record<string, unknown>;

const IGNORED_SYSTEM_SUBTYPES = new Set([
  "custom-title",
  "agent-name",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "attachment",
  "summary",
]);

export async function findTranscript(sessionId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = await findTranscriptOnce(sessionId);
    if (found) {
      return found;
    }
    await sleep(500);
  }
  return null;
}

export function projectClaudeTranscriptEntry(
  entry: JsonObject,
  options: { sessionId: string; jobId: string },
): ClaudeTranscriptProjection {
  const events: AgentProviderEvent[] = [];
  let assistantText = "";
  let turnEnded = false;
  let compactBoundary: { preTokens?: number; postTokens?: number } | undefined;
  let usage: ClaudeUsageSnapshot | undefined;

  const entryType = asString(entry.type);
  if (entryType === "assistant") {
    const message = asObject(entry.message);
    const content = asArray(message?.content);
    for (const block of content) {
      const blockObject = asObject(block);
      const blockType = asString(blockObject?.type);
      if (blockType === "text") {
        const text = asString(blockObject?.text);
        if (text) {
          assistantText += text;
          events.push({
            type: "assistant_text_delta",
            sessionId: options.sessionId,
            jobId: options.jobId,
            text,
          });
        }
      } else if (blockType === "tool_use") {
        const toolName = asString(blockObject?.name) || "tool";
        events.push({
          type: "tool_started",
          sessionId: options.sessionId,
          jobId: options.jobId,
          toolName,
          text: summarizeToolInput(blockObject?.input),
        });
      }
    }

    const usageObject = asObject(message?.usage);
    if (usageObject) {
      usage = readUsage(usageObject);
      events.push({
        type: "usage_updated",
        sessionId: options.sessionId,
        jobId: options.jobId,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
      });
    }
  } else if (entryType === "user") {
    if (entry.isMeta === true || entry.isCompactSummary === true) {
      return { events, assistantText, turnEnded };
    }
    const text = extractUserText(entry);
    if (text.startsWith("<local-command-caveat>") || text.startsWith("<command-name>")) {
      return { events, assistantText, turnEnded };
    }
    for (const block of asArray(asObject(entry.message)?.content)) {
      const blockObject = asObject(block);
      if (asString(blockObject?.type) !== "tool_result") {
        continue;
      }
      const isError = blockObject?.is_error === true;
      events.push({
        type: isError ? "tool_failed" : "tool_completed",
        sessionId: options.sessionId,
        jobId: options.jobId,
        toolName: "tool",
        text: summarizeToolResult(blockObject?.content),
      });
    }
  } else if (entryType === "system") {
    const subtype = asString(entry.subtype);
    if (subtype === "turn_duration") {
      turnEnded = true;
      events.push({ type: "session_status_changed", sessionId: options.sessionId, status: "idle" });
    } else if (subtype === "compact_boundary") {
      const metadata = asObject(entry.compactMetadata);
      compactBoundary = {
        preTokens: asNumber(metadata?.preTokens),
        postTokens: asNumber(metadata?.postTokens),
      };
      events.push({
        type: "compact_boundary",
        sessionId: options.sessionId,
        summary: formatCompactBoundary(compactBoundary),
      });
    } else if (subtype && !IGNORED_SYSTEM_SUBTYPES.has(subtype)) {
      events.push({
        type: "session_status_changed",
        sessionId: options.sessionId,
        status: "running",
      });
    }
  }

  return { events, assistantText, turnEnded, compactBoundary, usage };
}

export class TranscriptTailer {
  private offset = 0;
  private partial = "";
  private readonly pollIntervalMs: number;

  constructor(
    private readonly transcriptPath: string,
    options: TranscriptTailerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    if (options.startAtEnd && existsSync(transcriptPath)) {
      this.offset = statSyncSize(transcriptPath);
    }
  }

  async *eventsUntilTurnEnd(options: {
    sessionId: string;
    jobId: string;
    idleTimeoutMs: number;
  }): AsyncIterable<AgentProviderEvent> {
    let collectedText = "";
    let lastBytesAt = Date.now();
    let lastUsage: ClaudeUsageSnapshot | undefined;

    while (true) {
      const projections = await this.readNewProjections(options.sessionId, options.jobId);
      if (projections.length > 0) {
        lastBytesAt = Date.now();
      }

      for (const projection of projections) {
        collectedText += projection.assistantText;
        if (projection.usage) {
          lastUsage = projection.usage;
        }
        for (const event of projection.events) {
          yield event;
        }
        if (projection.turnEnded) {
          if (collectedText.trim()) {
            yield {
              type: "assistant_message_complete",
              sessionId: options.sessionId,
              jobId: options.jobId,
              text: collectedText,
            };
          }
          if (lastUsage) {
            yield {
              type: "usage_updated",
              sessionId: options.sessionId,
              jobId: options.jobId,
              inputTokens: lastUsage.inputTokens,
              cachedInputTokens: lastUsage.cachedInputTokens,
              outputTokens: lastUsage.outputTokens,
            };
          }
          return;
        }
      }

      if (Date.now() - lastBytesAt > options.idleTimeoutMs) {
        yield {
          type: "error",
          sessionId: options.sessionId,
          jobId: options.jobId,
          message: `Claude turn idle timeout after ${Math.round(options.idleTimeoutMs / 1000)} seconds`,
        };
        return;
      }

      await sleep(this.pollIntervalMs);
    }
  }

  async waitForCompact(options: {
    sessionId: string;
    jobId: string;
    timeoutMs: number;
  }): Promise<string | null> {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() <= deadline) {
      const projections = await this.readNewProjections(options.sessionId, options.jobId);
      for (const projection of projections) {
        if (projection.compactBoundary) {
          return formatCompactBoundary(projection.compactBoundary);
        }
      }
      await sleep(this.pollIntervalMs);
    }
    return null;
  }

  private async readNewProjections(sessionId: string, jobId: string): Promise<ClaudeTranscriptProjection[]> {
    const handle = await open(this.transcriptPath, "r");
    try {
      const currentSize = (await handle.stat()).size;
      if (currentSize <= this.offset) {
        return [];
      }

      const length = currentSize - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = currentSize;

      const text = this.partial + buffer.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        this.partial = text;
        return [];
      }

      this.partial = text.slice(lastNewline + 1);
      const completeText = text.slice(0, lastNewline);
      const projections: ClaudeTranscriptProjection[] = [];
      for (const line of completeText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          projections.push(projectClaudeTranscriptEntry(JSON.parse(trimmed) as JsonObject, { sessionId, jobId }));
        } catch (error) {
          projections.push({
            assistantText: "",
            turnEnded: false,
            events: [{
              type: "error",
              sessionId,
              jobId,
              message: `Failed to parse Claude transcript line: ${error instanceof Error ? error.message : String(error)}`,
            }],
          });
        }
      }
      return projections;
    } finally {
      await handle.close();
    }
  }
}

async function findTranscriptOnce(sessionId: string): Promise<string | null> {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const candidate = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readUsage(usage: JsonObject): ClaudeUsageSnapshot {
  const inputTokens = asNumber(usage.input_tokens) ?? 0;
  const outputTokens = asNumber(usage.output_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreation = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const cachedInputTokens = cacheRead + cacheCreation;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    contextTokens: inputTokens + cachedInputTokens,
  };
}

function extractUserText(entry: JsonObject): string {
  const content = asArray(asObject(entry.message)?.content);
  const parts: string[] = [];
  for (const block of content) {
    const blockObject = asObject(block);
    if (asString(blockObject?.type) === "text") {
      parts.push(asString(blockObject?.text));
    }
  }
  return parts.join("\n").trim();
}

function summarizeToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === "string") {
    return truncateOneLine(input, 300);
  }
  try {
    return truncateOneLine(JSON.stringify(input), 300);
  } catch {
    return truncateOneLine(String(input), 300);
  }
}

function summarizeToolResult(content: unknown): string | undefined {
  if (content === undefined || content === null) {
    return undefined;
  }
  if (typeof content === "string") {
    return truncateOneLine(content, 300);
  }
  try {
    return truncateOneLine(JSON.stringify(content), 300);
  } catch {
    return truncateOneLine(String(content), 300);
  }
}

function formatCompactBoundary(boundary: { preTokens?: number; postTokens?: number }): string {
  if (boundary.preTokens !== undefined && boundary.postTokens !== undefined) {
    return `Compacted: ${formatTokenCount(boundary.preTokens)} -> ${formatTokenCount(boundary.postTokens)} tokens`;
  }
  return "Compaction completed.";
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}...`;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function statSyncSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
