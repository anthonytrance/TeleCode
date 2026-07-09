import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";
import { SessionRegistry } from "../src/session-registry.js";

const mockClaude = vi.hoisted(() => {
  const prompts: string[] = [];
  const steers: string[] = [];
  const createSession = vi.fn();
  const resumeSession = vi.fn();
  const getSessionInfo = vi.fn();
  const dispose = vi.fn();
  let createCount = 0;
  let activeModel = "sonnet";
  let promptGate: Promise<void> | undefined;
  let releasePromptGate: (() => void) | undefined;
  let nextEvents: Array<Record<string, unknown>> | undefined;

  return {
    prompts,
    steers,
    createSession,
    resumeSession,
    getSessionInfo,
    dispose,
    nextCreateCount: () => {
      createCount += 1;
      return createCount;
    },
    setActiveModel: (model: string) => {
      activeModel = model;
    },
    getActiveModel: () => activeModel,
    setNextEvents: (events: Array<Record<string, unknown>>) => {
      nextEvents = events;
    },
    takeNextEvents: () => {
      const events = nextEvents;
      nextEvents = undefined;
      return events;
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
      steers.length = 0;
      createCount = 0;
      activeModel = "sonnet";
      releasePromptGate?.();
      promptGate = undefined;
      releasePromptGate = undefined;
      nextEvents = undefined;
      createSession.mockReset();
      resumeSession.mockReset();
      getSessionInfo.mockReset();
      dispose.mockReset();
    },
  };
});

