import { bridgeLog } from "../bridge-log.js";
import type { ClaudePermissionMode } from "../config.js";
import type { AgentProviderEvent } from "./types.js";

/**
 * Agent SDK turn runner — the D3 fix. The SDK streams EVERY assistant message
 * (interim narration between tool calls included), unlike the interactive
 * transcript, which drops some mid-turn text blocks. Verified by the C0 spike
 * on @anthropic-ai/claude-agent-sdk 0.3.204 (2026-07-08): ALPHA/BETA/GAMMA all
 * arrived as separate assistant messages, resume continued the session, and
 * forkSession minted a new session id.
 *
 * One query() per turn with `resume` — restart-safe and identical to the PTY
 * path's per-turn model. The SDK writes the same ~/.claude/projects transcript
 * format, so sessions stay switchable between backends.
 */

export interface ClaudeSdkTurnOptions {
  /** TeleCode descriptor id — stamped on every emitted event. */
  sessionId: string;
  jobId: string;
  promptText: string;
  cwd: string;
  claudeBin: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  /** Provider (Claude) session id to resume; omitted for a fresh session. */
  resume?: string;
  forkSession?: boolean;
  abortController?: AbortController;
  /** Called as soon as the init message reveals the real Claude session id. */
  onProviderSessionId?: (providerSessionId: string) => void;
  /** Optional controller for live steering after promptText starts the turn. */
  inputController?: ClaudeSdkInputController;
  /** Injectable for tests; defaults to the real SDK query(). */
  queryFn?: (input: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }) => AsyncIterable<SdkMessageLike> & {
    close?: () => void;
    streamInput?: (stream: AsyncIterable<SdkUserMessageLike>) => Promise<void>;
  };
}

/** Structural view of the SDK messages this engine consumes. */
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    model?: string;
    content?: Array<Record<string, unknown>>;
  };
  result?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  errors?: unknown[];
}

export interface SdkUserMessageLike {
  type: "user";
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id: null;
  priority?: "now" | "next" | "later";
  shouldQuery?: boolean;
  timestamp?: string;
}

export class ClaudeSdkInputController implements AsyncIterable<SdkUserMessageLike> {
  private readonly queue: SdkUserMessageLike[] = [];
  private readonly waiters: Array<(result: IteratorResult<SdkUserMessageLike>) => void> = [];
  private closed = false;

