import type { ModelReasoningEffort } from "@openai/codex-sdk";

import {
  buildAppServerEnv,
  type AppServerClientOptions,
  CodexAppServerClient,
  DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS,
  safeAppServerServerRequestResponse,
  type AppServerInitializeResponse,
  type AppServerServerRequest,
  type JsonValue,
} from "./app-server.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CreateOptions,
} from "./codex-session.js";
import {
  getThread,
  getThreadByPrefix,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import type { TeleCodexConfig } from "./config.js";

type AppServerThread = {
  id: string;
  cwd?: string;
};

type AppServerTurn = {
  id: string;
  status?: string;
  error?: unknown;
};

type AppServerThreadItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string | null;
  status?: string;
  query?: string;
  server?: string;
  tool?: string;
  error?: { message?: string } | null;
  changes?: Array<{ kind?: string; path?: string }>;
};

export type AppServerNotification = { method: string; params?: unknown };

export interface AppServerClientLike {
  onNotification(handler: (notification: AppServerNotification) => void): void;
  onRequest(handler: (request: AppServerServerRequest) => JsonValue | undefined | Promise<JsonValue | undefined>): void;
  start(): Promise<void>;
  initialize(optOutNotificationMethods?: string[]): Promise<AppServerInitializeResponse>;
  notifyInitialized(): void;
  request<T = unknown>(method: string, params: JsonValue | undefined): Promise<T>;
  close(): Promise<void>;
}

export type AppServerClientFactory = (options: AppServerClientOptions) => AppServerClientLike;

type AppServerCreateOptions = CreateOptions & {
  appServerClientFactory?: AppServerClientFactory;
};