vi.mock("../src/providers/claude-adapter.js", () => ({
  PromptNotDeliveredError: class PromptNotDeliveredError extends Error {
    constructor(
      readonly promptText: string,
      message: string,
    ) {
      super(message);
      this.name = "PromptNotDeliveredError";
    }
  },
  ClaudeProviderAdapter: class {
    readonly capabilities = {
      streamingText: true,
      streamingInput: true,
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
      if (typeof options.metadata?.model === "string") {
        mockClaude.setActiveModel(options.metadata.model);
      }
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

    async forkSession(sourceSessionId: string, displayName?: string) {
      const createCount = mockClaude.nextCreateCount();
      return {
        id: `claude-fork-${createCount}`,
        provider: "claude",
        workspace: "C:\\workspace",
        displayName: displayName ?? "Mock Claude (fork)",
        providerSessionId: `forked-session-${createCount}`,
        status: "idle",
        capabilities: this.capabilities,
        createdAt: 2000,
        updatedAt: 2000,
        metadata: { model: mockClaude.getActiveModel(), backend: "pty" },
      };
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
        metadata: { model: mockClaude.getActiveModel(), permissionMode: "acceptEdits" },
      };
      mockClaude.getSessionInfo();
      return descriptor;
    }

    async *sendPrompt(options: { sessionId: string; jobId: string; input: { text?: string } }) {
      const text = options.input.text ?? "";
      mockClaude.prompts.push(text);
      const modelMatch = text.match(/^\/model\s+(.+)$/u);
      if (modelMatch?.[1]) {
        mockClaude.setActiveModel(modelMatch[1].trim());
      }
      yield {
        type: "session_status_changed",
        sessionId: options.sessionId,
        status: "running",
      };
      const gate = mockClaude.takePromptGate();
      if (gate) {
        await gate;
      }
      const customEvents = mockClaude.takeNextEvents();
      if (customEvents) {
        for (const event of customEvents) {
          const delay = (event as { __delayMs?: number }).__delayMs;
          if (typeof delay === "number") {
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          yield event;
        }
        return;
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

    async streamInput(_sessionId: string, input: { text?: string }) {
      mockClaude.steers.push(input.text ?? "");
    }

    async getUsage() {
      return { contextTokens: 3 };
    }

    async getUsageReport() {
      return "Mock Claude usage panel";
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

  it("delivers a timeout completion warning after prior Claude progress was flushed", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      {
        type: "assistant_text_delta",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "Working on it.",
      },
      {
        type: "tool_started",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        toolName: "PowerShell",
        text: "ytclip --selftest",
      },
      {
        type: "assistant_message_complete",
        sessionId: "claude-provider-1",
        jobId: "job-1",
        text: "Working on it.\n\nClaude stopped before finishing the turn: Claude active tool idle timeout after 1800 seconds. Screen tail: switched to Opus 4.8",
      },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude long tool"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Claude active tool idle timeout")));

    expect(sent.map((entry) => entry.text)).toContain("Working on it.");
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude stopped before finishing the turn: Claude active tool idle timeout after 1800 seconds. Screen tail: switched to Opus 4.8",
    );
  });

  it("sends /steer into the active Claude turn while Claude is already running", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude first task"));
    await waitFor(() => mockClaude.prompts.includes("first task"));
    await bot.handleUpdate(textUpdate(2, "/steer add this detail"));

    await waitFor(() => mockClaude.steers.includes("add this detail"));
    expect(sent.map((entry) => entry.text)).toContain(
      "Steer sent to the active Claude turn.",
    );

    mockClaude.releaseBlockedPrompt();

    expect(mockClaude.prompts).toEqual(["first task"]);
    expect(mockClaude.steers).toEqual(["add this detail"]);
  });

  it("asks y/n for /steer with no active turn and starts the turn on y", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/steer investigate the login bug"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("No Claude turn is running")));
    expect(mockClaude.prompts).toEqual([]);

    await bot.handleUpdate(textUpdate(3, "y"));
    await waitFor(() => mockClaude.prompts.includes("investigate the login bug"));
    expect(mockClaude.prompts).toEqual(["investigate the login bug"]);
  });

  it("discards an idle steer on n and passes a bare y through when nothing is pending", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "/steer try the other approach"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("No Claude turn is running")));
    await bot.handleUpdate(textUpdate(3, "n"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Discarded the steer text")));
    expect(mockClaude.prompts).toEqual([]);

    // No pending question anymore: a literal y is a normal prompt.
    await bot.handleUpdate(textUpdate(4, "y"));
    await waitFor(() => mockClaude.prompts.includes("y"));
    expect(mockClaude.prompts).toEqual(["y"]);
  });

  it("serializes same-tick Claude messages and runs the queued prompts FIFO", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.blockNextPrompt();

    await bot.handleUpdate(textUpdate(1, "/claude"));
    const first = bot.handleUpdate(textUpdate(2, "first task"));
    const second = bot.handleUpdate(textUpdate(3, "second task"));
    const third = bot.handleUpdate(textUpdate(4, "third task"));

    await waitFor(() => mockClaude.prompts.includes("first task"));
    expect(mockClaude.prompts).toEqual(["first task"]);
    await Promise.all([first, second, third]);

    expect(sent.map((entry) => entry.text)).toContain(
      "Claude is still working. I queued this Claude message and will run it next. Use /stop if the current task is stuck.",
    );
    expect(sent.map((entry) => entry.text)).toContain(
      "Claude is still working. I queued this Claude message as item #2. Use /stop if the current task is stuck.",
    );

    mockClaude.releaseBlockedPrompt();
    await waitFor(() => mockClaude.prompts.length === 3);

    expect(mockClaude.prompts).toEqual(["first task", "second task", "third task"]);
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

  it("rejects embedded slash commands separated by carriage returns", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude"));
    await bot.handleUpdate(textUpdate(2, "please answer this\r/exit"));

    await waitFor(() => sent.some((entry) => entry.text?.includes("contains /exit on its own line")));

    expect(mockClaude.prompts).toEqual([]);
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

    await bot.handleUpdate(textUpdate(3, "/status"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Model: opus")));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude session:"))).toContain("Model: opus");
  });

  it("delivers every narration block exactly once when complete arrives promptly", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "BLOCK_ONE" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "BLOCK_TWO" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_BLOCK" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_BLOCK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude narrate"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("FINAL_BLOCK")));

    const texts = sent.map((entry) => entry.text ?? "");
    for (const marker of ["BLOCK_ONE", "BLOCK_TWO", "FINAL_BLOCK"]) {
      expect(texts.filter((text) => text.includes(marker))).toHaveLength(1);
    }
  });

  it("does not re-send a final block that the idle timer already flushed as progress", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "ONLY_BLOCK" },
      { __delayMs: 1800 },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "ONLY_BLOCK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude slow finish"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("ONLY_BLOCK")), 3000);
    // Let the delayed completion land and the turn finish fully before counting.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.filter((text) => text.includes("ONLY_BLOCK"))).toHaveLength(1);
  });

  it("flushes the held narration block before reporting a mid-turn error", async () => {
    const { bot, sent } = await createTestBot(tempDir);
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "PART_ONE" },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "PART_TWO" },
      { type: "error", sessionId: "claude-provider-1", jobId: "job-1", message: "boom mid-turn" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude fail midway"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("boom mid-turn")), 3000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const texts = sent.map((entry) => entry.text ?? "");
    expect(texts.filter((text) => text.includes("PART_ONE"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("PART_TWO"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("boom mid-turn"))).toHaveLength(1);
  });

  it("delivers narration in full in edit mode, rolling oversized blocks into their own messages", async () => {
    const { bot, sent } = await createTestBot(tempDir, { progressDelivery: "edit" });
    const midBlock = `MID ${"m".repeat(2000)}`;
    const hugeBlock = `HUGE ${"h".repeat(6000)}`;
    mockClaude.setNextEvents([
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: midBlock },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: hugeBlock },
      { type: "assistant_text_delta", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_MARK" },
      { type: "assistant_message_complete", sessionId: "claude-provider-1", jobId: "job-1", text: "FINAL_MARK" },
    ]);

    await bot.handleUpdate(textUpdate(1, "/claude narrate a lot"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("FINAL_MARK")));

    const texts = sent.map((entry) => entry.text ?? "");
    const midMessage = texts.find((text) => text.includes("MID "));
    expect(midMessage).toBeDefined();
    expect(midMessage).toContain(midBlock);

    const hugeChars = texts.join("").split("h").length - 1;
    expect(hugeChars).toBeGreaterThanOrEqual(6000);

    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/[mh]{3}\.\.\./u);
    }
  });

  it("shows the unified session list for /sessions while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/sessions"));

    expect(sent.map((entry) => entry.text)).not.toContain(
      "Claude command /sessions is not classified yet, so I did not run it.",
    );
    const list = sent.map((entry) => entry.text).find((text) => text?.includes("Recent provider sessions"));
    expect(list).toBeDefined();
    expect(list).toContain("Claude");
  });

  it("switches sessions with /switch while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/sessions"));
    await bot.handleUpdate(textUpdate(3, "/switch 1"));

    const selection = sent.map((entry) => entry.text).find((text) => text?.includes("Selected #1"));
    expect(selection).toBeDefined();
  });

  it("lists sessions for bare /resume and selects with /resume <n> while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));
    await bot.handleUpdate(textUpdate(2, "/resume"));

    const list = sent.map((entry) => entry.text).find((text) => text?.includes("Recent provider sessions"));
    expect(list).toBeDefined();

    await bot.handleUpdate(textUpdate(3, "/resume 1"));
    const selection = sent.map((entry) => entry.text).find((text) => text?.includes("Selected #1"));
    expect(selection).toBeDefined();
  });

  it("forks the Claude conversation with /fork and keeps the original in /sessions", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    await bot.handleUpdate(textUpdate(2, "/fork my experiment"));
    await waitFor(() => sent.some((entry) => entry.text?.includes("Forked this conversation")));

    await bot.handleUpdate(textUpdate(3, "/sessions"));
    const list = sent
      .map((entry) => entry.text ?? "")
      .filter((text) => text.includes("Recent provider sessions"))
      .pop();
    expect(list).toContain("my experiment");
    // The original session must still be listed alongside the selected fork.
    expect((list?.match(/^\d+\. Claude/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("switches the Claude engine with /backend while Claude is active", async () => {
    const { bot, sent } = await createTestBot(tempDir);

    await bot.handleUpdate(textUpdate(1, "/claude hello"));
    await waitFor(() => mockClaude.prompts.includes("hello"));

    await bot.handleUpdate(textUpdate(2, "/backend"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context: pty"))).toBeDefined();

    await bot.handleUpdate(textUpdate(3, "/backend sdk"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context is now sdk"))).toBeDefined();

    await bot.handleUpdate(textUpdate(4, "/backend"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Claude engine for this Telegram context: sdk"))).toBeDefined();

    await bot.handleUpdate(textUpdate(5, "/compact"));
    expect(sent.map((entry) => entry.text).find((text) => text?.includes("Compaction is automatic on the sdk engine"))).toBeDefined();
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
    claudeLargeSessionResume: "summary",
    claudeTurnIdleTimeoutSeconds: 180,
    claudeContextWindow: 200000,
    claudeBackend: "pty",
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
