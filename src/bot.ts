import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  probeCodexAppServer,
  runCodexAppServerSteeredTurn,
  runCodexAppServerTurn,
  type AppServerProbeResult,
  type AppServerSteerResult,
  type AppServerTurnResult,
} from "./app-server.js";
import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
} from "./codex-session.js";
import { createCodexSession, type CodexSessionRuntime } from "./codex-backend.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  formatLaunchProfileLabel,
} from "./codex-launch.js";
import { getThread, getThreadByPrefix, readThreadHistory } from "./codex-state.js";
import type { CodexBackend, ProgressDelivery, TeleCodexConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { SessionRegistry } from "./session-registry.js";
import { readLatestCodexUsage, renderUsagePlain } from "./usage.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const FIRST_INTERMEDIATE_UPDATE_MS = 2500;
const INTERMEDIATE_UPDATE_MIN_MS = 30000;
const SUMMARY_PROGRESS_UPDATE_MIN_MS = 30000;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const STREAM_MESSAGE_TARGET = 1200;
const FORMATTED_CHUNK_TARGET = 3600;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";
const NATIVE_CODEX_COMMANDS = [
  "compact",
  "agents",
  "diff",
  "help",
  "doctor",
  "prompts",
  "memory",
  "mentions",
  "init",
  "bug",
  "config",
  "limits",
] as const;
const NEW_FROM_SUMMARY_PROMPT = [
  "Create a compact handoff summary for continuing this Codex session in a fresh thread.",
  "Include: current goal, important decisions, files changed or inspected, commands run, current state, open problems, and recommended next steps.",
  "Be specific enough that a new session can continue without reading the full transcript.",
  "Output only the summary.",
].join("\n");

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

type QueuedPrompt = {
  ctx: Context;
  chatId: TelegramChatId;
  session: CodexSessionRuntime;
  userInput: CodexPromptInput;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(config: TeleCodexConfig, registry: SessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const lastAssistantReply = new Map<TelegramContextKey, string>();
  const queuedPrompts = new Map<TelegramContextKey, QueuedPrompt>();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    lastPromptInput.delete(key);
    lastAssistantReply.delete(key);
    queuedPrompts.delete(key);
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || session?.isProcessing());
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionRuntime } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionRuntime): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const queuePromptReply = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const replaced = queuedPrompts.has(contextKey);
    queuedPrompts.set(contextKey, { ctx, chatId, session, userInput });
    const text = replaced
      ? "Still working. I replaced the queued message with your latest one. Use /abort if the current task is stuck."
      : "Still working. I queued this message and will run it next. Use /abort if the current task is stuck.";
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const streamAssistantText = config.streamAssistantText && !shouldHoldFinalResponse(userInput);

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const progressDelivery = registry.getProgressDelivery(contextKey);
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let pendingStreamText = "";
    let sentResponseText = false;
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = Date.now();
    let flushTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let lastProgressEditAt = 0;
    let lastProgressText = "";
    let progressUpdateInFlight = false;
    let pendingProgress: RenderedText | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let autoArtifactOutDir: string | undefined;

    const typingInterval = setInterval(() => {
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const clearProgressTimer = (): void => {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
      }
    };

    const extractStreamParts = (force = false): string[] => {
      const parts: string[] = [];

      while (pendingStreamText.trim()) {
        let cut = -1;

        if (force) {
          cut = pendingStreamText.length;
        } else {
          const paragraph = pendingStreamText.match(/\n\s*\n/);
          if (paragraph?.index !== undefined) {
            cut = paragraph.index + paragraph[0].length;
          } else if (pendingStreamText.length >= STREAM_MESSAGE_TARGET) {
            const windowText = pendingStreamText.slice(0, STREAM_MESSAGE_TARGET);
            cut = Math.max(
              windowText.lastIndexOf("\n"),
              windowText.lastIndexOf(". "),
              windowText.lastIndexOf("? "),
              windowText.lastIndexOf("! "),
              windowText.lastIndexOf("; "),
              windowText.lastIndexOf(", "),
              windowText.lastIndexOf(" "),
            );
            cut = cut < STREAM_MESSAGE_TARGET / 2 ? STREAM_MESSAGE_TARGET : cut + 1;
          }
        }

        if (cut <= 0) {
          break;
        }

        const part = pendingStreamText.slice(0, cut).trim();
        pendingStreamText = pendingStreamText.slice(cut).replace(/^\s+/, "");
        if (part) {
          parts.push(part);
        }

        if (!force && pendingStreamText.length < STREAM_MESSAGE_TARGET) {
          break;
        }
      }

      return parts;
    };

    const buildFooterText = (): string => {
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        return usageLine;
      }

      if (toolVerbosity === "all") {
        return usageLine;
      }

      return "";
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const placeholder = renderMarkdownChunkWithinLimit("Working...");
        const message = await sendTextMessage(bot.api, chatId, placeholder.text, {
          parseMode: placeholder.parseMode,
          fallbackText: placeholder.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = placeholder.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!pendingStreamText) {
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      const updateDelay = sentResponseText ? INTERMEDIATE_UPDATE_MIN_MS : FIRST_INTERMEDIATE_UPDATE_MS;
      if (!force && now - lastEditAt < updateDelay) {
        return;
      }

      const streamParts = extractStreamParts(force);
      if (streamParts.length === 0) {
        return;
      }

      isFlushing = true;
      try {
        stopTyping();
        for (const part of streamParts) {
          const chunks = splitMarkdownForTelegram(part);
          for (const chunk of chunks) {
            await sendTextMessage(bot.api, chatId, chunk.text, {
              parseMode: chunk.parseMode,
              fallbackText: chunk.fallbackText,
              messageThreadId,
            });
            sentResponseText = true;
          }
        }
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const updateDelay = sentResponseText ? INTERMEDIATE_UPDATE_MIN_MS : FIRST_INTERMEDIATE_UPDATE_MS;
      const delay = Math.max(0, updateDelay - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const sendProgressUpdate = async (rendered: RenderedText): Promise<void> => {
      if (finalized || progressDelivery === "none" || rendered.text === lastProgressText) {
        return;
      }

      if (progressUpdateInFlight) {
        pendingProgress = rendered;
        return;
      }

      const now = Date.now();
      if (lastProgressEditAt && now - lastProgressEditAt < SUMMARY_PROGRESS_UPDATE_MIN_MS) {
        pendingProgress = rendered;
        if (!progressTimer) {
          const delay = Math.max(0, SUMMARY_PROGRESS_UPDATE_MIN_MS - (now - lastProgressEditAt));
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            const next = pendingProgress;
            pendingProgress = undefined;
            if (next) {
              void sendProgressUpdate(next).catch((error) => {
                console.error("Failed to send progress update", error);
              });
            }
          }, delay);
        }
        return;
      }

      progressUpdateInFlight = true;
      try {
        stopTyping();
        if (progressDelivery === "messages") {
          await sendTextMessage(bot.api, chatId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            messageThreadId,
          });
        } else if (!responseMessageId) {
          const message = await sendTextMessage(bot.api, chatId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            replyMarkup: abortKeyboard,
            messageThreadId,
          });
          responseMessageId = message.message_id;
        } else {
          await safeEditMessage(bot, chatId, responseMessageId, rendered.text, {
            parseMode: rendered.parseMode,
            fallbackText: rendered.fallbackText,
            replyMarkup: abortKeyboard,
          });
        }
        lastProgressText = rendered.text;
        lastRenderedText = rendered.text;
        lastProgressEditAt = Date.now();
        lastEditAt = lastProgressEditAt;
      } finally {
        progressUpdateInFlight = false;
        if (pendingProgress && !progressTimer) {
          const next = pendingProgress;
          pendingProgress = undefined;
          void sendProgressUpdate(next).catch((error) => {
            console.error("Failed to send queued progress update", error);
          });
        }
      }
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const deliverFinalMarkdown = async (markdown: string): Promise<void> => {
      await deliverRenderedChunks(splitMarkdownForTelegram(markdown));
    };

    const deliverIntermediateAssistantText = async (): Promise<void> => {
      const text = accumulatedText.trim();
      accumulatedText = "";
      pendingStreamText = "";
      if (!text || progressDelivery === "none") {
        return;
      }

      if (progressDelivery === "messages") {
        await deliverFinalMarkdown(text);
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      clearFlushTimer();
      clearProgressTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      lastAssistantReply.set(contextKey, buildFinalResponseText(accumulatedText));
      const finalUndeliveredText = buildFinalResponseText(pendingStreamText);
      if (finalUndeliveredText) {
        pendingStreamText = "";
        if (progressDelivery === "edit" && responseMessageId && !sentResponseText) {
          const completed = renderProgressCompletedMessage();
          await safeEditMessage(bot, chatId, responseMessageId, completed.text, {
            parseMode: completed.parseMode,
            fallbackText: completed.fallbackText,
            replyMarkup: new InlineKeyboard(),
          }).catch((error) => {
            console.error("Failed to complete progress message", error);
          });
        }
        await deliverFinalMarkdown(finalUndeliveredText);
        sentResponseText = true;
      }

      if (!sentResponseText) {
        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return;
      }

    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        pendingStreamText += delta;
        if (streamAssistantText) {
          scheduleFlush();
        }
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        if (streamAssistantText && pendingStreamText.trim()) {
          void flushResponse(true).catch((error) => {
            console.error("Failed to flush assistant progress before tool start", error);
          });
        } else if (!streamAssistantText && pendingStreamText.trim()) {
          void deliverIntermediateAssistantText().catch((error) => {
            console.error("Failed to deliver assistant progress before tool start", error);
          });
        }

        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex is not authenticated.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "Use /login to start authentication, or set CODEX_API_KEY on the host.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex is not authenticated.",
              "",
              authStatus.detail,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      const promptInput = userInputHasOutputInstructions(userInput)
        ? userInput
        : await (async (): Promise<CodexPromptInput> => {
            const turnId = randomUUID().slice(0, 12);
            autoArtifactOutDir = outboxPath(session.getCurrentWorkspace(), turnId);
            await ensureOutDir(autoArtifactOutDir);
            return addOutputInstructions(userInput, autoArtifactOutDir);
          })();

      await session.prompt(promptInput, callbacks);
      updateSessionMetadata(contextKey, session);
      await finalizeResponse();
    } catch (error) {
      stopTyping();
      clearFlushTimer();
      clearProgressTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        try {
          await deliverFinalMarkdown(combinedText);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      if (autoArtifactOutDir) {
        try {
          await deliverArtifacts(ctx, chatId, autoArtifactOutDir, messageThreadId);
        } catch (artifactError) {
          console.error("Failed to deliver artifacts:", artifactError);
        }
      }
      busyState.processing = false;
    }
  };

  const startUserPrompt = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionRuntime,
    userInput: CodexPromptInput,
    options: {
      setSuccessReaction?: boolean;
      onFinally?: () => Promise<void>;
    } = {},
  ): void => {
    const setSuccessReaction = options.setSuccessReaction ?? true;

    void (async () => {
      try {
        await handleUserPrompt(ctx, contextKey, chatId, session, userInput);
        if (setSuccessReaction) {
          await setReaction(ctx, "👍");
        }
      } catch (error) {
        console.error("Prompt task failed:", error);
        await clearReaction(ctx);
      } finally {
        if (options.onFinally) {
          try {
            await options.onFinally();
          } catch (cleanupError) {
            console.error("Prompt cleanup failed:", cleanupError);
          }
        }

        const queued = queuedPrompts.get(contextKey);
        if (queued) {
          queuedPrompts.delete(contextKey);
          await setReaction(queued.ctx, "👀");
          startUserPrompt(queued.ctx, contextKey, queued.chatId, queued.session, queued.userInput);
        }
      }
    })();
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error(`Failed to send artifact ${artifact.name}:`, error);
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Set <code>FASTER_WHISPER_PYTHON</code>, install <code>parakeet-coreml</code>, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Set FASTER_WHISPER_PYTHON, install parakeet-coreml, or set OPENAI_API_KEY.",
            "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Voice backends: ${joined}`,
    });
  });

  bot.command(["new", "fork"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const workspaceArg = rawText.replace(/^\/(?:new|fork)(?:@\w+)?\s*/i, "").trim();
    if (workspaceArg) {
      if (/^(?:choose|list|workspace|workspaces)$/i.test(workspaceArg)) {
        await showWorkspacePicker(ctx, contextKey, session);
        return;
      }

      await createNewThreadFromWorkspaceText(ctx, workspaceArg);
      return;
    }

    try {
      const info = await session.newThread(session.getCurrentWorkspace());
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  const showWorkspacePicker = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionRuntime,
  ): Promise<void> => {
    const workspaces = session.listWorkspaces();
    if (workspaces.length === 0) {
      await safeReply(ctx, escapeHTML("No known workspaces found. Use /new to start in the current workspace."), {
        fallbackText: "No known workspaces found. Use /new to start in the current workspace.",
      });
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");
    const selectionMessage = renderWorkspaceSelectionMessage(workspaces, currentWorkspace, config.workspace);

    await safeReply(ctx, selectionMessage.html, {
      fallbackText: selectionMessage.plain,
      replyMarkup: keyboard,
    });
  };

  bot.command(["workspaces", "workspace"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    await showWorkspacePicker(ctx, contextKey, session);
  });

  const createNewThreadFromWorkspaceText = async (ctx: Context, rawWorkspace: string): Promise<boolean> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return true;
    }

    const workspaces = session.listWorkspaces();
    const workspace = resolveWorkspaceArgument(rawWorkspace, workspaces, config.workspace);
    if (!workspace) {
      const selectionMessage = renderWorkspaceSelectionMessage(workspaces, session.getCurrentWorkspace(), config.workspace);
      await safeReply(ctx, selectionMessage.html, { fallbackText: selectionMessage.plain });
      return true;
    }

    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }

    return true;
  };

  bot.command(["abort", "stop"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    try {
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("steer", async (ctx) => {
    const prompt = getCommandArgument(ctx);
    if (!prompt) {
      await safeReply(ctx, escapeHTML("Usage: /steer <instruction>"), {
        fallbackText: "Usage: /steer <instruction>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    if (!session.steer) {
      await safeReply(ctx, escapeHTML("Native steering requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native steering requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.steer(prompt);
      await safeReply(ctx, escapeHTML("Steer sent."), { fallbackText: "Steer sent." });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("forkthread", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot fork while a prompt is running."), {
        fallbackText: "Cannot fork while a prompt is running.",
      });
      return;
    }

    if (!session.forkThread) {
      await safeReply(ctx, escapeHTML("Native thread fork requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread fork requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      const info = await session.forkThread();
      updateSessionMetadata(contextKey, session);
      const plain = `Forked thread.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Forked thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("renamethread", async (ctx) => {
    const name = getCommandArgument(ctx).trim();
    if (!name) {
      await safeReply(ctx, escapeHTML("Usage: /renamethread <name>"), {
        fallbackText: "Usage: /renamethread <name>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot rename while a prompt is running."), {
        fallbackText: "Cannot rename while a prompt is running.",
      });
      return;
    }

    if (!session.renameThread) {
      await safeReply(ctx, escapeHTML("Native thread rename requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread rename requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.renameThread(name);
      await safeReply(ctx, escapeHTML("Thread renamed."), { fallbackText: "Thread renamed." });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("rollbackthread", async (ctx) => {
    const rawCount = getCommandArgument(ctx).trim() || "1";
    const turnCount = Number(rawCount);
    if (!Number.isInteger(turnCount) || turnCount < 1) {
      await safeReply(ctx, escapeHTML("Usage: /rollbackthread <turn-count>"), {
        fallbackText: "Usage: /rollbackthread <turn-count>",
      });
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot roll back while a prompt is running."), {
        fallbackText: "Cannot roll back while a prompt is running.",
      });
      return;
    }

    if (!session.rollbackThread) {
      await safeReply(ctx, escapeHTML("Native thread rollback requires the app-server backend. The live backend is still SDK."), {
        fallbackText: "Native thread rollback requires the app-server backend. The live backend is still SDK.",
      });
      return;
    }

    try {
      await session.rollbackThread(turnCount);
      await safeReply(ctx, escapeHTML(`Rolled back ${turnCount} turn${turnCount === 1 ? "" : "s"}. File changes were not reverted.`), {
        fallbackText: `Rolled back ${turnCount} turn${turnCount === 1 ? "" : "s"}. File changes were not reverted.`,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, cached);
  });

  bot.command("copy", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const reply = lastAssistantReply.get(contextKey);
    if (!reply) {
      await safeReply(ctx, escapeHTML("No assistant reply has been captured for this context yet."), {
        fallbackText: "No assistant reply has been captured for this context yet.",
      });
      return;
    }

    const rendered = formatMarkdownMessage(reply);
    await safeReply(ctx, rendered.text, {
      parseMode: rendered.parseMode,
      fallbackText: rendered.fallbackText,
    });
  });

  bot.command("clear", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot clear while a prompt is running. Use /stop first."), {
        fallbackText: "Cannot clear while a prompt is running. Use /stop first.",
      });
      return;
    }

    registry.remove(contextKey);
    await safeReply(ctx, escapeHTML("Cleared this Telegram context. The next message will start a fresh Codex thread."), {
      fallbackText: "Cleared this Telegram context. The next message will start a fresh Codex thread.",
    });
  });

  bot.command(["session", "status"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("usage", async (ctx) => {
    try {
      const plain = renderUsagePlain(await readLatestCodexUsage());
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } catch (error) {
      const message = `Failed to read usage: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
    }
  });

  bot.command(["appserver", "appserverstatus", "appserver_status"], async (ctx) => {
    const result = await probeCodexAppServer(config);
    const plain = renderAppServerProbePlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appserverturn", "apprun"], async (ctx) => {
    const prompt = getCommandArgument(ctx);
    if (!prompt) {
      const plain = "Usage: /appserverturn <prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    await safeReply(ctx, escapeHTML("Running isolated app-server turn..."), {
      fallbackText: "Running isolated app-server turn...",
    });
    const result = await runCodexAppServerTurn(config, prompt);
    const plain = renderAppServerTurnPlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appserversteer", "appsteer"], async (ctx) => {
    const raw = getCommandArgument(ctx);
    const separator = raw.indexOf("||");
    if (separator === -1) {
      const plain = "Usage: /appserversteer <initial prompt> || <steer prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const initialPrompt = raw.slice(0, separator).trim();
    const steerPrompt = raw.slice(separator + 2).trim();
    if (!initialPrompt || !steerPrompt) {
      const plain = "Usage: /appserversteer <initial prompt> || <steer prompt>";
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    await safeReply(ctx, escapeHTML("Running isolated app-server steer test..."), {
      fallbackText: "Running isolated app-server steer test...",
    });
    const result = await runCodexAppServerSteeredTurn(config, initialPrompt, steerPrompt);
    const plain = renderAppServerSteerPlain(result);
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["appbackendtest", "appsmoke"], async (ctx) => {
    await safeReply(ctx, escapeHTML("Running app-server backend smoke test..."), {
      fallbackText: "Running app-server backend smoke test...",
    });

    const startedAt = Date.now();
    const steps: string[] = [];
    let session: CodexSessionRuntime | undefined;
    try {
      session = await createCodexSession(
        { ...config, codexBackend: "app-server" },
        { deferThreadStart: true, workspace: config.workspace, model: config.codexModel },
      );
      steps.push("created backend runtime");

      const info = await session.newThread(config.workspace, config.codexModel);
      steps.push(`started thread ${info.threadId ?? "(unknown)"}`);

      const firstReply = (await session.runText("Reply with exactly OK.")).trim();
      steps.push(`prompt returned ${firstReply || "(empty)"}`);
      if (normalizeSmokeReply(firstReply) !== "OK") {
        throw new Error(`Expected OK from first prompt, got ${firstReply || "(empty)"}`);
      }

      if (session.renameThread) {
        await session.renameThread(`TeleCodex smoke ${new Date().toISOString()}`);
        steps.push("renamed thread");
      }

      if (session.forkThread) {
        const forked = await session.forkThread();
        steps.push(`forked thread ${forked.threadId ?? "(unknown)"}`);
        const forkReply = (await session.runText("Reply with exactly FORK_OK.")).trim();
        steps.push(`fork prompt returned ${forkReply || "(empty)"}`);
        if (normalizeSmokeReply(forkReply) !== "FORK_OK") {
          throw new Error(`Expected FORK_OK from fork prompt, got ${forkReply || "(empty)"}`);
        }
      }

      if (session.rollbackThread) {
        await session.rollbackThread(1);
        steps.push("rolled back one turn");
      }

      const plain = [
        "App-server backend smoke test:",
        `Status: ok`,
        `Duration: ${Date.now() - startedAt} ms`,
        "",
        ...steps.map((step) => `- ${step}`),
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } catch (error) {
      const plain = [
        "App-server backend smoke test:",
        "Status: failed",
        `Duration: ${Date.now() - startedAt} ms`,
        `Error: ${friendlyErrorText(error)}`,
        "",
        ...steps.map((step) => `- ${step}`),
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
    } finally {
      session?.dispose();
    }
  });

  bot.command(["artifacttest", "filetest"], async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    if (!contextKey || !chatId) {
      return;
    }

    const turnId = `artifacttest-${randomUUID().slice(0, 8)}`;
    const session = registry.get(contextKey);
    const workspace = session?.getCurrentWorkspace() ?? config.workspace;
    const outDir = outboxPath(workspace, turnId);
    const filePath = path.join(outDir, "telecodex-artifact-test.txt");
    const content = [
      "TeleCodex artifact delivery test",
      `Created: ${new Date().toISOString()}`,
      `Backend: ${registry.getBackend(contextKey)}`,
      `Workspace: ${workspace}`,
      "",
      "If this file arrived in Telegram, generated artifact delivery is working.",
    ].join("\n");

    try {
      await ensureOutDir(outDir);
      await writeFile(filePath, content, "utf8");
      await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
    } catch (error) {
      const plain = `Artifact test failed: ${friendlyErrorText(error)}`;
      await safeReply(ctx, escapeHTML(plain), { fallbackText: plain });
    }
  });

  bot.command("backend", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const rawBackend = getCommandArgument(ctx);
    if (!rawBackend) {
      const current = registry.getBackend(contextKey);
      const plain = [
        `Backend for this Telegram context: ${current}`,
        "",
        "Available: sdk, app-server",
        "",
        "Use /backend sdk to force the safe SDK backend.",
        "Use /backend appserver to switch this context to app-server.",
        "The choice persists for this Telegram context across restarts.",
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const requestedBackend = resolveBackendArgument(rawBackend);
    if (!requestedBackend) {
      await safeReply(ctx, escapeHTML("Usage: /backend sdk or /backend appserver"), {
        fallbackText: "Usage: /backend sdk or /backend appserver",
      });
      return;
    }

    const activeSession = registry.get(contextKey);
    if (activeSession?.isProcessing()) {
      await safeReply(ctx, escapeHTML("Cannot switch backend while a prompt is running. Use /abort first if it is stuck."), {
        fallbackText: "Cannot switch backend while a prompt is running. Use /abort first if it is stuck.",
      });
      return;
    }

    if (requestedBackend === "app-server") {
      await safeReply(ctx, escapeHTML("Checking app-server before switching..."), {
        fallbackText: "Checking app-server before switching...",
      });
      const probe = await probeCodexAppServer(config);
      if (!probe.ok) {
        const plain = [
          "App-server probe failed. Backend was not changed.",
          `Error: ${probe.error}`,
          "",
          "Use /backend sdk to stay on the safe backend.",
        ].join("\n");
        await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
        return;
      }
    }

    registry.setBackend(contextKey, requestedBackend);
    queuedPrompts.delete(contextKey);
    const busyState = getBusyState(contextKey);
    busyState.processing = false;
    busyState.switching = false;
    busyState.transcribing = false;

    const plain =
      requestedBackend === "app-server"
        ? "Backend for this Telegram context is now app-server. This persists across restarts. Use /backend sdk to switch back."
        : "Backend for this Telegram context is now sdk. This persists across restarts.";
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  bot.command(["verbosity", "velocity", "progress"], async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const rawMode = getCommandArgument(ctx);
    if (!rawMode) {
      const current = registry.getProgressDelivery(contextKey);
      const plain = [
        `Message verbosity for this Telegram context: ${current}`,
        "",
        "Use /verbosity messages for separate progress messages.",
        "Use /verbosity edit for one edited progress message.",
        "Use /verbosity none for final answers only.",
      ].join("\n");
      await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
      return;
    }

    const requested = resolveVerbosityArgument(rawMode);
    if (!requested) {
      await safeReply(ctx, escapeHTML("Usage: /verbosity messages, /verbosity edit, or /verbosity none"), {
        fallbackText: "Usage: /verbosity messages, /verbosity edit, or /verbosity none",
      });
      return;
    }

    registry.setProgressDelivery(contextKey, requested);
    const plain = [
      `Message verbosity set to ${requested}.`,
      requested === "messages"
        ? "I will send separate progress messages and keep the final answer clean."
        : requested === "edit"
          ? "I will keep one progress message updated, then send the final answer separately."
          : "I will send only the final answer unless there is an error.",
    ].join("\n");
    await safeReply(ctx, formatTelegramHTML(plain), { fallbackText: plain });
  });

  const setLaunchProfileFromCommand = async (ctx: Context, rawProfile: string): Promise<boolean> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return true;
    }

    const wantsConfirm = /\bconfirm\b/i.test(rawProfile);
    const requested = rawProfile.replace(/\bconfirm\b/gi, "").trim().toLowerCase();
    const profile = config.launchProfiles.find(
      (candidate) =>
        candidate.id.toLowerCase() === requested ||
        candidate.label.toLowerCase() === requested ||
        candidate.label.toLowerCase().replace(/\s+/g, "-") === requested,
    );

    if (!profile) {
      const available = config.launchProfiles.map((candidate) => candidate.id).join(", ");
      await safeReply(ctx, escapeHTML(`Usage: /launch_profiles <${available}>`), {
        fallbackText: `Usage: /launch_profiles <${available}>`,
      });
      return true;
    }

    if (profile.unsafe && !wantsConfirm) {
      const text = `Profile ${profile.label} uses danger-full-access. Send /launch_profiles ${profile.id} confirm to select it.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return true;
    }

    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    const text = `Launch profile set to ${selectedProfile.label} (${formatLaunchProfileBehavior(selectedProfile)}). It applies to new or reattached threads.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    return true;
  };

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const profileArg = rawText.replace(/^\/(?:launch|launch_profiles)(?:@\w+)?\s*/i, "").trim();
    if (profileArg) {
      await setLaunchProfileFromCommand(ctx, profileArg);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedLaunchProfile))}</code>`,
      "",
      "Select a profile for new or reattached threads:",
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedLaunchProfile)}`,
      "",
      "Select a profile for new or reattached threads:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);
  bot.hears(/^(?:launch|launch_profiles|launch profile)\s+(.+)/i, async (ctx) => {
    await setLaunchProfileFromCommand(ctx, ctx.match[1] ?? "");
  });

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        "🔄 Thread handed back to Codex CLI.",
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        "<b>🔄 Thread handed back to Codex CLI.</b>",
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new TeleCodex thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    if (threadId.toLowerCase() !== "latest" && !getThread(threadId) && !getThreadByPrefix(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown Codex thread: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown Codex thread: ${threadId}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached to thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached to thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch", "use"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadArg = rawText.replace(/^\/(?:sessions|switch|use)(?:@\w+)?\s*/, "").trim();
    const threadId = resolveSessionSelectionArgument(threadArg, pendingSessionPicks.get(contextKey));

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info)}`;
        const plain = `Switched thread.\n\n${renderSessionInfoPlain(info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50);
    if (sessions.length === 0) {
      await safeReply(ctx, escapeHTML("No recent threads found."), {
        fallbackText: "No recent threads found.",
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");
    const numberedPlain = orderedSessions
      .map((listedSession, index) => {
        const active = listedSession.id === activeThreadId ? " active" : "";
        const title = listedSession.title || listedSession.firstUserMessage || "(untitled)";
        return `${index + 1}. ${getWorkspaceShortName(listedSession.cwd)} - ${trimLine(title, 48)} - ${formatRelativeTime(listedSession.updatedAt)}${active}`;
      })
      .join("\n");
    const numberedHtml = orderedSessions
      .map((listedSession, index) => {
        const active = listedSession.id === activeThreadId ? " <i>active</i>" : "";
        const title = listedSession.title || listedSession.firstUserMessage || "(untitled)";
        return `${index + 1}. <code>${escapeHTML(getWorkspaceShortName(listedSession.cwd))}</code> - ${escapeHTML(trimLine(title, 48))} - ${escapeHTML(formatRelativeTime(listedSession.updatedAt))}${active}`;
      })
      .join("\n");

    await safeReply(ctx, `<b>Recent threads</b> (${orderedSessions.length}):\nSend <code>/use 1</code> or tap to switch.\n\n${numberedHtml}`, {
      fallbackText: `Recent threads (${orderedSessions.length}):\nSend /use 1 or tap to switch.\n\n${numberedPlain}`,
      replyMarkup: keyboard,
    });
  });

  bot.hears(/^(?:use|switch)\s+(.+)/i, async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const threadId = resolveSessionSelectionArgument(ctx.match[1] ?? "", pendingSessionPicks.get(contextKey));
    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: use <number|thread-id|latest>"), {
        fallbackText: "Usage: use <number|thread-id|latest>",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Switched thread.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Switched thread.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.hears(/^(?:fork|new thread)\s+(.+)/i, async (ctx) => {
    await createNewThreadFromWorkspaceText(ctx, ctx.match[1] ?? "");
  });

  bot.hears(/^(?:workspace|ws)\s+(.+)/i, async (ctx) => {
    await createNewThreadFromWorkspaceText(ctx, ctx.match[1] ?? "");
  });

  bot.hears(/^new\s+(?!from summary$)(.+)/i, async (ctx) => {
    await createNewThreadFromWorkspaceText(ctx, ctx.match[1] ?? "");
  });

  const createNewFromSummary = async (ctx: Context, rawWorkspace?: string): Promise<void> => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a summary thread while a prompt is running."), {
        fallbackText: "Cannot create a summary thread while a prompt is running.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to summarize yet."), {
        fallbackText: "No active thread to summarize yet.",
      });
      return;
    }

    let targetWorkspace: string | undefined;
    const workspaceArg = rawWorkspace?.trim();
    if (workspaceArg) {
      const workspaces = session.listWorkspaces();
      targetWorkspace = resolveWorkspaceArgument(workspaceArg, workspaces, config.workspace) ?? undefined;
      if (!targetWorkspace) {
        const selectionMessage = renderWorkspaceSelectionMessage(workspaces, session.getCurrentWorkspace(), config.workspace);
        await safeReply(ctx, selectionMessage.html, { fallbackText: selectionMessage.plain });
        return;
      }
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Codex is not authenticated. Use /login first."), {
        fallbackText: "Codex is not authenticated. Use /login first.",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      await safeReply(ctx, escapeHTML("Creating handoff summary..."), {
        fallbackText: "Creating handoff summary...",
      });
      const summary = (await session.runText(NEW_FROM_SUMMARY_PROMPT)).trim();
      if (!summary) {
        throw new Error("Summary generation returned empty text");
      }

      const startMessage = targetWorkspace
        ? `Starting new thread from summary in ${targetWorkspace}...`
        : "Starting new thread from summary...";
      await safeReply(ctx, escapeHTML(startMessage), {
        fallbackText: startMessage,
      });
      await session.newThread(targetWorkspace);
      const seedPrompt = [
        "You are continuing from a previous Codex session.",
        "Treat the following handoff summary as the starting context for this new thread.",
        "Do not redo work unless asked. Reply only: Summary loaded.",
        "",
        summary,
      ].join("\n");
      await session.runText(seedPrompt);
      updateSessionMetadata(contextKey, session);

      const info = session.getInfo();
      const plain = [`New thread created from summary.`, "", renderSessionInfoPlain(info), "", "Summary:", summary].join("\n");
      const html = [
        "<b>New thread created from summary.</b>",
        "",
        renderSessionInfoHTML(info),
        "",
        "<b>Summary:</b>",
        escapeHTML(summary),
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  };

  bot.command("newsummary", async (ctx) => createNewFromSummary(ctx, getCommandArgument(ctx)));
  bot.hears(/^new from summary$/i, async (ctx) => createNewFromSummary(ctx));
  bot.hears(/^new from summary\s+(.+)/i, async (ctx) => createNewFromSummary(ctx, ctx.match[1] ?? ""));

  bot.command("history", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    const threadId = session.getInfo().threadId;
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No Codex thread is selected here yet. Use /use latest or send a prompt first."), {
        fallbackText: "No Codex thread is selected here yet. Use /use latest or send a prompt first.",
      });
      return;
    }

    const messages = readThreadHistory(threadId, 8);
    if (messages.length === 0) {
      await safeReply(ctx, escapeHTML("No local history entries found for this thread."), {
        fallbackText: "No local history entries found for this thread.",
      });
      return;
    }

    const plain = messages
      .map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${truncateForHistory(message.text)}`;
      })
      .join("\n\n");
    const html = messages
      .map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `<b>${role}:</b> ${escapeHTML(truncateForHistory(message.text))}`;
      })
      .join("\n\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const modelArg = rawText.replace(/^\/model(?:@\w+)?\s*/i, "").trim();
    if (modelArg) {
      const slug = resolveModelSlug(modelArg, models);
      if (!slug) {
        const available = models.map((m) => m.slug).join(", ");
        const text = `Unknown model "${modelArg}". Available: ${available}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }
      try {
        session.setModel(slug);
        updateSessionMetadata(contextKey, session);
        const text = `Model set to ${slug}. It applies from the next turn in this context.`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${formatModelButtonLabel(model.displayName)}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.hears(/^model\s+(.+)/i, async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const modelArg = (ctx.match[1] ?? "").trim();
    const models = session.listModels();
    const slug = resolveModelSlug(modelArg, models);
    if (!slug) {
      const available = models.map((m) => m.slug).join(", ");
      const text = `Unknown model "${modelArg}". Available: ${available}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    try {
      session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const text = `Model set to ${slug}. It applies from the next turn in this context.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  const setEffortFromCommand = async (ctx: Context, effortText: string): Promise<boolean> => {
    const normalized = effortText.trim().toLowerCase();
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    if (!efforts.includes(normalized as ModelReasoningEffort)) {
      await safeReply(ctx, escapeHTML("Usage: /effort minimal|low|medium|high|xhigh"), {
        fallbackText: "Usage: /effort minimal|low|medium|high|xhigh",
      });
      return true;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return true;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change effort while a prompt is running."), {
        fallbackText: "Cannot change effort while a prompt is running.",
      });
      return true;
    }

    session.setReasoningEffort(normalized as ModelReasoningEffort);
    updateSessionMetadata(contextKey, session);
    const text = `Reasoning effort set to ${normalized}. It applies from the next turn in this context.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    return true;
  };

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const effortArg = rawText.replace(/^\/effort(?:@\w+)?\s*/i, "").trim();
    if (effortArg) {
      await setEffortFromCommand(ctx, effortArg);
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new threads:`
      : "<b>Reasoning effort:</b> not set (model default)\n\nSelect for new threads:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.hears(/^effort\s+(\S+)/i, async (ctx) => {
    await setEffortFromCommand(ctx, ctx.match[1] ?? "");
  });

  bot.command([...NATIVE_CODEX_COMMANDS], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text?.trim();
    if (!chatId || !text) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const commandName = text.match(/^\/([a-zA-Z0-9_]+)/)?.[1]?.toLowerCase();
    if (commandName === "compact" && session.compactThread) {
      try {
        await session.compactThread();
        await safeReply(ctx, escapeHTML("App-server compaction started."), {
          fallbackText: "App-server compaction started.",
        });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    startUserPrompt(ctx, contextKey, chatId, session, text, { setSuccessReaction: false });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await session.abort();
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${formatLaunchProfileBehavior(profile)}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Launch set to ${selectedProfile.label}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(formatLaunchProfileBehavior(selectedProfile))}</code>`,
      "",
      "⚠️ <i>danger-full-access confirmed for new or reattached threads.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Behavior: ${formatLaunchProfileBehavior(selectedProfile)}`,
      "",
      "danger-full-access confirmed for new or reattached threads.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new threads.`;
      const plainText = `Model set to ${model} — applies to new threads.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as ModelReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /effort again" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort set to <code>${escapeHTML(effort)}</code> — applies to new threads.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort set to ${effort} — applies to new threads.`,
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (/^\d+$/.test(userText) && pendingWorkspacePicks.has(contextKey)) {
      await createNewThreadFromWorkspaceText(ctx, userText);
      return;
    }

    if (isBusy(contextKey)) {
      lastPromptInput.set(contextKey, userText);
      await queuePromptReply(ctx, contextKey, ctx.chat.id, session, userText);
      return;
    }

    lastPromptInput.set(contextKey, userText);
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      // Forward voice notes as prompts without a separate transcription echo.
    } catch (error) {
      const note = "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    lastPromptInput.set(contextKey, transcript);
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, transcript);
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, promptInput, {
      onFinally: async () => {
        await unlink(tempFilePath).catch(() => {});
      },
    });
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    await setReaction(ctx, "👀");
    startUserPrompt(ctx, contextKey, chatId, session, promptInput, {
      onFinally: async () => {
        try {
          await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
        } catch (artifactError) {
          console.error("Failed to deliver artifacts:", artifactError);
        } finally {
          await cleanupInbox(workspace, turnId);
          // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
        }
      },
    });
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "new", description: "Start in current workspace" },
    { command: "fork", description: "Start in current workspace" },
    { command: "workspaces", description: "Choose workspace for new thread" },
    { command: "newsummary", description: "Start a new thread from summary" },
    { command: "forkthread", description: "Fork active app-server thread" },
    { command: "renamethread", description: "Rename active app-server thread" },
    { command: "rollbackthread", description: "Roll back app-server thread history" },
    { command: "session", description: "Current thread details" },
    { command: "status", description: "Current thread details" },
    { command: "usage", description: "Codex limits & reset times" },
    { command: "backend", description: "Show or reset backend" },
    { command: "verbosity", description: "Set message verbosity" },
    { command: "appserver", description: "Probe Codex app-server" },
    { command: "appserverturn", description: "Run isolated app-server turn" },
    { command: "appserversteer", description: "Run isolated app-server steer test" },
    { command: "appbackendtest", description: "Smoke-test app-server backend" },
    { command: "artifacttest", description: "Send a generated test file" },
    { command: "sessions", description: "Browse & switch threads" },
    { command: "history", description: "Show recent local thread history" },
    { command: "use", description: "Switch to a thread by ID or latest" },
    { command: "compact", description: "Ask Codex to compact this thread" },
    { command: "clear", description: "Forget this Telegram context" },
    { command: "copy", description: "Re-send last assistant reply" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "abort", description: "Cancel current operation" },
    { command: "stop", description: "Cancel current operation" },
    { command: "steer", description: "Steer active app-server turn" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "model", description: "View & change model" },
    { command: "effort", description: "Set reasoning effort" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "handback", description: "Hand thread to Codex CLI" },
    { command: "attach", description: "Bind a Codex thread to this topic" },
    { command: "switch", description: "Switch to a thread by ID" },
  ]);
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `Thread ID: ${info.threadId ?? "(not started yet)"}`,
    `Workspace: ${info.workspace}`,
    `Launch profile: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${info.nextLaunchProfileBehavior})${info.nextUnsafeLaunch ? " [unsafe]" : ""}`
      : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>Thread ID:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(info.workspace)}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Launch behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(info.nextLaunchProfileBehavior ?? "")})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderAppServerProbePlain(result: AppServerProbeResult): string {
  const lines = [
    "Codex app-server probe:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Server: ${result.userAgent}`,
      `Codex home: ${result.codexHome}`,
      `Platform: ${result.platform}`,
      `Models returned: ${result.modelCount}${result.modelNames.length ? ` (${result.modelNames.join(", ")})` : ""}`,
      `Threads returned: ${result.threadCount}${result.threadIds.length ? ` (${result.threadIds.join(", ")})` : ""}`,
    );
  }

  lines.push(
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderAppServerTurnPlain(result: AppServerTurnResult): string {
  const lines = [
    "Codex app-server isolated turn:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Thread: ${result.threadId}`,
      `Turn: ${result.turnId}`,
      "",
      "Final response:",
      result.finalText || "(empty)",
    );
  }

  lines.push(
    "",
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Completed item types: ${result.itemTypes.length ? result.itemTypes.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderAppServerSteerPlain(result: AppServerSteerResult): string {
  const lines = [
    "Codex app-server isolated steer:",
    `Backend setting: ${result.backend}`,
    `Duration: ${result.durationMs} ms`,
    `Steer delay: ${result.steerDelayMs} ms`,
  ];

  if (!result.ok) {
    lines.push(`Status: failed`, `Error: ${result.error}`);
  } else {
    lines.push(
      "Status: ok",
      `Thread: ${result.threadId}`,
      `Turn: ${result.turnId}`,
      `Steer accepted for turn: ${result.steerTurnId}`,
      "",
      "Final response:",
      result.finalText || "(empty)",
    );
  }

  lines.push(
    "",
    `Notifications seen: ${result.notifications.length ? result.notifications.join(", ") : "none"}`,
    `Completed item types: ${result.itemTypes.length ? result.itemTypes.join(", ") : "none"}`,
    `Assistant text delta opt-out: ${result.optOutNotificationMethods.join(", ")}`,
  );

  return lines.join("\n");
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

export function renderSummaryProgressMessage(toolName: string, toolCounts: Map<string, number>): RenderedText {
  const summaryLine = formatToolSummaryLine(toolCounts);
  const htmlLines = [`<b>Working:</b> <code>${escapeHTML(trimProgressToolName(toolName))}</code>`];
  const plainLines = [`Working: ${trimProgressToolName(toolName)}`];

  if (summaryLine) {
    htmlLines.push(escapeHTML(summaryLine));
    plainLines.push(summaryLine);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function renderProgressCompletedMessage(): RenderedText {
  return {
    text: "<b>Completed.</b>",
    fallbackText: "Completed.",
    parseMode: "HTML",
  };
}

function trimProgressToolName(toolName: string): string {
  const singleLine = toolName.replace(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 119)}...`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `in: ${tokens.input} · cached: ${tokens.cached} · out: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  const blocks = markdown.split(/(\n\s*\n)/);
  let current = "";

  const pushCurrent = (): void => {
    const text = current.trim();
    if (text) {
      chunks.push(renderMarkdownChunkWithinLimit(text));
    }
    current = "";
  };

  for (const block of blocks) {
    if (!block) {
      continue;
    }

    const candidate = current ? `${current}${block}` : block;
    const renderedCandidate = formatMarkdownMessage(candidate.trim());
    if (candidate.length <= TELEGRAM_MESSAGE_LIMIT && renderedCandidate.text.length <= TELEGRAM_MESSAGE_LIMIT) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushCurrent();
    }

    if (block.length > TELEGRAM_MESSAGE_LIMIT || formatMarkdownMessage(block.trim()).text.length > TELEGRAM_MESSAGE_LIMIT) {
      let remaining = block.trim();
      while (remaining) {
        const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
        const initialCut = findPreferredSplitIndex(remaining, maxLength);
        const candidatePart = remaining.slice(0, initialCut) || remaining.slice(0, 1);
        const rendered = renderMarkdownChunkWithinLimit(candidatePart);
        chunks.push(rendered);
        remaining = remaining.slice(rendered.sourceText.length).trimStart();
      }
    } else {
      current = block;
    }
  }

  pushCurrent();
  return chunks;
}

function shouldHoldFinalResponse(input: CodexPromptInput): boolean {
  const text = getPromptText(input).toLowerCase();
  if (!text) {
    return false;
  }

  return (
    /\bhand[-\s]?off\b/.test(text) ||
    /\b(single|one)\s+(telegram\s+)?message\b/.test(text) ||
    /\b(do not|don't|dont)\s+split\b/.test(text) ||
    /\b(no\s+split|one\s+piece)\b/.test(text)
  );
}

function getPromptText(input: CodexPromptInput): string {
  if (typeof input === "string") {
    return input;
  }

  return [input.text, input.stagedFileInstructions].filter((part): part is string => Boolean(part)).join("\n");
}

function userInputHasOutputInstructions(input: CodexPromptInput): boolean {
  return typeof input === "object" && Boolean(input.stagedFileInstructions);
}

function addOutputInstructions(input: CodexPromptInput, outDir: string): CodexPromptInput {
  const stagedFileInstructions = `Output files: write any files the user should receive to ${outDir}`;
  if (typeof input === "string") {
    return { text: input, stagedFileInstructions };
  }

  return {
    ...input,
    stagedFileInstructions,
  };
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function truncateForHistory(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 900 ? normalized : `${normalized.slice(0, 899)}â€¦`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function renderWorkspaceSelectionMessage(
  workspaces: string[],
  currentWorkspace: string,
  defaultWorkspace?: string,
): { html: string; plain: string } {
  const plainList = workspaces
    .map((workspace, index) => {
      const labels = workspaceLabels(workspace, currentWorkspace, defaultWorkspace);
      const suffix = labels.length > 0 ? ` ${labels.join(", ")}` : "";
      return `${index + 1}. ${getWorkspaceShortName(workspace)} - ${workspace}${suffix}`;
    })
    .join("\n");
  const htmlList = workspaces
    .map((workspace, index) => {
      const labels = workspaceLabels(workspace, currentWorkspace, defaultWorkspace)
        .map((label) => `<i>${escapeHTML(label)}</i>`)
        .join(", ");
      const suffix = labels ? ` ${labels}` : "";
      return `${index + 1}. <code>${escapeHTML(getWorkspaceShortName(workspace))}</code> - ${escapeHTML(workspace)}${suffix}`;
    })
    .join("\n");

  return {
    html: `<b>Select workspace for new thread:</b>\nSend <code>/new 1</code>, <code>/new default</code>, or <code>workspace 1</code>.\n\n${htmlList}`,
    plain: `Select workspace for new thread:\nSend /new 1, /new default, or workspace 1.\n\n${plainList}`,
  };
}

function resolveWorkspaceArgument(raw: string, workspaces: string[], defaultWorkspace?: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) {
    return null;
  }

  const numeric = Number.parseInt(value, 10);
  if (/^\d+$/.test(value)) {
    return numeric >= 1 && numeric <= workspaces.length ? workspaces[numeric - 1] ?? null : null;
  }

  const lower = value.toLowerCase();
  if (defaultWorkspace && /^(?:default|configured|config|home)$/.test(lower)) {
    return defaultWorkspace;
  }

  return (
    workspaces.find((workspace) => workspace === value) ??
    workspaces.find((workspace) => getWorkspaceShortName(workspace).toLowerCase() === lower) ??
    value
  );
}

function workspaceLabels(workspace: string, currentWorkspace: string, defaultWorkspace?: string): string[] {
  const labels: string[] = [];
  if (sameWorkspace(workspace, currentWorkspace)) {
    labels.push("current");
  }
  if (defaultWorkspace && sameWorkspace(workspace, defaultWorkspace)) {
    labels.push("default");
  }
  return labels;
}

function sameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function resolveSessionSelectionArgument(raw: string, pendingThreadIds?: string[]): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }

  const numeric = Number.parseInt(value, 10);
  if (/^\d+$/.test(value) && pendingThreadIds && numeric >= 1 && numeric <= pendingThreadIds.length) {
    return pendingThreadIds[numeric - 1] ?? value;
  }

  return value;
}

function formatModelButtonLabel(displayName: string): string {
  return displayName.replace(/^GPT[- ]?/i, "").replace(/^gpt[- ]?/i, "");
}

function resolveModelSlug(raw: string, models: Array<{ slug: string; displayName: string }>): string | null {
  const value = raw.trim();
  const normalized = normalizeModelName(value);

  const direct = models.find(
    (model) =>
      normalizeModelName(model.slug) === normalized ||
      normalizeModelName(model.displayName) === normalized,
  );
  if (direct) {
    return direct.slug;
  }

  const withoutGpt = models.find((model) => normalizeModelName(formatModelButtonLabel(model.displayName)) === normalized);
  if (withoutGpt) {
    return withoutGpt.slug;
  }

  if (normalized === "mini") {
    const mini = models.find((model) => model.slug.toLowerCase().includes("mini"));
    if (mini) {
      return mini.slug;
    }
  }

  const dotted = models.find((model) => normalizeModelName(model.slug).endsWith(normalized));
  return dotted?.slug ?? null;
}

function getCommandArgument(ctx: Context): string {
  const text = ctx.message?.text ?? "";
  return text.replace(/^\/\S+\s*/u, "").trim();
}

function resolveBackendArgument(raw: string): CodexBackend | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "sdk":
    case "safe":
      return "sdk";
    case "appserver":
    case "app-server":
      return "app-server";
    default:
      return null;
  }
}

function resolveVerbosityArgument(raw: string): ProgressDelivery | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "none":
    case "off":
    case "quiet":
      return "none";
    case "message":
    case "messages":
    case "chat":
    case "normal":
      return "messages";
    case "edit":
    case "edited":
    case "single":
      return "edit";
    default:
      return null;
  }
}

function normalizeSmokeReply(reply: string): string {
  return reply.trim().replace(/[.!]+$/g, "").toUpperCase();
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/^gpt[- ]?/, "").replace(/\s+/g, "-");
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