export class AppServerSessionService {
  private client: AppServerClientLike | null = null;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: ModelReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private activeTurnId: string | null = null;
  private activeCallbacks: CodexSessionCallbacks | null = null;
  private activeResolve: (() => void) | null = null;
  private activeReject: ((error: Error) => void) | null = null;
  private finalText = "";
  private readonly lastCommandOutput = new Map<string, string>();
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(
    private readonly config: TeleCodexConfig,
    private readonly createClient: AppServerClientFactory = (options) => new CodexAppServerClient(options),
  ) {
    this.currentWorkspace = config.workspace;
    this.currentModel = config.codexModel;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodexConfig, options?: AppServerCreateOptions): Promise<AppServerSessionService> {
    const service = new AppServerSessionService(config, options?.appServerClientFactory);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.codexModel;
    service.currentReasoningEffort = options?.reasoningEffort as ModelReasoningEffort | undefined;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const info: CodexSessionInfo = {
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (this.currentReasoningEffort) {
      info.reasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    return info;
  }

  isProcessing(): boolean {
    return this.activeTurnId !== null;
  }

  hasActiveThread(): boolean {
    return this.currentThreadId !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("Codex thread is not initialized");
    }
    this.ensureIdle("start a turn");

    const client = await this.getClient();
    this.activeCallbacks = callbacks;
    this.finalText = "";
    this.lastCommandOutput.clear();

    const completed = new Promise<void>((resolve, reject) => {
      this.activeResolve = resolve;
      this.activeReject = reject;
    });

    try {
      const response = await client.request<{ turn: AppServerTurn }>("turn/start", {
        threadId: this.currentThreadId,
        input: this.buildAppServerInput(input),
        cwd: this.currentWorkspace,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        model: this.currentModel ?? null,
        effort: this.currentReasoningEffort ?? null,
      });
      this.activeTurnId = response.turn.id;
      await completed;
    } finally {
      this.activeTurnId = null;
      this.activeCallbacks = null;
      this.activeResolve = null;
      this.activeReject = null;
      this.lastCommandOutput.clear();
    }
  }

  async abort(): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      return;
    }
    const client = await this.getClient();
    await client.request("turn/interrupt", {
      threadId: this.currentThreadId,
      turnId: this.activeTurnId,
    });
  }

  async steer(input: CodexPromptInput): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      throw new Error("No active app-server turn to steer");
    }

    const client = await this.getClient();
    await client.request("turn/steer", {
      threadId: this.currentThreadId,
      expectedTurnId: this.activeTurnId,
      input: this.buildAppServerInput(input),
    });
  }

  async forkThread(): Promise<CodexSessionInfo> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to fork");
    }
    this.ensureIdle("fork thread");

    const client = await this.getClient();
    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/fork",
      {
        threadId: this.currentThreadId,
        cwd: this.currentWorkspace,
        model: this.currentModel ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
      },
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = response.thread.id;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? this.currentWorkspace;
    if (response.model) {
      this.currentModel = response.model;
    }
    return this.getInfo();
  }

  async compactThread(): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to compact");
    }
    this.ensureIdle("compact thread");

    const client = await this.getClient();
    await client.request("thread/compact/start", { threadId: this.currentThreadId });
  }

  async renameThread(name: string): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to rename");
    }
    this.ensureIdle("rename thread");

    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Thread name cannot be empty");
    }

    const client = await this.getClient();
    await client.request("thread/name/set", {
      threadId: this.currentThreadId,
      name: trimmed,
    });
  }

  async rollbackThread(turnCount: number): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to roll back");
    }
    this.ensureIdle("roll back thread");

    if (!Number.isInteger(turnCount) || turnCount < 1) {
      throw new Error("Rollback turn count must be a whole number of at least 1");
    }

    const client = await this.getClient();
    await client.request("thread/rollback", {
      threadId: this.currentThreadId,
      numTurns: turnCount,
    });
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    const client = await this.getClient();
    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/start",
      {
        cwd: effectiveWorkspace,
        model: effectiveModel ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
      },
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? effectiveWorkspace;
    this.currentThreadId = response.thread.id;
    if (model || response.model) {
      this.currentModel = response.model ?? model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    const client = await this.getClient();
    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/resume",
      {
        threadId,
        cwd: this.currentWorkspace,
        model: this.currentModel ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
      },
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = response.thread.id;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? this.currentWorkspace;
    if (response.model) {
      this.currentModel = response.model;
    }
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = this.resolveThread(threadId);
    const resolvedThreadId = record?.id ?? threadId;
    if (record?.cwd) {
      this.currentWorkspace = record.cwd;
    }
    if (record?.model) {
      this.currentModel = record.model;
    }
    return await this.resumeThread(resolvedThreadId);
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    return listThreads(limit ?? 20);
  }

  listWorkspaces(): string[] {
    return uniqueWorkspaces([this.currentWorkspace, this.config.workspace, ...listWorkspaces()]);
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  setModel(slug: string): string {
    this.ensureIdle("change model");
    this.currentModel = slug;
    return slug;
  }

  async runText(input: CodexPromptInput): Promise<string> {
    let text = "";
    await this.prompt(input, {
      onTextDelta: (delta) => {
        text += delta;
      },
      onToolStart: () => undefined,
      onToolUpdate: () => undefined,
      onToolEnd: () => undefined,
      onAgentEnd: () => undefined,
    });
    return text;
  }

  setReasoningEffort(effort: ModelReasoningEffort): void {
    this.ensureIdle("change reasoning effort");
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change launch profile");
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    void this.client?.close();
    this.client = null;
    return info;
  }

  dispose(): void {
    void this.client?.close();
    this.client = null;
    this.currentThreadId = null;
    this.activeTurnId = null;
    this.activeThreadLaunchProfile = null;
  }

  private async getClient(): Promise<AppServerClientLike> {
    if (this.client) {
      return this.client;
    }

    const client = this.createClient({
      codexPath: this.config.codexAppServerPath,
      cwd: this.config.workspace,
      env: buildAppServerEnv(this.config.codexApiKey),
    });
    client.onNotification((notification) => this.handleNotification(notification));
    client.onRequest((request) => this.handleServerRequest(request));
    await client.start();
    await client.initialize(DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS);
    client.notifyInitialized();
    this.client = client;
    return client;
  }

  private handleNotification(notification: AppServerNotification): void {
    const callbacks = this.activeCallbacks;
    if (!callbacks) {
      return;
    }

    if (notification.method === "item/started") {
      const item = getNotificationItem(notification);
      if (!item || !this.isActiveTurn(notification)) {
        return;
      }
      if (item.type === "commandExecution" && item.command) {
        this.lastCommandOutput.set(item.id, item.aggregatedOutput ?? "");
        callbacks.onToolStart(item.command, item.id);
      } else if (item.type === "webSearch" && item.query) {
        callbacks.onToolStart(`search ${item.query.slice(0, 60)}`, item.id);
        callbacks.onToolUpdate(item.id, item.query);
      }
      return;
    }

    if (notification.method === "item/commandExecution/outputDelta") {
      const params = notification.params as { turnId?: string; itemId?: string; delta?: string } | undefined;
      if (params?.turnId !== this.activeTurnId || !params.itemId || !params.delta) {
        return;
      }
      this.lastCommandOutput.set(params.itemId, (this.lastCommandOutput.get(params.itemId) ?? "") + params.delta);
      callbacks.onToolUpdate(params.itemId, params.delta);
      return;
    }

    if (notification.method === "item/completed") {
      const item = getNotificationItem(notification);
      if (!item || !this.isActiveTurn(notification)) {
        return;
      }
      this.handleCompletedItem(item, callbacks);
      return;
    }

    if (notification.method === "thread/tokenUsage/updated") {
      const usage = readTokenUsage(notification.params);
      if (usage) {
        this.sessionTokens = usage;
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const params = notification.params as { turn?: AppServerTurn } | undefined;
      if (params?.turn?.id !== this.activeTurnId) {
        return;
      }
      if (params.turn.status === "failed") {
        this.activeReject?.(new Error(formatTurnError(params.turn.error)));
      } else {
        callbacks.onAgentEnd();
        this.activeResolve?.();
      }
    }
  }

  private handleServerRequest(request: AppServerServerRequest): JsonValue | undefined {
    const response = safeAppServerServerRequestResponse(request.method);
    if (response === undefined) {
      return undefined;
    }

    const callbacks = this.activeCallbacks;
    if (callbacks) {
      const itemId = `server-request:${request.id}`;
      callbacks.onToolStart("app_server_request", itemId);
      callbacks.onToolUpdate(itemId, `Handled ${request.method} with a safe default response.`);
      callbacks.onToolEnd(itemId, true);
    }

    return response;
  }

  private handleCompletedItem(item: AppServerThreadItem, callbacks: CodexSessionCallbacks): void {
    if (item.type === "agentMessage") {
      const delta = computeTextDelta(this.finalText, item.text ?? "");
      this.finalText = item.text ?? "";
      if (delta) {
        callbacks.onTextDelta(delta);
      }
    } else if (item.type === "commandExecution") {
      const prev = this.lastCommandOutput.get(item.id) ?? "";
      const output = item.aggregatedOutput ?? "";
      const delta = computeTextDelta(prev, output);
      if (delta) {
        callbacks.onToolUpdate(item.id, delta);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
    } else if (item.type === "fileChange") {
      const summary = (item.changes ?? []).map((change) => `${change.kind} ${change.path}`).join(", ");
      callbacks.onToolStart("file_change", item.id);
      callbacks.onToolUpdate(item.id, summary);
      callbacks.onToolEnd(item.id, item.status === "failed");
    } else if (item.type === "mcpToolCall") {
      callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
      if (item.error?.message) {
        callbacks.onToolUpdate(item.id, item.error.message);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
    } else if (item.type === "webSearch") {
      callbacks.onToolEnd(item.id, false);
    }
  }

  private isActiveTurn(notification: AppServerNotification): boolean {
    const params = notification.params as { turnId?: unknown } | undefined;
    return typeof params?.turnId === "string" && params.turnId === this.activeTurnId;
  }

  private buildAppServerInput(input: CodexPromptInput): JsonValue[] {
    if (typeof input === "string") {
      return [{ type: "text", text: input, text_elements: [] }];
    }

    const result: JsonValue[] = [];
    const textParts = [input.stagedFileInstructions, input.text].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (textParts.length > 0) {
      result.push({ type: "text", text: textParts.join("\n\n"), text_elements: [] });
    }
    for (const imagePath of input.imagePaths ?? []) {
      result.push({ type: "localImage", path: imagePath });
    }
    return result.length > 0 ? result : [{ type: "text", text: "", text_elements: [] }];
  }

  private ensureIdle(action: string): void {
    if (this.activeTurnId) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private resetSessionTokens(): void {
    this.sessionTokens = { input: 0, cached: 0, output: 0 };
  }

  private resolveThread(threadIdOrPrefix: string): CodexThreadRecord | null {
    const value = threadIdOrPrefix.trim();
    if (value.toLowerCase() === "latest") {
      return listThreads(1)[0] ?? null;
    }
    return getThread(value) ?? getThreadByPrefix(value);
  }
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function getNotificationItem(notification: AppServerNotification): AppServerThreadItem | null {
  const params = notification.params as { item?: AppServerThreadItem } | undefined;
  return params?.item ?? null;
}

function readTokenUsage(params: unknown): { input: number; cached: number; output: number } | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const record = params as {
    usage?: { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown };
    tokenUsage?: { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown };
  };
  const usage = record.usage ?? record.tokenUsage;
  if (!usage) {
    return null;
  }
  return {
    input: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
    cached: typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : 0,
    output: typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
  };
}

function formatTurnError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "app-server turn failed";
  }
  const record = error as { message?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message : "app-server turn failed";
  return typeof record.code === "string" ? `${message} (${record.code})` : message;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function uniqueWorkspaces(workspaces: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const workspace of workspaces) {
    const trimmed = workspace.trim();
    if (!trimmed) {
      continue;
    }

    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}
