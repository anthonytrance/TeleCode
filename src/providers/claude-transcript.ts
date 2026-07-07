import { existsSync, readFileSync, statSync } from "node:fs";
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
  title?: string;
  compactBoundary?: { preTokens?: number; postTokens?: number };
  usage?: ClaudeUsageSnapshot;
}

export interface TranscriptTailerOptions {
  startAtEnd?: boolean;
  /**
   * Byte offset to begin reading from. Takes precedence over startAtEnd. Use this to
   * resume reading a transcript that already holds this turn's content: capture the file
   * size *before* the prompt is sent, then start the tailer there so nothing is skipped.
   */
  startOffset?: number;
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

export async function findTranscript(
  sessionId: string,
  timeoutMs: number,
  configDir?: string,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = await findTranscriptOnce(sessionId, configDir);
    if (found) {
      return found;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Snapshot the set of transcript jsonl paths currently on disk across every project
 * directory under the config dir. Used to detect the file Claude creates for a turn:
 * interactive Claude ignores the --session-id we pass, so we cannot predict the
 * filename and must spot the one that appears (or grows) instead.
 */
export async function snapshotTranscripts(configDir?: string): Promise<Set<string>> {
  const snapshot = await snapshotTranscriptSizes(configDir);
  return new Set(snapshot.keys());
}

export async function snapshotTranscriptSizes(configDir?: string): Promise<Map<string, number>> {
  const baseConfigDir = configDir ?? path.join(homedir(), ".claude");
  const projectsDir = path.join(baseConfigDir, "projects");
  const result = new Map<string, number>();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return result;
  }
  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = await readdir(path.join(projectsDir, projectDir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl")) {
        const filePath = path.join(projectsDir, projectDir, file);
        result.set(filePath, statSyncSize(filePath));
      }
    }
  }
  return result;
}

export interface ActiveTranscript {
  path: string;
  /** Byte offset to start the tailer at so only this turn's content is read. */
  startOffset: number;
}

/**
 * Find the transcript that is actively receiving this turn's content. Prefers the
 * known transcript when it grows, then a fresh file matching the expected session id,
 * then the newest fresh file as a fallback for older Claude builds that ignore the
 * requested session id or fork a new one.
 */
export async function locateActiveTranscript(options: {
  before: Set<string> | Map<string, number>;
  expectedSessionId?: string;
  knownPath?: string;
  knownOffset: number;
  timeoutMs: number;
  configDir?: string;
  pollIntervalMs?: number;
  /**
   * When set, only transcripts inside this project directory are considered as fresh/grown
   * candidates. Prevents grabbing another concurrent Claude process's transcript (e.g. a
   * standalone terminal session) as this turn's output. The knownPath is always honoured.
   */
  projectDir?: string;
}): Promise<ActiveTranscript | null> {
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const before = normalizeTranscriptSnapshot(options.before);
  while (Date.now() <= deadline) {
    const now = await snapshotTranscriptSizes(options.configDir);
    const fresh: string[] = [];
    const grown: Array<{ path: string; startOffset: number }> = [];
    for (const [candidate, size] of now) {
      if (!isInProjectDir(candidate, options.projectDir)) {
        continue;
      }
      const priorSize = before.get(candidate);
      if (priorSize === undefined) {
        fresh.push(candidate);
      } else if (size > priorSize) {
        grown.push({ path: candidate, startOffset: priorSize });
      }
    }
    if (options.knownPath && existsSync(options.knownPath)) {
      const size = statSyncSize(options.knownPath);
      if (size > options.knownOffset) {
        return { path: options.knownPath, startOffset: options.knownOffset };
      }
    }
    const expectedFresh = options.expectedSessionId
      ? fresh.find((candidate) => sessionIdFromTranscriptPath(candidate) === options.expectedSessionId)
      : undefined;
    if (expectedFresh) {
      return { path: expectedFresh, startOffset: 0 };
    }
    if (fresh.length > 0) {
      return { path: await newestPath(fresh), startOffset: 0 };
    }
    if (grown.length > 0) {
      const path = await newestPath(grown.map((candidate) => candidate.path));
      return grown.find((candidate) => candidate.path === path) ?? null;
    }
    await sleep(pollIntervalMs);
  }
  return null;
}

/**
 * Find the transcript turn for the exact prompt that was just sent. This is stricter
 * than file-growth detection: interactive Claude can rewrite metadata or repaint old
 * screen content without actually accepting a new prompt. For normal user prompts,
 * TeleCodex must not tail an answer until the prompt itself appears after the
 * captured pre-send offset.
 */
export async function locateActiveTranscriptTurnByPrompt(options: {
  before: Set<string> | Map<string, number>;
  promptText: string;
  expectedSessionId?: string;
  knownPath?: string;
  knownOffset: number;
  timeoutMs: number;
  configDir?: string;
  pollIntervalMs?: number;
  /** See locateActiveTranscript: restrict fresh/grown candidates to this project dir. */
  projectDir?: string;
}): Promise<ActiveTranscript | null> {
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const before = normalizeTranscriptSnapshot(options.before);
  const normalizedPrompt = normalizePromptText(options.promptText);
  if (!normalizedPrompt) {
    return null;
  }

  while (Date.now() <= deadline) {
    const now = await snapshotTranscriptSizes(options.configDir);
    const candidates: Array<{ path: string; minOffset: number; priority: number }> = [];
    if (options.knownPath && existsSync(options.knownPath)) {
      candidates.push({ path: options.knownPath, minOffset: options.knownOffset, priority: 0 });
    }

    for (const [candidate, size] of now) {
      if (!isInProjectDir(candidate, options.projectDir)) {
        continue;
      }
      const priorSize = before.get(candidate);
      if (priorSize === undefined) {
        candidates.push({
          path: candidate,
          minOffset: 0,
          priority: options.expectedSessionId && sessionIdFromTranscriptPath(candidate) === options.expectedSessionId ? 1 : 3,
        });
      } else if (size > priorSize) {
        candidates.push({
          path: candidate,
          minOffset: priorSize,
          priority: options.expectedSessionId && sessionIdFromTranscriptPath(candidate) === options.expectedSessionId ? 1 : 2,
        });
      }
    }

    candidates.sort((a, b) => a.priority - b.priority || b.minOffset - a.minOffset);
    for (const candidate of dedupeTranscriptCandidates(candidates)) {
      const promptOffset = findLastPromptOffset(candidate.path, normalizedPrompt, candidate.minOffset);
      if (promptOffset !== undefined) {
        return { path: candidate.path, startOffset: promptOffset };
      }
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

/**
 * Last-resort recovery for cases where Claude wrote the turn, but file-growth
 * detection missed it. Finds the latest user prompt entry matching the exact
 * prompt text and returns its byte offset so the tailer can replay that turn.
 */
export async function locateTranscriptTurnByPrompt(options: {
  promptText: string;
  expectedSessionId?: string;
  knownPath?: string;
  minOffset?: number;
  configDir?: string;
}): Promise<ActiveTranscript | null> {
  const candidates = await transcriptPromptRecoveryCandidates(options);
  const normalizedPrompt = normalizePromptText(options.promptText);
  if (!normalizedPrompt) {
    return null;
  }

  for (const candidate of candidates) {
    const minOffset = candidate === options.knownPath ? options.minOffset : undefined;
    const startOffset = findLastPromptOffset(candidate, normalizedPrompt, minOffset);
    if (startOffset !== undefined) {
      return { path: candidate, startOffset };
    }
  }
  return null;
}

/**
 * Last-resort recovery for interactive PTY races: if the exact prompt comparison
 * missed, but the transcript contains a single real human prompt after the
 * pre-send offset, use that prompt as the turn boundary. Tool-result user entries
 * are deliberately ignored, because Claude writes those during its own tool loop.
 */
export async function locateSingleHumanPromptTurn(options: {
  expectedSessionId?: string;
  knownPath?: string;
  minOffset?: number;
  configDir?: string;
}): Promise<ActiveTranscript | null> {
  const candidates = await transcriptPromptRecoveryCandidates(options);
  for (const candidate of candidates) {
    const minOffset = candidate === options.knownPath ? options.minOffset : undefined;
    const matches = findHumanPromptOffsets(candidate, minOffset);
    if (matches.length === 1) {
      return { path: candidate, startOffset: matches[0]! };
    }
  }
  return null;
}

export function sessionIdFromTranscriptPath(transcriptPath: string): string {
  return path.basename(transcriptPath, ".jsonl");
}

/**
 * True when a candidate transcript lives in the given project directory. When no
 * projectDir is supplied (e.g. the very first turn, before we know Claude's real
 * transcript path), every candidate is allowed so discovery still works.
 */
function isInProjectDir(candidatePath: string, projectDir?: string): boolean {
  if (!projectDir) {
    return true;
  }
  return path.resolve(path.dirname(candidatePath)) === path.resolve(projectDir);
}

async function newestPath(paths: string[]): Promise<string> {
  let best = paths[0]!;
  let bestMtime = -1;
  for (const candidate of paths) {
    try {
      const mtime = (await stat(candidate)).mtimeMs;
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        best = candidate;
      }
    } catch {
      // Ignore files that vanished between snapshot and stat.
    }
  }
  return best;
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
    const observedModel = asString(message?.model);
    if (observedModel && observedModel !== "<synthetic>") {
      events.push({
        type: "model_updated",
        sessionId: options.sessionId,
        jobId: options.jobId,
        model: observedModel,
      });
    }
    if (entry.isApiErrorMessage === true || entry.error) {
      const errorText = extractAssistantText(message) || asString(entry.error) || "Claude API error";
      assistantText += errorText;
      events.push({
        type: "assistant_text_delta",
        sessionId: options.sessionId,
        jobId: options.jobId,
        text: errorText,
      });
      turnEnded = true;
      return { events, assistantText, turnEnded, compactBoundary, usage };
    }
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
      const noticeText = extractSystemNoticeText(entry);
      events.push(noticeText
        ? {
            type: "status_message",
            sessionId: options.sessionId,
            text: noticeText,
          }
        : {
            type: "session_status_changed",
            sessionId: options.sessionId,
            status: "running",
          });
    }
  } else if (entryType === "ai-title") {
    const title = asString(entry.aiTitle).trim();
    if (title) {
      events.push({
        type: "session_title_changed",
        sessionId: options.sessionId,
        title,
      });
      return { events, assistantText, turnEnded, title };
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
    if (typeof options.startOffset === "number") {
      this.offset = Math.max(0, options.startOffset);
    } else if (options.startAtEnd && existsSync(transcriptPath)) {
      this.offset = statSyncSize(transcriptPath);
    }
  }

  async *eventsUntilTurnEnd(options: {
    sessionId: string;
    jobId: string;
    idleTimeoutMs: number;
    /**
     * Optional cancellation check. Polled each loop; when it returns true the tailer
     * stops promptly (within one poll interval) instead of waiting out the idle timeout.
     * Used by /abort so an interrupted turn does not stall the session for minutes.
     */
    shouldStop?: () => boolean;
  }): AsyncIterable<AgentProviderEvent> {
    let collectedText = "";
    let lastBytesAt = Date.now();
    let lastUsage: ClaudeUsageSnapshot | undefined;

    while (true) {
      if (options.shouldStop?.()) {
        if (collectedText.trim()) {
          yield {
            type: "assistant_message_complete",
            sessionId: options.sessionId,
            jobId: options.jobId,
            text: collectedText,
          };
        }
        return;
      }
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

async function findTranscriptOnce(sessionId: string, configDir?: string): Promise<string | null> {
  const baseConfigDir = configDir ?? path.join(homedir(), ".claude");
  const projectsDir = path.join(baseConfigDir, "projects");
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
  const rawContent = asObject(entry.message)?.content;
  if (typeof rawContent === "string") {
    return rawContent.trim();
  }
  const content = asArray(rawContent);
  const parts: string[] = [];
  for (const block of content) {
    const blockObject = asObject(block);
    if (asString(blockObject?.type) === "text") {
      parts.push(asString(blockObject?.text));
    }
  }
  return parts.join("\n").trim();
}

function extractAssistantText(message: JsonObject | undefined): string {
  const parts: string[] = [];
  for (const block of asArray(message?.content)) {
    const blockObject = asObject(block);
    if (asString(blockObject?.type) === "text") {
      const text = asString(blockObject?.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

function extractSystemNoticeText(entry: JsonObject): string {
  const direct = asString(entry.text) || asString(entry.message) || asString(entry.notice) || asString(entry.content);
  if (direct) {
    return truncateOneLine(direct, 1000);
  }

  const nested = asObject(entry.message);
  const nestedText = asString(nested?.text) || asString(nested?.content);
  if (nestedText) {
    return truncateOneLine(nestedText, 1000);
  }

  const parts: string[] = [];
  for (const block of asArray(entry.content ?? nested?.content)) {
    const blockObject = asObject(block);
    if (typeof block === "string") {
      parts.push(block);
    } else if (asString(blockObject?.type) === "text") {
      parts.push(asString(blockObject?.text));
    }
  }
  return truncateOneLine(parts.join(" "), 1000);
}

async function transcriptPromptRecoveryCandidates(options: {
  expectedSessionId?: string;
  knownPath?: string;
  configDir?: string;
}): Promise<string[]> {
  const candidates: string[] = [];
  if (options.knownPath && existsSync(options.knownPath)) {
    candidates.push(options.knownPath);
  }

  if (options.expectedSessionId) {
    const expected = await findTranscriptOnce(options.expectedSessionId, options.configDir);
    if (expected) {
      candidates.push(expected);
    }
  }

  const snapshot = await snapshotTranscriptSizes(options.configDir);
  const byMtime = await Promise.all(
    [...snapshot.keys()].map(async (filePath) => {
      let mtime = 0;
      try {
        mtime = (await stat(filePath)).mtimeMs;
      } catch {
        // Ignore files that disappear while building the recovery list.
      }
      return { filePath, mtime };
    }),
  );
  byMtime
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 25)
    .forEach((entry) => candidates.push(entry.filePath));

  return [...new Set(candidates)];
}

function findLastPromptOffset(filePath: string, normalizedPrompt: string, minOffset = 0): number | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return undefined;
  }

  let lineStart = 0;
  let lastMatch: number | undefined;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index < buffer.length && buffer[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index > lineStart && buffer[index - 1] === 0x0d ? index - 1 : index;
    if (lineEnd > lineStart) {
      const line = buffer.subarray(lineStart, lineEnd).toString("utf8").trim();
      const userPrompt = userPromptFromJsonLine(line);
      if (lineStart >= minOffset && userPrompt && normalizePromptText(userPrompt) === normalizedPrompt) {
        lastMatch = lineStart;
      }
    }
    lineStart = index + 1;
  }

  return lastMatch;
}

function findHumanPromptOffsets(filePath: string, minOffset = 0): number[] {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return [];
  }

  const matches: number[] = [];
  let lineStart = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index < buffer.length && buffer[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index > lineStart && buffer[index - 1] === 0x0d ? index - 1 : index;
    if (lineEnd > lineStart && lineStart >= minOffset) {
      const line = buffer.subarray(lineStart, lineEnd).toString("utf8").trim();
      if (humanPromptFromJsonLine(line)) {
        matches.push(lineStart);
      }
    }
    lineStart = index + 1;
  }

  return matches;
}

function dedupeTranscriptCandidates(
  candidates: Array<{ path: string; minOffset: number; priority: number }>,
): Array<{ path: string; minOffset: number; priority: number }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; minOffset: number; priority: number }> = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) {
      continue;
    }
    seen.add(candidate.path);
    result.push(candidate);
  }
  return result;
}

function userPromptFromJsonLine(line: string): string | undefined {
  return humanPromptFromJsonLine(line);
}

function humanPromptFromJsonLine(line: string): string | undefined {
  let entry: JsonObject;
  try {
    entry = JSON.parse(line) as JsonObject;
  } catch {
    return undefined;
  }
  if (asString(entry.type) !== "user") {
    return undefined;
  }
  if (entry.isMeta === true || entry.isCompactSummary === true) {
    return undefined;
  }
  const text = extractUserText(entry);
  if (!text || text.startsWith("<local-command-caveat>") || text.startsWith("<command-name>")) {
    return undefined;
  }
  return text;
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

function normalizeTranscriptSnapshot(snapshot: Set<string> | Map<string, number>): Map<string, number> {
  if (snapshot instanceof Map) {
    return new Map(snapshot);
  }
  const result = new Map<string, number>();
  for (const filePath of snapshot) {
    result.set(filePath, statSyncSize(filePath));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
