import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS,
  probeCodexAppServer,
  runCodexAppServerSteeredTurn,
  runCodexAppServerTurn,
  type AppServerProcess,
  type SpawnAppServerProcess,
} from "../src/app-server.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodexConfig } from "../src/config.js";

class FakeAppServerProcess extends EventEmitter implements AppServerProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  private inputBuffer = "";

  constructor(private readonly responder: (message: any, process: FakeAppServerProcess) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.acceptInput(String(chunk));
        callback();
      },
    });
    this.stdin.on("finish", () => {
      queueMicrotask(() => this.emit("exit", 0, null));
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private acceptInput(chunk: string): void {
    this.inputBuffer += chunk;
    while (this.inputBuffer.includes("\n")) {
      const newlineIndex = this.inputBuffer.indexOf("\n");
      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (line) {
        this.responder(JSON.parse(line), this);
      }
    }
  }
}

describe("CodexAppServerClient", () => {
  it("sends JSON-line requests and records notifications", async () => {
    const requests: any[] = [];
    const spawnProcess: SpawnAppServerProcess = (command, args) => {
      expect(command).toBe("fake-codex");
      expect(args).toEqual(["app-server", "--listen", "stdio://"]);
      return new FakeAppServerProcess((message, process) => {
        requests.push(message);
        if (message.method === "initialize") {
          process.send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
          process.send({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: "/home/test/.codex",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
          process.send({
            id: "server-request-1",
            method: "item/fileChange/requestApproval",
            params: { reason: "test" },
          });
        } else if (message.method === "model/list") {
          process.send({ id: message.id, result: { data: [{ displayName: "GPT Test" }] } });
        }
      });
    };

    const client = new CodexAppServerClient({
      codexPath: "fake-codex",
      spawnProcess,
      requestTimeoutMs: 1000,
    });

    await client.start();
    const initialized = await client.initialize();
    client.notifyInitialized();
    await new Promise((resolve) => setImmediate(resolve));
    const models = await client.request<{ data: Array<{ displayName: string }> }>("model/list", { limit: 1 });
    await client.close();

    expect(initialized.userAgent).toBe("codex-test");
    expect(models.data[0]?.displayName).toBe("GPT Test");
    expect(client.getNotificationMethods()).toEqual(["remoteControl/status/changed"]);
    expect(requests).toContainEqual({
      id: "server-request-1",
      result: { decision: "decline" },
    });
    expect(requests[0]?.params.capabilities.optOutNotificationMethods).toEqual(
      DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS,
    );
    expect(requests.some((request) => request.method === "initialized")).toBe(true);
  });
});

describe("probeCodexAppServer", () => {
  it("returns model, thread, and notification summary on success", async () => {
    const spawnProcess: SpawnAppServerProcess = () =>
      new FakeAppServerProcess((message, process) => {
        if (message.method === "initialize") {
          process.send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
          process.send({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: "/home/test/.codex",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
        } else if (message.method === "model/list") {
          process.send({
            id: message.id,
            result: { data: [{ displayName: "GPT Test" }, { model: "gpt-other" }] },
          });
        } else if (message.method === "thread/list") {
          process.send({
            id: message.id,
            result: { data: [{ id: "thread-a" }, { id: "thread-b" }] },
          });
        }
      });

    const result = await probeCodexAppServer(createConfig(), {
      codexPath: "fake-codex",
      spawnProcess,
      requestTimeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.modelNames).toEqual(["GPT Test", "gpt-other"]);
    expect(result.threadIds).toEqual(["thread-a", "thread-b"]);
    expect(result.notifications).toEqual(["remoteControl/status/changed"]);
  });

  it("returns a failed probe when an app-server request fails", async () => {
    const spawnProcess: SpawnAppServerProcess = () =>
      new FakeAppServerProcess((message, process) => {
        if (message.method === "initialize") {
          process.send({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: "/home/test/.codex",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
        } else if (message.method === "model/list") {
          process.send({ id: message.id, error: { code: -1, message: "models unavailable" } });
        }
      });

    const result = await probeCodexAppServer(createConfig(), {
      codexPath: "fake-codex",
      spawnProcess,
      requestTimeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed probe");
    expect(result.error).toContain("model/list failed (-1): models unavailable");
  });
});

describe("runCodexAppServerTurn", () => {
  it("starts an ephemeral thread, runs a turn, and captures final agent text", async () => {
    const requests: any[] = [];
    const spawnProcess: SpawnAppServerProcess = () =>
      new FakeAppServerProcess((message, process) => {
        requests.push(message);
        if (message.method === "initialize") {
          process.send({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: "/home/test/.codex",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
        } else if (message.method === "thread/start") {
          process.send({ id: message.id, result: { thread: { id: "thread-1" } } });
        } else if (message.method === "turn/start") {
          process.send({ id: message.id, result: { turn: { id: "turn-1" } } });
          queueMicrotask(() => {
            process.send({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                completedAtMs: Date.now(),
                item: { id: "agent-1", type: "agentMessage", text: "OK", phase: null, memoryCitation: null },
              },
            });
            process.send({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  items: [],
                  itemsView: "complete",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 100,
                },
              },
            });
          });
        }
      });

    const result = await runCodexAppServerTurn(createConfig(), "say OK", {
      codexPath: "fake-codex",
      spawnProcess,
      requestTimeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.finalText).toBe("OK");
    expect(result.threadId).toBe("thread-1");
    expect(result.turnId).toBe("turn-1");
    expect(result.itemTypes).toEqual(["agentMessage"]);
    expect(requests.find((request) => request.method === "thread/start")?.params.ephemeral).toBe(true);
    expect(requests.find((request) => request.method === "turn/start")?.params.input[0].text).toBe("say OK");
  });
});

describe("runCodexAppServerSteeredTurn", () => {
  it("sends turn/steer against the active turn and captures steered final text", async () => {
    const requests: any[] = [];
    const spawnProcess: SpawnAppServerProcess = () =>
      new FakeAppServerProcess((message, process) => {
        requests.push(message);
        if (message.method === "initialize") {
          process.send({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: "/home/test/.codex",
              platformFamily: "windows",
              platformOs: "windows",
            },
          });
        } else if (message.method === "thread/start") {
          process.send({ id: message.id, result: { thread: { id: "thread-1" } } });
        } else if (message.method === "turn/start") {
          process.send({ id: message.id, result: { turn: { id: "turn-1" } } });
        } else if (message.method === "turn/steer") {
          process.send({ id: message.id, result: { turnId: "turn-1" } });
          queueMicrotask(() => {
            process.send({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                completedAtMs: Date.now(),
                item: { id: "agent-1", type: "agentMessage", text: "STEERED", phase: null, memoryCitation: null },
              },
            });
            process.send({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  items: [],
                  itemsView: "complete",
                  status: "completed",
                  error: null,
                  startedAt: 1,
                  completedAt: 2,
                  durationMs: 100,
                },
              },
            });
          });
        }
      });

    const result = await runCodexAppServerSteeredTurn(createConfig(), "initial", "steer", {
      codexPath: "fake-codex",
      spawnProcess,
      requestTimeoutMs: 1000,
      steerDelayMs: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.finalText).toBe("STEERED");
    expect(result.steerTurnId).toBe("turn-1");
    expect(requests.find((request) => request.method === "turn/steer")?.params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
    });
    expect(requests.find((request) => request.method === "turn/steer")?.params.input[0].text).toBe("steer");
  });
});

function createConfig(): TeleCodexConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "gpt-5.5",
    codexBackend: "sdk",
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
  };
}
