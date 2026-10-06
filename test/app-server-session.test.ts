import { describe, expect, it, vi } from "vitest";

import {
  AppServerSessionService,
  type AppServerClientLike,
  type AppServerNotification,
} from "../src/app-server-session.js";
import {
  DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS,
  type AppServerClientOptions,
  type AppServerServerRequest,
  type JsonValue,
} from "../src/app-server.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodeConfig } from "../src/config.js";

class FakeAppServerClient implements AppServerClientLike {
  readonly requests: Array<{ method: string; params: JsonValue | undefined; requestTimeoutMs?: number }> = [];
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

  async request<T = unknown>(
    method: string,
    params: JsonValue | undefined,
    requestTimeoutMs?: number,
  ): Promise<T> {
    this.requests.push({ method, params, requestTimeoutMs });
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
  it("releases earlier writers before starting or resuming a different thread", async () => {
    const { createClient, clients, owners } = createWriterHarness();
    const service = await AppServerSessionService.create(createConfig(), { appServerClientFactory: createClient });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const releaseWriters = clients[0].closed.getMockImplementation()!;
    clients[0].closed.mockImplementationOnce(async () => {
      await closeGate;
      await releaseWriters();
      return undefined;
    });

    const starting = service.newThread();
    await vi.waitFor(() => expect(clients[0].closed).toHaveBeenCalledOnce());
    expect(clients).toHaveLength(1);
    releaseClose();
    expect((await starting).threadId).toBe("thread-2");
    await service.resumeThread("stored-thread");
    expect(clients[1].closed).toHaveBeenCalledOnce();

    // A new runtime can now reopen either earlier conversation without touching
    // the current one, matching TeleCode's same-provider parallel sessions.
    const first = await AppServerSessionService.create(createConfig(), { deferThreadStart: true, appServerClientFactory: createClient });
    const second = await AppServerSessionService.create(createConfig(), { deferThreadStart: true, appServerClientFactory: createClient });
    await first.resumeThread("thread-1");
    await second.resumeThread("thread-2");
    expect(service.getInfo().threadId).toBe("stored-thread");
    expect(owners.size).toBe(3);
    service.dispose();
    first.dispose();
    second.dispose();
  });

  it("releases the idle writer when preparing a fresh conversation", async () => {
    const { createClient, clients, owners } = createWriterHarness();
    const service = await AppServerSessionService.create(createConfig(), { appServerClientFactory: createClient });
    service.prepareNewThread();
    await vi.waitFor(() => expect(clients[0].closed).toHaveBeenCalledOnce());
    expect(owners.has("thread-1")).toBe(false);
    expect((await service.newThread()).threadId).toBe("thread-2");
    service.dispose();
  });

  it("releases the parent writer after forking so another runtime can reopen it", async () => {
    const { createClient } = createWriterHarness();
    const service = await AppServerSessionService.create(createConfig(), { appServerClientFactory: createClient });
    expect((await service.forkThread()).threadId).toBe("thread-2");
    const parent = await AppServerSessionService.create(createConfig(), { deferThreadStart: true, appServerClientFactory: createClient });
    expect((await parent.resumeThread("thread-1")).threadId).toBe("thread-1");
    expect(service.getInfo().threadId).toBe("thread-2");
    service.dispose();
    parent.dispose();
  });

  it("closes a child that fails to initialize during a session switch", async () => {
    const { createClient, clients } = createWriterHarness();
    const failingClient = createClient();
    failingClient.initialized.mockRejectedValueOnce(new Error("initialization failed"));
    const service = await AppServerSessionService.create(createConfig(), {
      deferThreadStart: true,
      appServerClientFactory: () => failingClient,
    });
    await expect(service.resumeThread("stored-thread")).rejects.toThrow("initialization failed");
    expect(clients[0].closed).toHaveBeenCalledOnce();
    expect(service.getInfo().threadId).toBeNull();
    service.dispose();
  });

  it("prepares a fresh thread without waiting for app-server thread/start", async () => {
    const client = new FakeAppServerClient((method) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1", cwd: "/workspace/project" } };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const service = await AppServerSessionService.create(createConfig(), {
      appServerClientFactory: () => client,
    });
    const requestCount = client.requests.length;

    const prepared = service.prepareNewThread("/workspace/next", "gpt-next");

    expect(prepared).toMatchObject({
      threadId: null,
      workspace: "/workspace/next",
      model: "gpt-next",
    });
    expect(service.hasActiveThread()).toBe(false);
    expect(client.requests).toHaveLength(requestCount);
  });

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
      reasoningEffort: "max",
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
      reasoningEffort: "max",
    });
    expect(client.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/workspace/project",
      approvalPolicy: "never",
      model: "gpt-test",
      effort: "max",
      input: [
        { type: "text", text: "hello\n\nread file", text_elements: [] },
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

  it("passes app-server agent message phases and keeps their text deltas separate", async () => {
    let client: FakeAppServerClient | null = null;
    client = new FakeAppServerClient((method, _params, activeClient) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "turn/start") {
        setTimeout(() => {
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "agent-1", type: "agentMessage", phase: "commentary", text: "Checking markers." },
            },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "agent-2", type: "agentMessage", phase: "final_answer", text: "Result: clean." },
            },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "agent-3", type: "agentMessage", phase: "commentary", text: "Checking markers. Still clean." },
            },
          });
          activeClient.emit({
            method: "item/completed",
            params: {
              turnId: "turn-1",
              item: { id: "agent-4", type: "agentMessage", phase: "final_answer", text: "Result: clean. No routing found." },
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

    await service.prompt("hello", {
      onTextDelta: (delta, metadata) => events.push(`${metadata?.phase ?? "none"}:${delta}`),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: () => events.push("agent:end"),
    });

    expect(events).toEqual([
      "commentary:Checking markers.",
      "final_answer:Result: clean.",
      "commentary: Still clean.",
      "final_answer: No routing found.",
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
    client = new FakeAppServerClient((method, params) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1", cwd: "/workspace/base" }, model: "gpt-test" };
      }
      if (method === "thread/resume") {
        return {
          thread: { id: (params as { threadId: string }).threadId, cwd: "/workspace/base" },
          model: "gpt-test",
        };
      }
      if (method === "thread/fork") {
        const lastTurnId = (params as { lastTurnId?: string } | undefined)?.lastTurnId;
        return {
          thread: { id: lastTurnId ? "thread-truncated" : "thread-fork", cwd: "/workspace/base" },
          model: "gpt-test",
        };
      }
      if (method === "thread/read") {
        return { thread: { id: "thread-fork", turns: [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }] } };
      }
      if (method === "thread/compact/start") {
        return {};
      }
      if (method === "thread/name/set") {
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
    const rolledBack = await service.rollbackThread(2);

    expect(forked.threadId).toBe("thread-fork");
    expect(rolledBack.threadId).toBe("thread-truncated");
    expect(turnCount).toBe(3);
    const forkRequests = client.requests.filter((request) => request.method === "thread/fork");
    expect(forkRequests[0]?.params).toMatchObject({
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
    expect(forkRequests[1]?.params).toMatchObject({
      threadId: "thread-fork",
      lastTurnId: "turn-1",
      cwd: "/workspace/base",
      model: "gpt-test",
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(client.requests.some((request) => request.method === "thread/rollback")).toBe(false);
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
    const resumeRequest = client2.requests.find((request) => request.method === "thread/resume");
    expect(resumeRequest?.params).toMatchObject({
      threadId: "thread-1",
    });
    expect(resumeRequest?.requestTimeoutMs).toBe(60_000);
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

  it("spawns the app-server against the vendor endpoint when a vendor model is selected", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-test");
    try {
      const spawns: AppServerClientOptions[] = [];
      const factory = (options: AppServerClientOptions) => {
        spawns.push(options);
        return new FakeAppServerClient((method) => {
          if (method === "thread/start") {
            return { thread: { id: "thread-1", cwd: "/workspace/project" } };
          }
          throw new Error(`unexpected request ${method}`);
        });
      };

      const service = await AppServerSessionService.create(createConfig(), {
        appServerClientFactory: factory,
        model: "qwen3.8-max",
      });

      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.configOverrides?.model_provider).toBe("modelstudio");
      expect(spawns[0]?.env?.DASHSCOPE_API_KEY).toBe("sk-sp-test");
      expect(service.getInfo().model).toBe("qwen3.8-max");

      // Back to a native model: the child has to be replaced, because its provider
      // and API key were fixed when it was spawned.
      service.setModel("gpt-5.5");
      await service.newThread();

      expect(spawns).toHaveLength(2);
      expect(spawns[1]?.configOverrides).toEqual({});
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("starts a clean handoff thread when switching between model vendors", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-test");
    try {
      const clients: FakeAppServerClient[] = [];
      const factory = () => {
        const clientIndex = clients.length;
        const client = new FakeAppServerClient((method, params, activeClient) => {
          if (method === "thread/start") {
            return {
              thread: {
                id: clientIndex === 0 ? "thread-qwen" : "thread-openai",
                cwd: "/workspace/project",
              },
            };
          }
          if (method === "turn/start" && clientIndex === 1) {
            setTimeout(() => {
              activeClient.emit({
                method: "turn/completed",
                params: { turn: { id: "turn-openai", status: "completed" } },
              });
            }, 0);
            return { turn: { id: "turn-openai" } };
          }
          throw new Error(`unexpected request ${method}`);
        });
        clients.push(client);
        return client;
      };

      const service = await AppServerSessionService.create(createConfig(), {
        appServerClientFactory: factory,
        model: "qwen3.8-max",
      });

      service.setModel("gpt-5.6-sol");
      expect(service.hasActiveThread()).toBe(false);
      await service.newThread();
      await service.prompt("continue on OpenAI", {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolUpdate: vi.fn(),
        onToolEnd: vi.fn(),
        onAgentEnd: vi.fn(),
      });

      expect(clients).toHaveLength(2);
      expect(clients[0]?.closed).toHaveBeenCalledOnce();
      expect(service.getInfo().threadId).toBe("thread-openai");
      const request = clients[1]?.requests.find((candidate) => candidate.method === "turn/start");
      const text = (request?.params as { input?: Array<{ text?: string }> }).input?.[0]?.text ?? "";
      expect(text).toContain("continue on OpenAI");
      expect(text).toContain("<telecode_cross_provider_handoff>");
      expect(text).toContain("thread-qwen");
      expect(text).toContain("original source thread is preserved");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the current thread when changing models inside one vendor", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-test");
    try {
      const client = new FakeAppServerClient((method) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-qwen", cwd: "/workspace/project" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const service = await AppServerSessionService.create(createConfig(), {
        appServerClientFactory: () => client,
        model: "qwen3.8-max",
      });

      service.setModel("glm-5.2");

      expect(service.hasActiveThread()).toBe(true);
      expect(service.getInfo()).toMatchObject({ threadId: "thread-qwen", model: "glm-5.2" });
      expect(client.closed).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("recovers an already-poisoned thread once and retries the same prompt", async () => {
    let threadStarts = 0;
    let turnStarts = 0;
    const client = new FakeAppServerClient((method, params, activeClient) => {
      if (method === "thread/start") {
        threadStarts += 1;
        return {
          thread: {
            id: threadStarts === 1 ? "thread-poisoned" : "thread-clean",
            cwd: "/workspace/project",
          },
          model: "gpt-5.6-sol",
        };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        if (turnStarts === 1) {
          throw new Error(
            "invalid_id_prefix: Invalid 'input[4].id': 'msg_foreign'. Expected an ID that begins with 'rs'.",
          );
        }
        setTimeout(() => {
          activeClient.emit({
            method: "turn/completed",
            params: { turn: { id: "turn-clean", status: "completed" } },
          });
        }, 0);
        return { turn: { id: "turn-clean" } };
      }
      throw new Error(`unexpected request ${method}`);
    });

    const service = await AppServerSessionService.create(createConfig({ codexModel: "gpt-5.6-sol" }), {
      appServerClientFactory: () => client,
    });
    await service.prompt("retry me", {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onAgentEnd: vi.fn(),
    });

    expect(threadStarts).toBe(2);
    expect(turnStarts).toBe(2);
    expect(service.getInfo().threadId).toBe("thread-clean");
    const retryRequest = client.requests.filter((request) => request.method === "turn/start")[1];
    const text = (retryRequest?.params as { input?: Array<{ text?: string }> }).input?.[0]?.text ?? "";
    expect(text).toContain("retry me");
    expect(text).toContain("thread-poisoned");
    expect(text).toContain("<telecode_cross_provider_handoff>");
  });
});

function createWriterHarness() {
  const clients: FakeAppServerClient[] = [];
  const owners = new Map<string, FakeAppServerClient>();
  let threadNumber = 0;
  const createClient = () => {
    const client = new FakeAppServerClient((method, params, requester) => {
      const input = params as { threadId?: string };
      const threadId = method === "thread/resume" ? input.threadId! : `thread-${++threadNumber}`;
      if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/fork") {
        throw new Error(`unexpected request ${method}`);
      }
      const owner = owners.get(threadId);
      if (owner && owner !== requester) {
        throw new Error(`thread ${threadId} already has an active writer`);
      }
      owners.set(threadId, requester);
      return { thread: { id: threadId, cwd: "/workspace/project" } };
    });
    client.closed.mockImplementation(async () => {
      for (const [threadId, owner] of owners) {
        if (owner === client) {
          owners.delete(threadId);
        }
      }
      return undefined;
    });
    clients.push(client);
    return client;
  };
  return { createClient, clients, owners };
}

function createConfig(overrides: Partial<TeleCodeConfig> = {}): TeleCodeConfig {
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
