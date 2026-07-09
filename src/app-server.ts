import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { TeleCodexConfig } from "./config.js";

const REQUEST_TIMEOUT_MS = 15000;
const TURN_TIMEOUT_MS = 120000;
const CODEX_NPM_NAME = "@openai/codex";
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

export const DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS = [
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AppServerProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnAppServerProcess = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => AppServerProcess;

export interface AppServerClientOptions {
  codexPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: SpawnAppServerProcess;
}

export type AppServerServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

export type AppServerServerRequestHandler = (
  request: AppServerServerRequest,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface AppServerInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface AppServerModelSummary {
  id: string;
  model: string;
  displayName: string;
}

export interface AppServerThreadSummary {
  id: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  source: unknown;
}

export type AppServerProbeResult =
  | {
      ok: true;
      backend: string;
      durationMs: number;
      userAgent: string;
      codexHome: string;
      platform: string;
      modelCount: number;
      modelNames: string[];
      threadCount: number;
      threadIds: string[];
      notifications: string[];
      optOutNotificationMethods: string[];
    }
  | {
      ok: false;
      backend: string;
      durationMs: number;
      error: string;
      notifications: string[];
      optOutNotificationMethods: string[];
    };

export type AppServerTurnResult =
  | {
      ok: true;
      backend: string;
      durationMs: number;
      threadId: string;
      turnId: string;
      finalText: string;
      notifications: string[];
      itemTypes: string[];
      optOutNotificationMethods: string[];
    }
  | {
      ok: false;
      backend: string;
      durationMs: number;
      error: string;
      notifications: string[];
      itemTypes: string[];
      optOutNotificationMethods: string[];
    };

export type AppServerSteerResult =
  | {
      ok: true;
      backend: string;
      durationMs: number;
      threadId: string;
      turnId: string;
      steerTurnId: string;
      steerDelayMs: number;
      finalText: string;
      notifications: string[];
      itemTypes: string[];
      optOutNotificationMethods: string[];
    }
  | {
      ok: false;
      backend: string;
      durationMs: number;
      steerDelayMs: number;
      error: string;
      notifications: string[];
      itemTypes: string[];
      optOutNotificationMethods: string[];
    };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

type AppServerWireMessage =
  | {
      id: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    }
  | { method: string; params?: unknown };

export class CodexAppServerClient {
  private child: AppServerProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notifications: Array<{ method: string; params?: unknown }> = [];
  private readonly notificationHandlers = new Set<(notification: { method: string; params?: unknown }) => void>();
  private readonly requestHandlers = new Set<AppServerServerRequestHandler>();
  private readonly exitHandlers = new Set<(error: Error) => void>();
  private readonly stderrChunks: Buffer[] = [];
  private readlineInterface: readline.Interface | null = null;
  private closing = false;
  private exitEmitted = false;

  constructor(private readonly options: AppServerClientOptions = {}) {}

  getNotificationMethods(): string[] {
    return this.notifications.map((notification) => notification.method);
  }

  onNotification(handler: (notification: { method: string; params?: unknown }) => void): void {
    this.notificationHandlers.add(handler);
  }

  onRequest(handler: AppServerServerRequestHandler): void {
    this.requestHandlers.add(handler);
  }

  onExit(handler: (error: Error) => void): void {
    this.exitHandlers.add(handler);
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.closing = false;
    this.exitEmitted = false;
    const codexPath = this.options.codexPath ?? resolveBundledCodexPath();
    const env = this.options.env ?? buildAppServerEnv();
    const spawnProcess = this.options.spawnProcess ?? defaultSpawnAppServerProcess;
    const child = spawnProcess(codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.options.cwd,
      env,
    });

    this.child = child;
    child.stdin.on("error", (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectAllPending(normalized);
      this.emitExit(normalized);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.once("error", (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectAllPending(normalized);
      this.emitExit(normalized);
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.readlineInterface?.close();
      this.readlineInterface = null;
      this.child = null;
      if (!this.closing) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
        const error = new Error(`Codex app-server exited with ${detail}: ${this.stderrText()}`.trim());
        this.rejectAllPending(error);
        this.emitExit(error);
      }
    });

    this.readlineInterface = readline.createInterface({ input: child.stdout });
    this.readlineInterface.on("line", (line) => this.handleLine(line));
  }

  async initialize(optOutNotificationMethods = DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS): Promise<AppServerInitializeResponse> {
    return await this.request<AppServerInitializeResponse>("initialize", {
      clientInfo: {
        name: "telecodex",
        title: "TeleCodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods,
      },
    });
  }

  notifyInitialized(): void {
    this.notify("initialized");
  }

  async request<T = unknown>(method: string, params: JsonValue | undefined): Promise<T> {
    const child = this.child;
    if (!child) {
      throw new Error("Codex app-server is not started");
    }

    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const payload = { method, id, params };
    const line = `${JSON.stringify(payload)}\n`;

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for app-server response to ${method}`));
      }, timeoutMs);

      this.pending.set(String(id), {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    try {
      child.stdin.write(line, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(String(id));
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        pending.reject(new Error(`Failed writing app-server request ${method}: ${error.message}`));
      });
    } catch (error) {
      const pending = this.pending.get(String(id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        pending.reject(new Error(`Failed writing app-server request ${method}: ${formatUnknownError(error)}`));
      }
    }
    return await resultPromise;
  }

  notify(method: string, params?: JsonValue): void {
    const child = this.child;
    if (!child) {
      throw new Error("Codex app-server is not started");
    }
    const payload = params === undefined ? { method } : { method, params };
    writeAppServerLine(child, `${JSON.stringify(payload)}\n`, `notification ${method}`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.closing = true;
    this.rejectAllPending(new Error("Codex app-server client closed"));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
    this.readlineInterface?.close();
    this.readlineInterface = null;
    this.child = null;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: AppServerWireMessage;
    try {
      message = JSON.parse(trimmed) as AppServerWireMessage;
    } catch {
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      }).catch((error) => {
        this.sendErrorResponse(message.id, error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(formatAppServerError(message.error, pending.method)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message) {
      const notification = { method: message.method, params: message.params };
      this.notifications.push(notification);
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitExit(error: Error): void {
    if (this.closing || this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    for (const handler of this.exitHandlers) {
      handler(error);
    }
  }

  private async handleServerRequest(request: AppServerServerRequest): Promise<void> {
    for (const handler of this.requestHandlers) {
      const result = await handler(request);
      if (result !== undefined) {
        this.sendResultResponse(request.id, result);
        return;
      }
    }

    const safeResponse = safeAppServerServerRequestResponse(request.method);
    if (safeResponse !== undefined) {
      this.sendResultResponse(request.id, safeResponse);
      return;
    }

    this.sendErrorResponse(request.id, `Unsupported app-server request: ${request.method}`);
  }

  private sendResultResponse(id: number | string, result: JsonValue): void {
    const child = this.child;
    if (!child) {
      return;
    }
    writeAppServerLine(child, `${JSON.stringify({ id, result })}\n`, `server response ${id}`);
  }

  private sendErrorResponse(id: number | string, message: string): void {
    const child = this.child;
    if (!child) {
      return;
    }
    writeAppServerLine(child, `${JSON.stringify({ id, error: { code: -32601, message } })}\n`, `server error ${id}`);
  }

  private stderrText(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8").trim();
  }
}

function writeAppServerLine(child: AppServerProcess, line: string, description: string): void {
  try {
    child.stdin.write(line, (error) => {
      if (error) {
        console.warn(`Failed writing app-server ${description}:`, error);
      }
    });
  } catch (error) {
    console.warn(`Failed writing app-server ${description}:`, error);
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeAppServerServerRequestResponse(method: string): JsonValue | undefined {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null };
    case "item/tool/call":
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "TeleCodex does not support this app-server tool request yet.",
          },
        ],
      };
    default:
      return undefined;
  }
}

export async function probeCodexAppServer(
  config: TeleCodexConfig,
  options: AppServerClientOptions = {},
): Promise<AppServerProbeResult> {
  const startedAt = Date.now();
  const optOutNotificationMethods = DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS;
  const client = new CodexAppServerClient({
    codexPath: config.codexAppServerPath,
    env: buildAppServerEnv(config.codexApiKey),
    cwd: config.workspace,
    ...options,
  });

  try {
    await client.start();
    const initialized = await client.initialize(optOutNotificationMethods);
    client.notifyInitialized();
    const models = await client.request<{ data?: unknown[] }>("model/list", {
      limit: 5,
      includeHidden: false,
    });
    const threads = await client.request<{ data?: unknown[] }>("thread/list", {
      limit: 5,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "exec", "appServer", "vscode", "unknown"],
      archived: false,
      useStateDbOnly: true,
    });

    return {
      ok: true,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      userAgent: initialized.userAgent,
      codexHome: initialized.codexHome,
      platform: `${initialized.platformFamily}/${initialized.platformOs}`,
      modelCount: models.data?.length ?? 0,
      modelNames: (models.data ?? []).map(formatModelName).filter(Boolean).slice(0, 5),
      threadCount: threads.data?.length ?? 0,
      threadIds: (threads.data ?? []).map(formatThreadId).filter(Boolean).slice(0, 5),
      notifications: client.getNotificationMethods(),
      optOutNotificationMethods,
    };
  } catch (error) {
    return {
      ok: false,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      notifications: client.getNotificationMethods(),
      optOutNotificationMethods,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runCodexAppServerTurn(
  config: TeleCodexConfig,
  prompt: string,
  options: AppServerClientOptions = {},
): Promise<AppServerTurnResult> {
  const startedAt = Date.now();
  const optOutNotificationMethods = DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS;
  const itemTypes: string[] = [];
  let finalText = "";
  let activeTurnId = "";
  const completedTurnIds = new Set<string>();
  let resolveCompleted: (() => void) | undefined;
  let rejectCompleted: ((error: Error) => void) | undefined;
  const completedPromise = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  const client = new CodexAppServerClient({
    codexPath: config.codexAppServerPath,
    env: buildAppServerEnv(config.codexApiKey),
    cwd: config.workspace,
    ...options,
  });

  client.onNotification((notification) => {
    if (notification.method === "item/completed") {
      const params = notification.params as { item?: { type?: unknown; text?: unknown; phase?: unknown } } | undefined;
      const itemType = typeof params?.item?.type === "string" ? params.item.type : "";
      if (itemType) {
        itemTypes.push(itemType);
      }
      if (
        itemType === "agentMessage" &&
        typeof params?.item?.text === "string" &&
        shouldUseAgentMessageAsFinalText(params.item.phase)
      ) {
        finalText = params.item.text;
      }
    } else if (notification.method === "turn/completed") {
      const params = notification.params as { turn?: { id?: unknown; status?: unknown; error?: unknown } } | undefined;
      const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
      if (turnId) {
        completedTurnIds.add(turnId);
      }
      if (!activeTurnId || turnId !== activeTurnId) {
        return;
      }
      if (params?.turn?.status === "failed") {
        rejectCompleted?.(new Error(formatTurnError(params.turn.error)));
      } else {
        resolveCompleted?.();
      }
    } else if (notification.method === "error") {
      const params = notification.params as { error?: { message?: unknown }; message?: unknown } | undefined;
      const message = firstString(params?.error?.message, params?.message) || "app-server sent an error notification";
      rejectCompleted?.(new Error(message));
    }
  });

  try {
    await client.start();
    await client.initialize(optOutNotificationMethods);
    client.notifyInitialized();

    const threadStart = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: config.workspace,
      model: config.codexModel ?? null,
      approvalPolicy: config.codexApprovalPolicy,
      sandbox: config.codexSandboxMode,
      ephemeral: true,
    });
    const threadId = threadStart.thread.id;
    const turnStart = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: config.workspace,
      approvalPolicy: config.codexApprovalPolicy,
      model: config.codexModel ?? null,
    });
    activeTurnId = turnStart.turn.id;

    if (completedTurnIds.has(activeTurnId)) {
      resolveCompleted?.();
    }

    await withTimeout(completedPromise, options.requestTimeoutMs ?? TURN_TIMEOUT_MS, "Timed out waiting for app-server turn to complete");

    return {
      ok: true,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      threadId,
      turnId: activeTurnId,
      finalText,
      notifications: client.getNotificationMethods(),
      itemTypes,
      optOutNotificationMethods,
    };
  } catch (error) {
    return {
      ok: false,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      notifications: client.getNotificationMethods(),
      itemTypes,
      optOutNotificationMethods,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runCodexAppServerSteeredTurn(
  config: TeleCodexConfig,
  initialPrompt: string,
  steerPrompt: string,
  options: AppServerClientOptions & { steerDelayMs?: number } = {},
): Promise<AppServerSteerResult> {
  const startedAt = Date.now();
  const steerDelayMs = options.steerDelayMs ?? 1500;
  const optOutNotificationMethods = DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS;
  const itemTypes: string[] = [];
  let finalText = "";
  let activeTurnId = "";
  const completedTurnIds = new Set<string>();
  let resolveCompleted: (() => void) | undefined;
  let rejectCompleted: ((error: Error) => void) | undefined;
  const completedPromise = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  const client = new CodexAppServerClient({
    codexPath: config.codexAppServerPath,
    env: buildAppServerEnv(config.codexApiKey),
    cwd: config.workspace,
    ...options,
  });

  client.onNotification((notification) => {
    if (notification.method === "item/completed") {
      const params = notification.params as { item?: { type?: unknown; text?: unknown; phase?: unknown } } | undefined;
      const itemType = typeof params?.item?.type === "string" ? params.item.type : "";
      if (itemType) {
        itemTypes.push(itemType);
      }
      if (
        itemType === "agentMessage" &&
        typeof params?.item?.text === "string" &&
        shouldUseAgentMessageAsFinalText(params.item.phase)
      ) {
        finalText = params.item.text;
      }
    } else if (notification.method === "turn/completed") {
      const params = notification.params as { turn?: { id?: unknown; status?: unknown; error?: unknown } } | undefined;
      const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
      if (turnId) {
        completedTurnIds.add(turnId);
      }
      if (!activeTurnId || turnId !== activeTurnId) {
        return;
      }
      if (params?.turn?.status === "failed") {
        rejectCompleted?.(new Error(formatTurnError(params.turn.error)));
      } else {
        resolveCompleted?.();
      }
    } else if (notification.method === "error") {
      const params = notification.params as { error?: { message?: unknown }; message?: unknown } | undefined;
      const message = firstString(params?.error?.message, params?.message) || "app-server sent an error notification";
      rejectCompleted?.(new Error(message));
    }
  });

  try {
    await client.start();
    await client.initialize(optOutNotificationMethods);
    client.notifyInitialized();

    const threadStart = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: config.workspace,
      model: config.codexModel ?? null,
      approvalPolicy: config.codexApprovalPolicy,
      sandbox: config.codexSandboxMode,
      ephemeral: true,
    });
    const threadId = threadStart.thread.id;
    const turnStart = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: initialPrompt, text_elements: [] }],
      cwd: config.workspace,
      approvalPolicy: config.codexApprovalPolicy,
      model: config.codexModel ?? null,
    });
    activeTurnId = turnStart.turn.id;

    await sleep(steerDelayMs);
    const steerResponse = await client.request<{ turnId?: string }>("turn/steer", {
      threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: steerPrompt, text_elements: [] }],
    });

    if (completedTurnIds.has(activeTurnId)) {
      resolveCompleted?.();
    }

    await withTimeout(completedPromise, options.requestTimeoutMs ?? TURN_TIMEOUT_MS, "Timed out waiting for app-server turn to complete");

    return {
      ok: true,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      threadId,
      turnId: activeTurnId,
      steerTurnId: steerResponse.turnId ?? activeTurnId,
      steerDelayMs,
      finalText,
      notifications: client.getNotificationMethods(),
      itemTypes,
      optOutNotificationMethods,
    };
  } catch (error) {
    return {
      ok: false,
      backend: config.codexBackend,
      durationMs: Date.now() - startedAt,
      steerDelayMs,
      error: error instanceof Error ? error.message : String(error),
      notifications: client.getNotificationMethods(),
      itemTypes,
      optOutNotificationMethods,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function defaultSpawnAppServerProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): AppServerProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function buildAppServerEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (!env.HOME && env.USERPROFILE) {
    env.HOME = env.USERPROFILE;
  }
  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}

export function resolveCodexBinaryPath(vendorRoot: string, targetTriple: string, binaryName: string): string | null {
  const packageRoot = path.join(vendorRoot, targetTriple);
  const currentPath = path.join(packageRoot, "bin", binaryName);
  if (existsSync(currentPath)) {
    return currentPath;
  }

  const legacyPath = path.join(packageRoot, "codex", binaryName);
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}

function resolveBundledCodexPath(): string {
  const platformPackage = getPlatformPackage();
  if (!platformPackage) {
    return "codex";
  }

  try {
    const moduleRequire = createRequire(import.meta.url);
    const codexPackageJsonPath = moduleRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    const targetTriple = getTargetTriple();
    const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
    return resolveCodexBinaryPath(path.join(path.dirname(platformPackageJsonPath), "vendor"), targetTriple, binaryName) ?? "codex";
  } catch {
    return "codex";
  }
}

function getPlatformPackage(): string | null {
  const targetTriple = getTargetTriple();
  return PLATFORM_PACKAGE_BY_TARGET[targetTriple] ?? null;
}

function getTargetTriple(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-musl";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-musl";

  return `${arch}-${platform}`;
}

function formatAppServerError(error: { message?: string; code?: number; data?: unknown }, method: string): string {
  const message = error.message || "Unknown app-server error";
  const code = error.code === undefined ? "" : ` (${error.code})`;
  return `${method} failed${code}: ${message}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTurnError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "app-server turn failed";
  }
  const record = error as { message?: unknown; code?: unknown };
  const message = firstString(record.message) || "app-server turn failed";
  return typeof record.code === "string" ? `${message} (${record.code})` : message;
}

function shouldUseAgentMessageAsFinalText(phase: unknown): boolean {
  return phase === null || phase === undefined || phase === "final_answer" || phase === "final";
}

function formatModelName(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as { displayName?: unknown; model?: unknown; id?: unknown };
  return firstString(record.displayName, record.model, record.id);
}

function formatThreadId(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as { id?: unknown };
  return typeof record.id === "string" ? record.id : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}
