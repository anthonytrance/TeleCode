import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";
import { SessionRegistry } from "../src/session-registry.js";

const mockClaude = vi.hoisted(() => {
  const prompts: string[] = [];
  const createSession = vi.fn();
  const resumeSession = vi.fn();
  const getSessionInfo = vi.fn();
  const dispose = vi.fn();
  let createCount = 0;
  let promptGate: Promise<void> | undefined;
  let releasePromptGate: (() => void) | undefined;

  return {
    prompts,
    createSession,
    resumeSession,
    getSessionInfo,
    dispose,
    nextCreateCount: () => {
      createCount += 1;
      return createCount;
    },
    blockNextPrompt: () => {
      promptGate = new Promise<void>((resolve) => {
        releasePromptGate = resolve;
      });
    },
    releaseBlockedPrompt: () => {
      releasePromptGate?.();
      releasePromptGate = undefined;
    },
    takePromptGate: () => {
      const gate = promptGate;
      promptGate = undefined;
      return gate;
    },
    reset: () => {
      prompts.length = 0;
      createCount = 0;
      releasePromptGate?.();
      promptGate = undefined;
      releasePromptGate = undefined;
      createSession.mockReset();
      resumeSession.mockReset();
      getSessionInfo.mockReset();
      dispose.mockReset();
    },
  };
});

vi.mock("../src/providers/claude-adapter.js", () => ({
  ClaudeProviderAdapter: class {
    readonly capabilities = {
      streamingText: true,
      streamingInput: false,
      abort: true,
      fork: false,
      rename: false,
      compact: true,
      usage: true,
      context: true,
      slashCommands: true,
      permissions: false,
      userQuestions: false,
      artifacts: false,
    };

    async createSession(options: { workspace?: string; displayName?: string; metadata?: Record<string, unknown> }) {
      const createCount = mockClaude.nextCreateCount();
      const descriptor = {
        id: `claude-provider-${createCount}`,
        provider: "claude",
        workspace: options.workspace ?? "C:\\workspace",
        displayName: options.displayName,
        providerSessionId: `provider-session-${createCount}`,
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 1000,
        updatedAt: 1000,
        metadata: options.metadata,
      };
      mockClaude.createSession(options);
      return descriptor;
    }

    async resumeSession(session: unknown) {
      mockClaude.resumeSession(session);
      return session;
    }

    async getSessionInfo() {
      const descriptor = {
        id: "claude-provider-1",
        provider: "claude",
        workspace: "C:\\workspace",
        displayName: "Mock Claude",
        providerSessionId: "provider-session-1",
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 1000,
        updatedAt: 2000,
        metadata: { model: "sonnet", permissionMode: "acceptEdits" },
      };
      mockClaude.getSessionInfo();
      return descriptor;
    }

    async *sendPrompt(options: { sessionId: string; jobId: string; input: { text?: string } }) {
      const text = options.input.text ?? "";
      mockClaude.prompts.push(text);
      yield {
        type: "session_status_changed",
        sessionId: options.sessionId,
        status: "running",
      };
      const gate = mockClaude.takePromptGate();
      if (gate) {
        await gate;
      }
      yield {
        type: "assistant_text_delta",
        sessionId: options.sessionId,
        jobId: options.jobId,
        text: `mock reply to ${text}`,
      };
      yield {
        type: "usage_updated",
        sessionId: options.sessionId,
        jobId: options.jobId,
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 3,
      };
      yield {
        type: "assistant_message_complete",
        sessionId: options.sessionId,
        jobId: options.jobId,
        text: `mock reply to ${text}`,
      };
    }

    async getUsage() {
      return { contextTokens: 3 };
    }

    async getContext() {
      return { usedTokens: 3, contextWindow: 200000 };
    }

    async dispose(sessionId?: string) {
      if (sessionId === undefined) {
        mockClaude.dispose();
        return;
      }
      mockClaude.dispose(sessionId);
    }
  },
}));

vi.mock("../src/codex-backend.js", () => ({
  createCodexSession: vi.fn(() => {
    throw new Error("Codex session should not be created in Claude bot flow tests");
  }),
}));