  push(text: string, priority: SdkUserMessageLike["priority"] = "now"): void {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Claude steer text is empty");
    }
    if (this.closed) {
      throw new Error("Claude SDK input stream is closed");
    }
    const message = sdkUserMessage(trimmed, priority);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessageLike> {
    return {
      next: async (): Promise<IteratorResult<SdkUserMessageLike>> => {
        const next = this.queue.shift();
        if (next) {
          return { value: next, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<SdkUserMessageLike>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export async function* runClaudeSdkTurn(options: ClaudeSdkTurnOptions): AsyncIterable<AgentProviderEvent> {
  const queryFn = options.queryFn ?? (await loadSdkQuery());
  const { sessionId, jobId } = options;

  const baseSdkOptions: Record<string, unknown> = {
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    pathToClaudeCodeExecutable: options.claudeBin,
    // Behave like the user's interactive sessions: Claude Code system prompt,
    // user + project settings, CLAUDE.md, and skills.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project"],
    // Rule 1: the child must never start the user-scoped telegram plugin's
    // poller (it kills the live bridge via a 409 on the shared bot token, and
    // the C0 spike proved plugins load even without settingSources). Same flag
    // the PTY path uses in production.
    strictMcpConfig: true,
    env: scrubbedEnv(),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.forkSession ? { forkSession: true } : {}),
    ...(options.abortController ? { abortController: options.abortController } : {}),
  };

  let lastModel: string | undefined;
  let activeProviderSessionId = options.resume;
  const inputController = options.inputController;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryPrompt = attempt === 0
        ? options.promptText
        : "The previous turn ended successfully but produced no written response. Answer the user's most recent request now. Do not repeat completed tool actions; summarize them if any occurred.";
      const sdkOptions = {
        ...baseSdkOptions,
        ...(activeProviderSessionId ? { resume: activeProviderSessionId } : {}),
        ...(attempt > 0 ? { forkSession: false } : {}),
      };
      // Always send the turn's initial request as the primary SDK prompt. Using the
      // AsyncIterable as the primary prompt can let a pending task notification finish
      // the resumed query before the queued user message is consumed. Reserve the
      // streaming input channel for genuine mid-turn steering instead.
      const query = queryFn({ prompt: retryPrompt, options: sdkOptions });
      const steerStream = attempt === 0 && inputController && query.streamInput
        ? query.streamInput(inputController).catch((error: unknown) => {
            bridgeLog("error", `sdk live input stream failed: ${error instanceof Error ? error.message : String(error)}`);
          })
        : undefined;
      let sawResult = false;
      let sawAssistantText = false;
      let retryEmptySuccess = false;

      try {
        for await (const message of query) {
          if (message.type === "system" && message.subtype === "init") {
            if (message.session_id) {
              activeProviderSessionId = message.session_id;
              options.onProviderSessionId?.(message.session_id);
            }
            continue;
          }

          if (message.type === "assistant") {
            const model = message.message?.model;
            if (model && model !== "<synthetic>" && model !== lastModel) {
              lastModel = model;
              yield { type: "model_updated", sessionId, jobId, model };
            }
            for (const block of message.message?.content ?? []) {
              const blockType = typeof block.type === "string" ? block.type : "";
              if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
                sawAssistantText = true;
                yield { type: "assistant_text_delta", sessionId, jobId, text: block.text };
              } else if (blockType === "tool_use") {
                yield {
                  type: "tool_started",
                  sessionId,
                  jobId,
                  toolName: typeof block.name === "string" && block.name ? block.name : "tool",
                  text: summarizeSdkToolInput(block.input),
                };
              }
            }
            continue;
          }

          if (message.type === "user") {
            for (const block of message.message?.content ?? []) {
              if (block.type !== "tool_result") {
                continue;
              }
              yield {
                type: block.is_error === true ? "tool_failed" : "tool_completed",
                sessionId,
                jobId,
                toolName: "tool",
              };
            }
            continue;
          }

          if (message.type === "result") {
            sawResult = true;
            const usage = message.usage ?? {};
            const inputTokens = asNumber(usage.input_tokens) ?? 0;
            const cachedInputTokens = (asNumber(usage.cache_read_input_tokens) ?? 0) +
              (asNumber(usage.cache_creation_input_tokens) ?? 0);
            const outputTokens = asNumber(usage.output_tokens) ?? 0;
            yield { type: "usage_updated", sessionId, jobId, inputTokens, cachedInputTokens, outputTokens };

            if (message.subtype === "success") {
              const resultText = (message.result ?? "").trim();
              if (resultText || sawAssistantText) {
                yield {
                  type: "assistant_message_complete",
                  sessionId,
                  jobId,
                  text: resultText,
                };
              } else if (attempt === 0) {
                retryEmptySuccess = true;
                bridgeLog("retry", `sdk turn returned empty success; retrying session=${activeProviderSessionId ?? sessionId}`);
              } else {
                yield {
                  type: "error",
                  sessionId,
                  jobId,
                  message: "Claude SDK returned a successful result without assistant text twice.",
                };
              }
            } else {
              const detail = message.result?.trim() || describeSdkErrors(message.errors) || message.subtype || "unknown error";
              bridgeLog("error", `sdk turn result ${message.subtype ?? "?"}: ${detail}`);
              yield { type: "error", sessionId, jobId, message: `Claude SDK turn ended: ${detail}` };
            }
            break;
          }

          // rate_limit_event, status, hook events, partial messages, etc. - not part
          // of the provider event contract; ignored deliberately.
        }
      } finally {
        if (attempt === 0) {
          inputController?.close();
        }
        query.close?.();
        await steerStream;
      }

      if (!sawResult) {
        yield {
          type: "error",
          sessionId,
          jobId,
          message: "Claude SDK stream ended without a result message (aborted or crashed).",
        };
        return;
      }
      if (!retryEmptySuccess) {
        return;
      }
    }
  } finally {
    inputController?.close();
  }
}

async function loadSdkQuery(): Promise<NonNullable<ClaudeSdkTurnOptions["queryFn"]>> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query as unknown as NonNullable<ClaudeSdkTurnOptions["queryFn"]>;
}

function sdkUserMessage(text: string, priority: SdkUserMessageLike["priority"]): SdkUserMessageLike {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    priority,
    shouldQuery: true,
    timestamp: new Date().toISOString(),
  };
}

function scrubbedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("TELECODE_") ||
      key.startsWith("TELECODEX_")
    ) {
      delete env[key];
    }
  }
  return env;
}

function summarizeSdkToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  try {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length <= 300 ? singleLine : `${singleLine.slice(0, 299)}…`;
  } catch {
    return undefined;
  }
}

function describeSdkErrors(errors: unknown[] | undefined): string | undefined {
  if (!errors?.length) {
    return undefined;
  }
  try {
    return errors.map((error) => (typeof error === "string" ? error : JSON.stringify(error))).join("; ").slice(0, 500);
  } catch {
    return undefined;
  }
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
