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

// Keep the machine's real Codex threads out of /sessions.
vi.mock("../src/codex-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/codex-state.js")>()),
  listThreads: () => [],
  listSpawnedThreadIds: () => [],
  getThread: () => undefined,
}));

const runtimes: FakeRuntime[] = [];
vi.mock("../src/codex-backend.js", () => ({
  createCodexSession: async (_config: unknown, options?: { resumeThreadId?: string; workspace?: string }) => {
    const runtime = new FakeRuntime(options?.resumeThreadId ?? null);
    runtimes.push(runtime);
    return runtime;
  },
}));

import { createBot } from "../src/bot.js";

let threadCounter = 0;
const holds = new Map<string, () => void>();

/** Prompts containing "hold" wait until released by name; others finish at once. */
class FakeRuntime {
  processing = false;
  aborted = false;
  readonly dispose = vi.fn();
  readonly prompts: string[] = [];

  constructor(public threadId: string | null) {}

  getInfo(): CodexSessionInfo {
    return {
      threadId: this.threadId,
      workspace: workspaceDir,
      model: "gpt-5.5",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "danger-full-access, never approve",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getProcessingKind(): "prompt" | null {
    return this.processing ? "prompt" : null;
  }

  hasActiveThread(): boolean {
    return Boolean(this.threadId);
  }

  getCurrentWorkspace(): string {
    return workspaceDir;
  }

  async newThread(): Promise<CodexSessionInfo> {
    this.threadId = `thread-${++threadCounter}`;
    return this.getInfo();
  }

  prepareNewThread(): CodexSessionInfo {
    this.threadId = null;
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.threadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    return await this.resumeThread(threadId);
  }

  listAllSessions(): [] {
    return [];
  }

  listWorkspaces(): string[] {
    return [workspaceDir];
  }

  async prompt(input: unknown, callbacks: CodexSessionCallbacks): Promise<void> {
    const text = (typeof input === "string" ? input : JSON.stringify(input)).match(/(hold \w+|quick \w+)/)?.[1] ?? "?";
    this.prompts.push(text);
    this.processing = true;
    try {
      if (text.startsWith("hold")) {
        await new Promise<void>((resolve) => holds.set(text, resolve));
      }
      if (this.aborted) {
        throw new Error("Codex turn aborted");
      }
      callbacks.onTextDelta(`FINAL ${text}`, { phase: "final_answer" });
      callbacks.onAgentEnd();
    } finally {
      this.processing = false;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    for (const [name, release] of holds) {
      if (this.prompts.includes(name)) {
        release();
      }
    }
  }
}

let workspaceDir = "";
let debugSent: string[] = [];

describe("background Codex turns", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), "telecode-codex-parallel-"));
    runtimes.length = 0;
    holds.clear();
    threadCounter = 0;
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("keeps the running turn going after /use and delivers its answer with the session named", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    expect(sent.find((text) => text.includes("keeps running"))).toMatch(/^Background Codex, session \d+ /);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1].threadId).toBe("thread-1");

    // The lane is free: the selected session runs a turn of its own meanwhile.
    await bot.handleUpdate(textUpdate(11, "quick two"));
    await waitFor(() => sent.includes("FINAL quick two"));
    expect(runtimes[1].prompts).toEqual(["quick two"]);

    holds.get("hold A")!();
    await waitFor(() => sent.some((text) => text.includes("FINAL hold A")));
    const finished = sent.find((text) => text.includes("FINAL hold A"))!;
    expect(finished).toMatch(/^Background Codex, session \d+ .*, finished after /);
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
    expect(runtimes[1].dispose).not.toHaveBeenCalled();
  });

  it("refuses the switch at the parallel turn limit", async () => {
    const { bot, sent } = createHarness({ codexMaxParallelTurns: 1 });
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("the limit is 1")));
    expect(runtimes).toHaveLength(1);
    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
  });

  it("picks the running turn back up when switching back to it", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("This session is still working")));
    expect(runtimes[1].dispose).toHaveBeenCalled();

    holds.get("hold A")!();
    await waitFor(() => sent.includes("FINAL hold A"));
    expect(sent.some((text) => text.includes("finished after"))).toBe(false);
    expect(runtimes[0].dispose).not.toHaveBeenCalled();

    // The adopted runtime is the lane's again.
    await bot.handleUpdate(textUpdate(12, "quick three"));
    await waitFor(() => sent.includes("FINAL quick three"));
    expect(runtimes[0].prompts).toContain("quick three");
  });

  it("stops a background turn by its session with /stop", async () => {
    const { bot, sent } = createHarness();
    await startHeldTurnInSecondSession(bot, sent);

    await bot.handleUpdate(textUpdate(10, "/use previous"));
    await waitFor(() => sent.some((text) => text.includes("keeps running")));
    await bot.handleUpdate(textUpdate(11, "/stop previous"));
    await waitFor(() => sent.some((text) => text.startsWith("Stop sent to Background Codex")));
    await waitFor(() => sent.some((text) => /^Background Codex.*, stopped after /.test(text)));
    expect(runtimes[0].aborted).toBe(true);
    expect(runtimes[1].aborted).toBe(false);
    await waitFor(() => runtimes[0].dispose.mock.calls.length === 1);
  });
});

/**
 * Session 1 ("thread-1") runs a quick turn, /new opens session 2, and session 2
 * starts a turn that holds until released. /use previous then targets session 1.
 */
async function startHeldTurnInSecondSession(bot: ReturnType<typeof createBot>, sent: string[]): Promise<void> {
  await bot.handleUpdate(textUpdate(1, "quick one"));
  await waitFor(() => sent.includes("FINAL quick one"));
  // Let the finished turn release the lane before /new.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const beforeNew = sent.length;
  await bot.handleUpdate(textUpdate(2, "/new"));
  await waitFor(() => sent.length > beforeNew);
  await bot.handleUpdate(textUpdate(3, "hold A"));
  await waitFor(() => holds.has("hold A"));
}

function createHarness(overrides: Partial<TeleCodeConfig> = {}) {
  const config = { ...createConfig(workspaceDir), ...overrides };
  const registry = new SessionRegistry(config);
  const bot = createBot(config, registry);
  const sent: string[] = [];
  debugSent = sent;
  let messageId = 1;
  bot.api.config.use(async (_prev, method, payload: { text?: string }) => {
    if (method === "sendMessage") {
      sent.push(payload.text ?? "");
      return { ok: true, result: textMessage(messageId++, payload.text ?? "") };
    }
    if (
      method === "sendChatAction" ||
      method === "setMessageReaction" ||
      method === "editMessageText" ||
      method === "editMessageReplyMarkup"
    ) {
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
  return { bot, sent, registry };
}

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
    claudeAutoCompactWindow: 200000,
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
    from: { id: 123, is_bot: false, first_name: "Tester" },
    text,
    entities: commandMatch
      ? [{ type: "bot_command", offset: 0, length: commandMatch[0].length }]
      : undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for condition. Sent: ${JSON.stringify(debugSent)}`);
}
