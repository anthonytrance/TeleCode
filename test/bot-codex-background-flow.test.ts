import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { CodexSessionCallbacks, CodexSessionInfo } from "../src/codex-session.js";
import type { TeleCodeConfig } from "../src/config.js";
import { SessionRegistry } from "../src/session-registry.js";

vi.mock("../src/codex-auth.js", () => ({
  checkAuthStatus: vi.fn(async () => ({ authenticated: true, method: "test", detail: "authenticated" })),
  clearAuthCache: vi.fn(),
  startLogin: vi.fn(),
  startLogout: vi.fn(),
}));

import { createBot } from "../src/bot.js";

describe("Codex background completion flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecode-codex-background-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("awaits finalization and delivers the full Codex final with a background heading", async () => {
    const config = createConfig(tempDir);
    const registry = new SessionRegistry(config);
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let promptStarted = false;
    let processing = false;
    const info: CodexSessionInfo = {
      threadId: "codex-thread-1",
      workspace: tempDir,
      model: "gpt-5.5",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "danger-full-access, never approve",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
    };
    const session = {
      getInfo: () => info,
      isProcessing: () => processing,
      hasActiveThread: () => true,
      getCurrentWorkspace: () => tempDir,
      prompt: async (_input: unknown, callbacks: CodexSessionCallbacks) => {
        processing = true;
        promptStarted = true;
        await promptGate;
        callbacks.onTextDelta("CODEX_BACKGROUND_COMMENTARY", { phase: "commentary" });
        callbacks.onToolStart("Read", "tool-1");
        callbacks.onTextDelta("CODEX_COMPLETE_FINAL", { phase: "final_answer" });
        callbacks.onAgentEnd();
        processing = false;
      },
      dispose: vi.fn(),
    };
    vi.spyOn(registry, "getOrCreate").mockResolvedValue(session as never);
    vi.spyOn(registry, "get").mockReturnValue(session as never);

    const bot = createBot(config, registry);
    const sent: string[] = [];
    let messageId = 1;
    bot.api.config.use(async (_prev, method, payload: { text?: string }) => {
      if (method === "sendMessage") {
        sent.push(payload.text ?? "");
        return { ok: true, result: textMessage(messageId++, payload.text ?? "") };
      }
      if (method === "sendChatAction" || method === "setMessageReaction") {
        return { ok: true, result: true };
      }
      throw new Error(`Unhandled Telegram API method in test: ${method}`);
    });
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "TeleCode",
      username: "TeleCodeBot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };

    await bot.handleUpdate(textUpdate(1, "run in background"));
    await waitFor(() => promptStarted);
    registry.setActiveProvider("123", "claude");
    releasePrompt();

    await waitFor(() => sent.some((text) => text.includes("CODEX_COMPLETE_FINAL")));
    expect(sent).toContain("Codex finished in background: Codex\n\nCODEX_COMPLETE_FINAL");
    expect(sent.join("\n")).not.toContain("Preview:");
    expect(sent.join("\n")).not.toContain("CODEX_BACKGROUND_COMMENTARY");

    await bot.handleUpdate(textUpdate(2, "/replay all"));
    await waitFor(() => sent.some((text) => text.includes("CODEX_BACKGROUND_COMMENTARY")));
    expect(sent.some((text) => text.includes("Buffered Codex output"))).toBe(true);

    const finalCopiesBefore = sent.filter((text) => text === "CODEX_COMPLETE_FINAL").length;
    await bot.handleUpdate(textUpdate(3, "/last"));
    await bot.handleUpdate(textUpdate(4, "/repeat"));
    expect(sent.filter((text) => text === "CODEX_COMPLETE_FINAL")).toHaveLength(finalCopiesBefore + 2);
  });
});

function createConfig(workspace: string): TeleCodeConfig {
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
    enableClaudeProvider: false,
    claudeBin: "claude.exe",
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
