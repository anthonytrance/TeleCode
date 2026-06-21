import { describe, expect, it, vi } from "vitest";

import {
  AppServerSessionService,
  type AppServerClientLike,
  type AppServerNotification,
} from "../src/app-server-session.js";
import { DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS, type AppServerServerRequest, type JsonValue } from "../src/app-server.js";
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
  private requestHandler:
    | ((request: AppServerServerRequest) => JsonValue | undefined | Promise<JsonValue | undefined>)
    | null = null;

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

  onRequest(handler: (request: AppServerServerRequest) => JsonValue | undefined | Promise<JsonValue | undefined>): void {
    this.requestHandler = handler;
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

  async requestFromServer(request: AppServerServerRequest): Promise<JsonValue | undefined> {
    return await this.requestHandler?.(request);
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
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: {
                id: "dyn-1",
                type: "dynamicToolCall",
                namespace: "tools",
                tool: "inspect",
                status: "completed",
                success: true,
                contentItems: [{ type: "inputText", text: "dynamic result" }],
              },
            },
          });
          activeClient.emit({
            method: "thread/tokenUsage/updated",
            params: {
              usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 6 },
            },
          });
          activeClient.emit({
            method: "item/started",
            params: {
              turnId: "turn-1",
              item: {
                id: "child-1",
                type: "collabAgentToolCall",
                tool: "spawn_agent",
                prompt: "inspect the child path",
                receiverThreadIds: ["thread-child-1"],
              },
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
        onChildThreads: (event) => events.push(`children:${event.threadIds.join(",")}:${event.prompt}`),
        onTurnComplete: (usage) => events.push(`usage:${usage.inputTokens}/${usage.cachedInputTokens}/${usage.outputTokens}`),
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
      "start:dyn-1:dynamic:tools/inspect",
      "update:dyn-1:dynamic result",
      "end:dyn-1:false",
      "usage:10/4/6",
      "start:child-1:mcp:codex_apps/spawn_agent",
      "update:child-1:Prompt: inspect the child path",
      "children:thread-child-1:inspect the child path",
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
    const onToolStart = vi.fn();
    const onToolUpdate = vi.fn();
    const onToolEnd = vi.fn();
    const promptPromise = service.prompt("initial", {
      onTextDelta: vi.fn(),
      onToolStart,
      onToolUpdate,
      onToolEnd,
      onAgentEnd: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(client!.requests.some((request) => request.method === "turn/start")).toBe(true);
    });
    await expect(
      client.requestFromServer({ id: "approval-1", method: "item/commandExecution/requestApproval" }),
    ).resolves.toEqual({ decision: "decline" });
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
    expect(onToolStart).toHaveBeenCalledWith("app_server_request", "server-request:approval-1");
    expect(onToolUpdate).toHaveBeenCalledWith(
      "server-request:approval-1",
      "Handled item/commandExecution/requestApproval with a safe default response.",
    );
    expect(onToolEnd).toHaveBeenCalledWith("server-request:approval-1", true);
  });

  it("forces a stuck app-server turn to settle when interrupt fails", async () => {
    let client: FakeAppServerClient | null = null;
    client = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        activeClient.emit({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
        return { turn: { id: "turn-1" } };
      }
      if (method === "turn/interrupt") {
        throw new Error("denied writing to app-server stdin");
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const promptPromise = service.prompt("hang", {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(client.requests.some((request) => request.method === "turn/start")).toBe(true);
    });
    await service.abort();

    await expect(promptPromise).rejects.toThrow("aborted locally after interrupt failed");
    expect(service.isProcessing()).toBe(false);
    expect(client.closed).toHaveBeenCalledOnce();
  });

  it("forces a stuck app-server turn to settle when interrupt never replies", async () => {
    vi.useFakeTimers();
    try {
      let client: FakeAppServerClient | null = null;
      client = new FakeAppServerClient((method, _params, activeClient) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" } };
        }
        if (method === "turn/start") {
          activeClient.emit({
            method: "turn/started",
            params: { threadId: "thread-1", turn: { id: "turn-1" } },
          });
          return { turn: { id: "turn-1" } };
        }
        if (method === "turn/interrupt") {
          return new Promise(() => undefined);
        }
        throw new Error(`unexpected request ${method}`);
      });

      const service = await AppServerSessionService.create(createConfig(), {
        appServerClientFactory: () => client!,
      });
      const promptPromise = service.prompt("hang", {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolUpdate: vi.fn(),
        onToolEnd: vi.fn(),
        onAgentEnd: vi.fn(),
      });

      await vi.waitFor(() => {
        expect(client.requests.some((request) => request.method === "turn/start")).toBe(true);
      });

      const promptRejection = expect(promptPromise).rejects.toThrow("turn/interrupt did not settle");
      const abortPromise = service.abort();
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(750);
      await abortPromise;

      await promptRejection;
      expect(service.isProcessing()).toBe(false);
      expect(client.closed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
      if (method === "thread/read") {
        return { thread: { id: "thread-fork", turns: [{ id: "turn-1" }, { id: "turn-2" }] } };
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
    const turnCount = await service.getTurnCount();
    await service.compactThread();
    await service.renameThread(" App work ");
    await service.rollbackThread(2);

    expect(forked.threadId).toBe("thread-fork");
    expect(turnCount).toBe(2);
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
    expect(client.requests.find((request) => request.method === "thread/read")?.params).toEqual({
      threadId: "thread-fork",
      includeTurns: true,
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

  it("supports native app-server goal controls", async () => {
    let client: FakeAppServerClient | null = null;
    const activeGoal = {
      threadId: "thread-1",
      objective: "finish the bridge",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const pausedGoal = { ...activeGoal, status: "paused", updatedAt: 2 };

    client = new FakeAppServerClient((method) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "thread/goal/get") {
        return { goal: activeGoal };
      }
      if (method === "thread/goal/set") {
        return { goal: pausedGoal };
      }
      if (method === "thread/goal/clear") {
        return { cleared: true };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });

    await expect(service.getThreadGoal()).resolves.toMatchObject(activeGoal);
    await expect(service.setThreadGoal({ status: "paused" })).resolves.toMatchObject(pausedGoal);
    await expect(service.clearThreadGoal()).resolves.toBe(true);
    expect(client.requests.find((request) => request.method === "thread/goal/get")?.params).toEqual({
      threadId: "thread-1",
    });
    expect(client.requests.find((request) => request.method === "thread/goal/set")?.params).toEqual({
      threadId: "thread-1",
      status: "paused",
    });
    expect(client.requests.find((request) => request.method === "thread/goal/clear")?.params).toEqual({
      threadId: "thread-1",
    });
  });

  it("tracks native goal continuation turns until the goal stops", async () => {
    let client: FakeAppServerClient | null = null;
    const activeGoal = {
      threadId: "thread-1",
      objective: "finish the bridge",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const completeGoal = { ...activeGoal, status: "complete", tokensUsed: 20, timeUsedSeconds: 5, updatedAt: 2 };

    client = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "thread/goal/set") {
        setTimeout(() => {
          activeClient.emit({
            method: "thread/goal/updated",
            params: { threadId: "thread-1", turnId: null, goal: activeGoal },
          });
          activeClient.emit({
            method: "turn/started",
            params: { threadId: "thread-1", turn: { id: "goal-turn-1" } },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "goal-turn-1",
              item: { id: "agent-1", type: "agentMessage", text: "Made progress." },
            },
          });
          activeClient.emit({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "goal-turn-1", status: "completed" } },
          });
          activeClient.emit({
            method: "thread/goal/updated",
            params: { threadId: "thread-1", turnId: "goal-turn-1", goal: completeGoal },
          });
        }, 0);
        return { goal: activeGoal };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const events: string[] = [];

    const finalGoal = await service.runThreadGoal(
      { objective: "finish the bridge", status: "active" },
      {
        onTextDelta: (delta) => events.push(`text:${delta}`),
        onToolStart: vi.fn(),
        onToolUpdate: vi.fn(),
        onToolEnd: vi.fn(),
        onAgentEnd: () => events.push("agent:end"),
      },
    );

    expect(finalGoal).toMatchObject(completeGoal);
    expect(events).toEqual(["text:Made progress.", "agent:end"]);
    expect(service.isProcessing()).toBe(false);
  });

  it("pauses an active goal run without rejecting the monitor", async () => {
    let client: FakeAppServerClient | null = null;
    const activeGoal = {
      threadId: "thread-1",
      objective: "finish the bridge",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const pausedGoal = { ...activeGoal, status: "paused", updatedAt: 2 };

    client = new FakeAppServerClient((method, params) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "thread/goal/set") {
        const record = params as { status?: unknown };
        return { goal: record.status === "paused" ? pausedGoal : activeGoal };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client!,
    });
    const goalPromise = service.runThreadGoal(
      { objective: "finish the bridge", status: "active" },
      {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolUpdate: vi.fn(),
        onToolEnd: vi.fn(),
        onAgentEnd: vi.fn(),
      },
    );

    await vi.waitFor(() => {
      expect(service.getProcessingKind()).toBe("goal");
    });

    await expect(service.pauseActiveGoal()).resolves.toMatchObject(pausedGoal);
    await expect(goalPromise).resolves.toMatchObject(pausedGoal);
    expect(service.isProcessing()).toBe(false);
    expect(client.requests.filter((request) => request.method === "thread/goal/set").at(-1)?.params).toEqual({
      threadId: "thread-1",
      status: "paused",
    });
  });

  it("resumes the current thread before prompting after an active goal pause closes app-server", async () => {
    const activeGoal = {
      threadId: "thread-1",
      objective: "finish the bridge",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const pausedGoal = { ...activeGoal, status: "paused", updatedAt: 2 };
    let turnStarted: Promise<void>;
    let resolveTurnStarted: () => void = () => undefined;
    turnStarted = new Promise((resolve) => {
      resolveTurnStarted = resolve;
    });

    const client1 = new FakeAppServerClient((method, params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1", cwd: "/workspace/base" }, model: "gpt-test" };
      }
      if (method === "thread/goal/set") {
        const record = params as { status?: unknown };
        if (record.status === "paused") {
          return { goal: pausedGoal };
        }
        setTimeout(() => {
          activeClient.emit({
            method: "turn/started",
            params: { threadId: "thread-1", turn: { id: "goal-turn-1" } },
          });
          resolveTurnStarted();
        }, 0);
        return { goal: activeGoal };
      }
      if (method === "turn/interrupt") {
        return {};
      }
      throw new Error(`unexpected request ${method}`);
    });

    const client2 = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/resume") {
        return { thread: { id: "thread-1", cwd: "/workspace/base" }, model: "gpt-test" };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          activeClient.emit({
            method: "item/completed",
            params: { turnId: "turn-2", item: { id: "agent-2", type: "agentMessage", text: "After pause" } },
          });
          activeClient.emit({
            method: "turn/completed",
            params: { turn: { id: "turn-2", status: "completed" } },
          });
        }, 0);
        return { turn: { id: "turn-2" } };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const clients = [client1, client2];
    let clientIndex = 0;
    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => clients[clientIndex++]!,
    });
    const goalPromise = service.runThreadGoal(
      { objective: "finish the bridge", status: "active" },
      {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolUpdate: vi.fn(),
        onToolEnd: vi.fn(),
        onAgentEnd: vi.fn(),
      },
    );

    await turnStarted;
    await expect(service.pauseActiveGoal()).resolves.toMatchObject(pausedGoal);
    await expect(goalPromise).resolves.toMatchObject(pausedGoal);
    expect(client1.closed).toHaveBeenCalledOnce();

    let text = "";
    const onAgentEnd = vi.fn();
    await service.prompt("continue", {
      onTextDelta: (delta) => {
        text += delta;
      },
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd,
    });

    expect(text).toBe("After pause");
    expect(onAgentEnd).toHaveBeenCalledOnce();
    expect(client2.requests.map((request) => request.method).slice(0, 2)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    expect(client2.requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("keeps an idle active goal monitor attached until the goal is paused", async () => {
    vi.useFakeTimers();
    try {
      let client: FakeAppServerClient | null = null;
      const activeGoal = {
        threadId: "thread-1",
        objective: "finish the bridge",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      const pausedGoal = { ...activeGoal, status: "paused", updatedAt: 2 };

      client = new FakeAppServerClient((method, params) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" } };
        }
        if (method === "thread/goal/set") {
          const record = params as { status?: unknown };
          return { goal: record.status === "paused" ? pausedGoal : activeGoal };
        }
        throw new Error(`unexpected request ${method}`);
      });

      const service = await AppServerSessionService.create(createConfig(), {
        appServerClientFactory: () => client!,
      });
      const onToolUpdate = vi.fn();
      const goalPromise = service.runThreadGoal(
        { objective: "finish the bridge", status: "active" },
        {
          onTextDelta: vi.fn(),
          onToolStart: vi.fn(),
          onToolUpdate,
          onToolEnd: vi.fn(),
          onAgentEnd: vi.fn(),
        },
      );
      let settled = false;
      void goalPromise.finally(() => {
        settled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(settled).toBe(false);
      expect(service.getProcessingKind()).toBe("goal");
      expect(onToolUpdate).toHaveBeenCalledWith(
        expect.stringMatching(/^goal-idle-/),
        expect.stringContaining("keeping Telegram attached"),
      );
      expect(client.requests.filter((request) => request.method === "thread/goal/set")).toHaveLength(1);
      expect(client.requests.find((request) => request.method === "thread/goal/set")?.params).toEqual({
        threadId: "thread-1",
        objective: "finish the bridge",
        status: "active",
      });

      const pausePromise = service.pauseActiveGoal();
      await vi.advanceTimersByTimeAsync(750);
      await expect(pausePromise).resolves.toMatchObject(pausedGoal);
      await expect(goalPromise).resolves.toMatchObject(pausedGoal);
      expect(service.isProcessing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    progressDelivery: "messages",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    ...overrides,
  };
}