vi.mock("../src/startup-safety.js", () => ({
  findRunningClaudeTelegramPluginProcesses: vi.fn(async () => []),
}));

import { createBot } from "../src/bot.js";

describe("Claude bot flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-bot-claude-"));
    mockClaude.reset();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can briefly keep handles open after a failed test.
    }
    vi.restoreAllMocks();
  });

  it("routes normal text to Claude after /claude switches the context", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "hello"));

    await waitFor(() => mockClaude.prompts.includes("hello"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.prompts).toEqual(["hello"]);
    expect(sent.map((entry) => entry.text)).toContain("Claude Code selected for this Telegram context. The next normal message will start or resume Claude.");
    expect(sent.map((entry) => entry.text)).toContain("mock reply to hello");
  });

  it("treats /claude with trailing text as an inline Claude prompt", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude say CANARY_OK only"));

    await waitFor(() => mockClaude.prompts.includes("say CANARY_OK only"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.prompts).toEqual(["say CANARY_OK only"]);
    expect(sent.map((entry) => entry.text)).toContain("mock reply to say CANARY_OK only");
  });

  it("delivers the Claude final answer even if Claude is backgrounded before completion", async () => {
    const { bot, sent, registry } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude long answer"));
    await waitFor(() => mockClaude.prompts.includes("long answer"));
    registry.setActiveProvider("123", "codex");
    mockClaude.releaseBlockedPrompt();

    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude Code finished in background")));

    expect(sent.map((entry) => entry.text)).toContain(
      "Claude Code finished in background: long answer\n\nmock reply to long answer",
    );
  });

  it("queues /steer as a Claude follow-up while Claude is already running", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude first task"));
    await waitFor(() => mockClaude.prompts.includes("first task"));
    await bot.handleUpdate(textUpdate(2, "/steer add this detail"));

    await waitFor(() => sent.some((entry) => entry.text?.includes("queued this /steer instruction")));
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude is still working. I queued this /steer instruction as a Claude follow-up after the current turn finishes.",
    );

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => mockClaude.prompts.some((prompt) => prompt.includes("add this detail")));

    expect(mockClaude.prompts).toEqual([
      "first task",
      "Additional instruction for the previous Claude task:\n\nadd this detail",
    ]);
  });

  it("rejects embedded slash commands before they are pasted into Claude", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "please answer this\n/exit"));

    await waitFor(() => sent.some((entry) => entry.text?.includes("contains /exit on its own line")));

    expect(mockClaude.prompts).toEqual([]);
    expect(sent.map((entry) => entry.text)).toContain(
      "I did not send this to Claude because it contains /exit on its own line.\nSend the text first, then send the command as a separate Telegram message.",
    );
  });

  it("does not resume a persisted Claude session with stale permission mode", async () => {
    const staleSessionId = "11111111-1111-4111-8111-111111111111";
    const providerStateDir = path.join(tempDir, ".telecodex", "provider-state");
    const transcriptDir = path.join(tempDir, ".claude-config", "projects", "project");
    mkdirSync(providerStateDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      path.join(providerStateDir, "claude.json"),
      JSON.stringify({
        version: 1,
        sessions: [{
          telegramContextKey: "123",
          sessionId: staleSessionId,
          workspace: tempDir,
          displayName: "Old Claude",
          model: "sonnet",
          permissionMode: "bypassPermissions",
          createdAt: 1,
          lastUsedAt: 2,
        }],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(transcriptDir, `${staleSessionId}.jsonl`),
      `${JSON.stringify({ type: "user", permissionMode: "acceptEdits" })}\n`,
      "utf8",
    );

    const { bot } = await createTestBot(tempDir, {
      claudePermissionMode: "bypassPermissions",
      claudeStrictMcpConfig: false,
    });

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    expect(mockClaude.resumeSession).not.toHaveBeenCalled();
    expect(mockClaude.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ permissionMode: "bypassPermissions" }),
    }));
  });

  it("disposes the previous integrated Claude runtime when /new claude replaces it", async () => {
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => mockClaude.prompts.includes("first"));
    await bot.handleUpdate(textUpdate(2, "/new claude"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(2);
    expect(mockClaude.dispose).toHaveBeenCalledWith("claude-provider-1");
  });

  it("starts /new claude with the requested model", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/new claude opus"));

    expect(mockClaude.createSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ model: "opus" }),
    }));
    expect(sent.map((entry) => entry.text)).toContain(
      "New Claude session selected with model opus. The next normal message will use it.",
    );
  });

  it("changes Claude model inside the active Claude runtime", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => mockClaude.prompts.includes("first"));
    await bot.handleUpdate(textUpdate(2, "/model opus"));
    await waitFor(() => mockClaude.prompts.includes("/model opus"));

    expect(mockClaude.createSession).toHaveBeenCalledTimes(1);
    expect(mockClaude.dispose).not.toHaveBeenCalledWith("claude-provider-1");
    expect(mockClaude.prompts).toEqual(["first", "/model opus"]);
    expect(sent.map((entry) => entry.text)).toContain("mock reply to /model opus");
  });

  it("reports Claude diagnostics through /doctor while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/doctor"));

    const diagnostics = sent.map((entry) => entry.text).find((text) => text?.includes("Claude provider diagnostics"));
    expect(diagnostics).toContain("Binary exists:");
    expect(diagnostics).toContain("Transcript root:");
    expect(diagnostics).toContain("Registered Claude PIDs:");
    expect(diagnostics).toContain("Legacy Claude Telegram plugin processes: 0");
  });

  it("exposes a shutdown hook that disposes all integrated Claude runtimes", async () => {
    const { bot } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude first"));
    await waitFor(() => mockClaude.prompts.includes("first"));
    await bot.disposeProviders();

    expect(mockClaude.dispose).toHaveBeenCalledWith();
  });
});

