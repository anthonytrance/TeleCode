import { describe, expect, it, vi } from "vitest";

import {
  AppServerSessionService,
  type AppServerClientLike,
  type AppServerNotification,
} from "../src/app-server-session.js";
import { DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS, type JsonValue } from "../src/app-server.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";

class FakeAppServerClient implements AppServerClientLike {
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  readonly closed = vi.fn(async () => undefined);
  readonly initialized = vi.fn(async () => ({
    userAgent: "codex-test",
    codexHome: "/home/test/.codex",
    platformFamily: "windows",
    platformOs: "windows",
  }));
  readonly notifyInitialized = vi.fn();
  readonly started = vi.fn(async () => undefined);
  private notificationHandler: ((notification: AppServerNotification) => void) | null = null;

  constructor(
    private readonly responder: (
      method: string,
      params: JsonValue | undefined,
      client: FakeAppServerClient,
    ) => unknown,
  ) {}

  onNotification(handler: (notification: AppServerNotification) => void): void {
    this.notificationHandler = handler;
  }

  async start(): Promise<void> {
    await this.started();
  }

  async initialize(optOutNotificationMethods?: string[]): Promise<Awaited<ReturnType<FakeAppServerClient["initialized"]>>> {
    expect(optOutNotificationMethods).toEqual(DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS);
    return await this.initialized();
  }

  async request<T = unknown>(method: string, params: JsonValue | undefined): Promise<T> {
    this.requests.push({ method, params });
    return this.responder(method, params, this) as T;
  }

  async close(): Promise<void> {
    await this.closed();
  }

  emit(notification: AppServerNotification): void {
    this.notificationHandler?.(notification);
  }
}

describe("AppServerSessionService", () => {
  it("starts a thread and maps prompt notifications to session callbacks", async () => {
    let client: FakeAppServerClient | null = null;
    client = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1", cwd: "/workspace/project" }, model: "gpt-test" };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          activeClient.emit({
            method: "item/started",
            params: {
              turnId: "turn-1",
              item: { id: "cmd-1", type: "commandExecution", command: "npm test", aggregatedOutput: "" },
            },
          });
          activeClient.emit({
            method: "item/commandExecution/outputDelta",
            params: { turnId: "turn-1", itemId: "cmd-1", delta: "passing\n" },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "cmd-1", type: "commandExecution", aggregatedOutput: "passing\n", status: "completed" },
            },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "agent-1", type: "agentMessage", text: "Done" },
            },
          });
          activeClient.emit({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          });
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const events: string[] = [];

    await service.prompt(
      { text: "hello", stagedFileInstructions: "read file", imagePaths: ["/tmp/image.png"] },
      {
        onTextDelta: (delta) => events.push(`text:${delta}`),
        onToolStart: (tool, id) => events.push(`start:${id}:${tool}`),
        onToolUpdate: (id, text) => events.push(`update:${id}:${text}`),
        onToolEnd: (id, failed) => events.push(`end:${id}:${failed}`),
        onAgentEnd: () => events.push("agent:end"),
      },
    );

    expect(service.getInfo()).toMatchObject({
      threadId: "thread-1",
      workspace: "/workspace/project",
      model: "gpt-test",
    });
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/workspace/project",
      approvalPolicy: "never",
      model: "gpt-test",
      input: [
        { type: "text", text: "read file\n\nhello", text_elements: [] },
        { type: "localImage", path: "/tmp/image.png" },
      ],
    });
    expect(events).toEqual([
      "start:cmd-1:npm test",
      "update:cmd-1:passing\n",
      "end:cmd-1:false",
      "text:Done",
      "agent:end",
    ]);
  });

  it("sends steer and interrupt to the active turn", async () => {
    let client: FakeAppServerClient | null = null;
    client = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1" } };
      }
      if (method === "turn/steer") {
        setTimeout(() => {
          activeClient.emit({
            method: "item/completed",
            params: { turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "steered" } },
          });
          activeClient.emit({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          });
        }, 0);
        return { turnId: "turn-1" };
      }
      if (method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const promptPromise = service.prompt("initial", {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(client!.requests.some((request) => request.method === "turn/start")).toBe(true);
    });
    await service.steer("change course");
    await service.abort();
    await promptPromise;

    expect(client.requests.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "change course", text_elements: [] }],
    });
    expect(client.requests.find((request) => request.method === "turn/interrupt")?.params).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("supports native app-server thread controls", async () => {
    let client: FakeAppServerClient | null = null;
    client = new FakeAppServerClient((method) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1", cwd: "/workspace/base" }, model: "gpt-test" };
      }
      if (method === "thread/fork") {
        return { thread: { id: "thread-fork", cwd: "/workspace/base" }, model: "gpt-test" };
      }
      if (method === "thread/compact/start") {
        return {};
      }
      if (method === "thread/name/set") {
        return {};
      }
      if (method === "thread/rollback") {
        return {};
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const forked = await service.forkThread();
    await service.compactThread();
    await service.renameThread(" App work ");
    await service.rollbackThread(2);

    expect(forked.threadId).toBe("thread-fork");
    expect(client.requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/workspace/base",
      model: "gpt-test",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(client.requests.find((request) => request.method === "thread/compact/start")?.params).toEqual({
      threadId: "thread-fork",
    });
    expect(client.requests.find((request) => request.method === "thread/name/set")?.params).toEqual({
      threadId: "thread-fork",
      name: "App work",
    });
    expect(client.requests.find((request) => request.method === "thread/rollback")?.params).toEqual({
      threadId: "thread-fork",
      numTurns: 2,
    });
  });
});

function createConfig(overrides: Partial<TeleCodexConfig> = {}): TeleCodexConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "gpt-5.5",
    codexBackend: "app-server",
    codexAppServerPath: undefined,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    streamAssistantText: false,
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    ...overrides,
  };
}