async function createTestBot(workspace: string, overrides: Partial<TeleCodexConfig> = {}) {
  const config = { ...createConfig(workspace), ...overrides };
  const registry = new SessionRegistry(config);
  const bot = createBot(config, registry);
  const sent: Array<{ method: string; text?: string }> = [];
  let messageId = 1;

  bot.api.config.use(async (_prev, method, payload: { text?: string }) => {
    if (method === "sendMessage") {
      sent.push({ method, text: payload.text });
      return { ok: true, result: textMessage(messageId++, payload.text ?? "") };
    }
    if (method === "editMessageText") {
      sent.push({ method, text: payload.text });
      return { ok: true, result: true };
    }
    if (method === "sendChatAction" || method === "answerCallbackQuery" || method === "setMessageReaction") {
      sent.push({ method });
      return { ok: true, result: true };
    }
    throw new Error(`Unhandled Telegram API method in test: ${method}`);
  });

  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "TeleCodex",
    username: "TeleCodexBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  return { bot, sent, registry };
}

function createConfig(workspace: string): TeleCodexConfig {
  const launchProfile = createDefaultLaunchProfile("danger-full-access", "never");
  return {
    telegramBotToken: "123:abc",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace,
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: undefined,
    codexModel: "gpt-5.5",
    codexBackend: "app-server",
    codexAppServerPath: undefined,
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    launchProfiles: [launchProfile],
    defaultLaunchProfileId: launchProfile.id,
    enableUnsafeLaunchProfiles: true,
    toolVerbosity: "summary",
    streamAssistantText: false,
    progressDelivery: "messages",
    showTurnTokenUsage: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    enableClaudeProvider: true,
    claudeBin: "C:\\Users\\Anthony\\.local\\bin\\claude.exe",
    claudeConfigDir: path.join(workspace, ".claude-config"),
    claudeStrictMcpConfig: true,
    claudeDefaultModel: "sonnet",
    claudeWorkspace: workspace,
    claudePermissionMode: "acceptEdits",
    claudeTurnIdleTimeoutSeconds: 180,
    claudeContextWindow: 200000,
  };
}

function textUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: textMessage(updateId, text),
  };
}

function textMessage(messageId: number, text: string) {
  const commandMatch = text.match(/^\/\S+/u);
  return {
    message_id: messageId,
    date: 1,
    chat: { id: 123, type: "private" },
    from: { id: 123, is_bot: false, first_name: "Anthony" },
    text,
    entities: commandMatch
      ? [{ type: "bot_command", offset: 0, length: commandMatch[0].length }]
      : undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
