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
  type CodexThreadGoal,
  type CodexThreadGoalSetParams,
  type CodexSessionInfo,
  type CreateOptions,
} from "./codex-session.js";
import {
  getThread,
  getThreadByPrefix,
  listModels,
  listThreads,
  listWorkspaces,
  readThreadHistory,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import type { TeleCodeConfig } from "./config.js";
import {
  buildVendorCodexConfig,
  buildVendorCodexEnv,
  resolveVendorModel,
  type ResolvedVendorModel,
} from "./model-vendors.js";
import type { CodexReasoningEffort } from "./reasoning-effort.js";

type AppServerThread = {
  id: string;
  cwd?: string;
  turns?: Array<{ id: string }>;
};

type AppServerTurn = {
  id: string;
  status?: string;
  error?: unknown;
};

type AppServerThreadItem = {
  id: string;
  type: string;
  phase?: string | null;
  text?: string;
  command?: string;
  aggregatedOutput?: string | null;
  status?: string;
  query?: string;
  server?: string;
  tool?: string;
  namespace?: string | null;
  success?: boolean | null;
  result?: string;
  prompt?: string | null;
  savedPath?: string | null;
  path?: string;
  error?: { message?: string } | null;
  changes?: Array<{ kind?: string; path?: string }>;
  contentItems?: Array<{ type?: string; text?: string; imageUrl?: string }> | null;
  receiverThreadIds?: string[];
};

export type AppServerNotification = { method: string; params?: unknown };

export interface AppServerClientLike {
  onNotification(handler: (notification: AppServerNotification) => void): void;
  onRequest(handler: (request: AppServerServerRequest) => JsonValue | undefined | Promise<JsonValue | undefined>): void;
  start(): Promise<void>;
  initialize(optOutNotificationMethods?: string[]): Promise<AppServerInitializeResponse>;
  notifyInitialized(): void;
  request<T = unknown>(method: string, params: JsonValue | undefined, requestTimeoutMs?: number): Promise<T>;
  close(): Promise<void>;
  onExit?(handler: (error: Error) => void): void;
}

export type AppServerClientFactory = (options: AppServerClientOptions) => AppServerClientLike;

type AppServerCreateOptions = CreateOptions & {
  appServerClientFactory?: AppServerClientFactory;
};

const ABORT_SETTLE_GRACE_MS = 750;
const ABORT_INTERRUPT_TIMEOUT_MS = 3_000;
const GOAL_IDLE_PROGRESS_MS = 5 * 60_000;
const PROVIDER_HANDOFF_HISTORY_LIMIT = 16;
const PROVIDER_HANDOFF_MESSAGE_CHAR_LIMIT = 12_000;
const PROVIDER_HANDOFF_TOTAL_CHAR_LIMIT = 80_000;
// Starting or resuming a thread can initialize configured MCP servers. The
// normal 15-second RPC timeout is too short when external servers such as the
// Hermes browser bridge and cua-driver are starting cold.
const THREAD_LIFECYCLE_TIMEOUT_MS = 60_000;

type ActiveRunKind = "prompt" | "goal";

type ProviderHandoff = {
  sourceThreadId: string;
};

export class AppServerSessionService {
  private client: AppServerClientLike | null = null;
  private clientClosePromise: Promise<void> = Promise.resolve();
  private appServerAttachedThreadId: string | null = null;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentVendor: ResolvedVendorModel | null = null;
  private currentReasoningEffort: CodexReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private activeRunKind: ActiveRunKind | null = null;
  private activeTurnId: string | null = null;
  private activeCallbacks: CodexSessionCallbacks | null = null;
  private activeResolve: (() => void) | null = null;
  private activeReject: ((error: Error) => void) | null = null;
  private activeGoal: CodexThreadGoal | null = null;
  private activeGoalCleared = false;
  private pendingProviderHandoff: ProviderHandoff | null = null;
  private goalIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly agentTextByPhase = new Map<string, string>();
  private readonly lastCommandOutput = new Map<string, string>();
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(
    private readonly config: TeleCodeConfig,
    private readonly createClient: AppServerClientFactory = (options) => new CodexAppServerClient(options),
  ) {
    this.currentWorkspace = config.workspace;
    this.applyModel(config.codexModel);
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodeConfig, options?: AppServerCreateOptions): Promise<AppServerSessionService> {
    const service = new AppServerSessionService(config, options?.appServerClientFactory);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.applyModel(options?.model ?? config.codexModel);
    service.currentReasoningEffort = options?.reasoningEffort as CodexReasoningEffort | undefined;
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
    return this.activeRunKind !== null || this.activeTurnId !== null;
  }

  getProcessingKind(): ActiveRunKind | null {
    return this.activeRunKind;
  }

  hasActiveThread(): boolean {
    return this.currentThreadId !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    let recoveredNonPortableHistory = false;
    while (true) {
      try {
        await this.promptOnce(input, callbacks);
        return;
      } catch (error) {
        if (
          recoveredNonPortableHistory ||
          !isNonPortableResponseItemIdError(error) ||
          !this.currentThreadId
        ) {
          throw error;
        }

        const sourceThreadId = this.currentThreadId;
        this.pendingProviderHandoff = { sourceThreadId };
        this.currentThreadId = null;
        this.appServerAttachedThreadId = null;
        this.activeThreadLaunchProfile = null;
        await this.newThread(this.currentWorkspace, this.currentModel);
        recoveredNonPortableHistory = true;
      }
    }
  }

  private async promptOnce(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("Codex thread is not initialized");
    }
    this.ensureIdle("start a turn");

    this.activeRunKind = "prompt";
    this.activeCallbacks = callbacks;
    this.agentTextByPhase.clear();
    this.lastCommandOutput.clear();

    const completed = new Promise<void>((resolve, reject) => {
      this.activeResolve = resolve;
      this.activeReject = reject;
    });

    try {
      const includedHandoff = this.pendingProviderHandoff;
      const response = await this.requestCurrentThread<{ turn: AppServerTurn }>("turn/start", (threadId) => ({
        threadId,
        input: this.buildAppServerInput(input),
        cwd: this.currentWorkspace,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        model: this.currentModel ?? null,
        effort: this.currentReasoningEffort ?? null,
      }));
      if (includedHandoff && this.pendingProviderHandoff === includedHandoff) {
        this.pendingProviderHandoff = null;
      }
      this.activeTurnId = response.turn.id;
      await completed;
    } finally {
      this.clearActiveRunState();
    }
  }

  async getThreadGoal(): Promise<CodexThreadGoal | null> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to inspect");
    }
    if (this.activeRunKind === "goal" && this.activeGoal) {
      return this.activeGoal;
    }

    const response = await this.requestCurrentThread<{ goal: CodexThreadGoal | null }>(
      "thread/goal/get",
      (threadId) => ({ threadId }),
    );
    return response.goal ? normalizeThreadGoal(response.goal) : null;
  }

  async setThreadGoal(params: CodexThreadGoalSetParams): Promise<CodexThreadGoal> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to update");
    }

    const response = await this.requestCurrentThread<{ goal: CodexThreadGoal }>(
      "thread/goal/set",
      (threadId) => buildThreadGoalSetRequest(threadId, params),
    );
    return normalizeThreadGoal(response.goal);
  }

  async clearThreadGoal(): Promise<boolean> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to update");
    }

    const response = await this.requestCurrentThread<{ cleared: boolean }>(
      "thread/goal/clear",
      (threadId) => ({ threadId }),
    );
    return Boolean(response.cleared);
  }

  async runThreadGoal(
    params: CodexThreadGoalSetParams,
    callbacks: CodexSessionCallbacks,
  ): Promise<CodexThreadGoal | null> {
    if (!this.currentThreadId) {
      throw new Error("Codex thread is not initialized");
    }
    this.ensureIdle("start a goal");

    this.activeRunKind = "goal";
    this.activeCallbacks = callbacks;
    this.activeGoal = null;
    this.activeGoalCleared = false;
    this.agentTextByPhase.clear();
    this.lastCommandOutput.clear();

    const completed = new Promise<void>((resolve, reject) => {
      this.activeResolve = resolve;
      this.activeReject = reject;
    });

    try {
      const response = await this.requestCurrentThread<{ goal: CodexThreadGoal }>(
        "thread/goal/set",
        (threadId) => buildThreadGoalSetRequest(threadId, params),
      );
      const responseGoal = normalizeThreadGoal(response.goal);
      if (!this.activeGoal || isActiveGoal(this.activeGoal)) {
        this.activeGoal = responseGoal;
      }
      if (!isActiveGoal(this.activeGoal)) {
        this.resolveActiveRun();
      } else {
        this.scheduleGoalIdleTimeout();
      }

      await completed;
      return this.activeGoalCleared ? null : this.activeGoal;
    } finally {
      this.clearActiveRunState();
    }
  }

  async abort(): Promise<void> {
    if (!this.currentThreadId || !this.activeRunKind) {
      return;
    }

    const threadId = this.currentThreadId;
    const turnId = this.activeTurnId;
    const client = await this.getClient();
    let interruptError: unknown;

    if (turnId) {
      try {
        await withTimeout(
          client.request("turn/interrupt", {
            threadId,
            turnId,
          }),
          ABORT_INTERRUPT_TIMEOUT_MS,
          "turn/interrupt did not settle within 3 seconds",
        );
      } catch (error) {
        interruptError = error;
        console.warn("App-server turn/interrupt failed; forcing local turn reset", error);
      }
    } else if (this.activeRunKind === "goal") {
      try {
        await withTimeout(
          client.request("thread/goal/set", {
            threadId,
            status: "paused",
          }),
          ABORT_INTERRUPT_TIMEOUT_MS,
          "thread/goal/set pause did not settle within 3 seconds",
        );
      } catch (error) {
        interruptError = error;
        console.warn("App-server goal pause failed; forcing local goal reset", error);
      }
    }

    await delay(ABORT_SETTLE_GRACE_MS);
    if (turnId && this.activeTurnId !== turnId) {
      return;
    }
    if (!turnId && this.activeRunKind !== "goal") {
      return;
    }

    const message = interruptError
      ? `App-server turn aborted locally after interrupt failed: ${formatErrorMessage(interruptError)}`
      : "App-server turn aborted";
    this.rejectActiveRun(new Error(message));

    if (this.client === client) {
      await client.close().catch((error) => {
        console.warn("Failed to close app-server after abort", error);
      });
      this.client = null;
      this.appServerAttachedThreadId = null;
    }
  }

  async pauseActiveGoal(): Promise<CodexThreadGoal | null> {
    if (this.activeRunKind !== "goal" || !this.currentThreadId) {
      return this.activeGoalCleared ? null : this.activeGoal;
    }

    const threadId = this.currentThreadId;
    const turnId = this.activeTurnId;
    const client = await this.getClient();
    const callbacks = this.activeCallbacks;
    const itemId = "goal-pause";
    let pausedGoal = this.activeGoalCleared ? null : this.activeGoal;
    let pauseError: unknown;

    callbacks?.onToolStart("goal_pause", itemId);
    callbacks?.onToolUpdate(itemId, "Pausing native goal so Telegram can switch context.");

    if (turnId) {
      try {
        await withTimeout(
          client.request("turn/interrupt", {
            threadId,
            turnId,
          }),
          ABORT_INTERRUPT_TIMEOUT_MS,
          "turn/interrupt did not settle within 3 seconds",
        );
      } catch (error) {
        pauseError = error;
        console.warn("App-server turn/interrupt failed while pausing goal", error);
      }
    }

    try {
      const response = await withTimeout(
        client.request<{ goal: CodexThreadGoal }>("thread/goal/set", {
          threadId,
          status: "paused",
        }),
        ABORT_INTERRUPT_TIMEOUT_MS,
        "thread/goal/set pause did not settle within 3 seconds",
      );
      this.activeGoal = normalizeThreadGoal(response.goal);
      pausedGoal = this.activeGoal;
    } catch (error) {
      pauseError = pauseError ?? error;
      console.warn("App-server goal pause failed", error);
    }

    await delay(ABORT_SETTLE_GRACE_MS);

    callbacks?.onToolEnd(itemId, Boolean(pauseError));
    if (this.activeGoalCleared) {
      pausedGoal = null;
    } else if (this.activeGoal) {
      pausedGoal = this.activeGoal;
    }
    if (this.activeRunKind === "goal") {
      this.resolveActiveRun();
      await Promise.resolve();
    }

    if (turnId && this.client === client) {
      await client.close().catch((error) => {
        console.warn("Failed to close app-server after pausing active goal turn", error);
      });
      this.client = null;
      this.appServerAttachedThreadId = null;
    }

    return pausedGoal;
  }

  async steer(input: CodexPromptInput): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      throw new Error("No active app-server turn to steer");
    }

    const expectedTurnId = this.activeTurnId;
    await this.requestCurrentThread("turn/steer", (threadId) => ({
      threadId,
      expectedTurnId,
      input: this.buildAppServerInput(input),
    }));
  }

  async forkThread(turnCount = 0): Promise<CodexSessionInfo> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to fork");
    }
    this.ensureIdle("fork thread");

    if (!Number.isInteger(turnCount) || turnCount < 0) {
      throw new Error("Fork turn count must be a whole number of at least 0");
    }

    let lastTurnId: string | undefined;
    if (turnCount > 0) {
      const history = await this.requestCurrentThread<{ thread?: AppServerThread }>(
        "thread/read",
        (threadId) => ({
          threadId,
          includeTurns: true,
        }),
      );
      const turns = history.thread?.turns ?? [];
      if (turnCount >= turns.length) {
        throw new Error(
          `Cannot omit ${turnCount} turns from a thread with ${turns.length} persisted turn${turns.length === 1 ? "" : "s"}`,
        );
      }
      lastTurnId = turns[turns.length - turnCount - 1]?.id;
      if (!lastTurnId) {
        throw new Error("Codex did not return an id for the last retained turn");
      }
    }

    const response = await this.requestCurrentThread<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/fork",
      (threadId) => ({
        threadId,
        ...(lastTurnId ? { lastTurnId } : {}),
        cwd: this.currentWorkspace,
        model: this.currentModel ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
      }),
    );

    // Forking leaves both conversations loaded in the child. Release its writers
    // before another runtime can resume the parent, then attach only the fork.
    this.closeClient();
    await this.clientClosePromise;
    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = response.thread.id;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? this.currentWorkspace;
    if (response.model) {
      this.applyModel(response.model);
    }
    return this.getInfo();
  }

  async getTurnCount(): Promise<number> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to inspect");
    }
    this.ensureIdle("inspect thread history");

    const response = await this.requestCurrentThread<{ thread?: AppServerThread }>(
      "thread/read",
      (threadId) => ({
        threadId,
        includeTurns: true,
      }),
    );
    return Array.isArray(response.thread?.turns) ? response.thread.turns.length : 0;
  }

  async compactThread(): Promise<void> {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread to compact");
    }
    this.ensureIdle("compact thread");

    await this.requestCurrentThread("thread/compact/start", (threadId) => ({ threadId }));
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

    await this.requestCurrentThread("thread/name/set", (threadId) => ({
      threadId,
      name: trimmed,
    }));
  }

  async rollbackThread(turnCount: number): Promise<CodexSessionInfo> {
    if (!Number.isInteger(turnCount) || turnCount < 1) {
      throw new Error("Rollback turn count must be a whole number of at least 1");
    }

    // Codex 0.156 removed the deprecated thread/rollback RPC. Forking through
    // the last retained turn provides the same model context without mutating
    // the original thread, so users can still recover it from /sessions.
    return await this.forkThread(turnCount);
  }

  prepareNewThread(workspace?: string, model?: string): CodexSessionInfo {
    this.ensureIdle("prepare a new thread");
    this.closeClient();
    this.currentThreadId = null;
    this.appServerAttachedThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.currentWorkspace = workspace ?? this.currentWorkspace;
    if (model) {
      this.applyModel(model);
    }
    this.resetSessionTokens();
    return this.getInfo();
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");
    this.closeClient();

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    // Settle the vendor before the client is spawned: the app-server child reads
    // its provider config and API key once, at startup.
    this.applyModel(effectiveModel);
    const client = await this.getClient();
    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/start",
      {
        cwd: effectiveWorkspace,
        model: effectiveModel ?? null,
        approvalPolicy: this.currentLaunchProfile.approvalPolicy,
        sandbox: this.currentLaunchProfile.sandboxMode,
      },
      THREAD_LIFECYCLE_TIMEOUT_MS,
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? effectiveWorkspace;
    this.currentThreadId = response.thread.id;
    this.appServerAttachedThreadId = response.thread.id;
    if (model || response.model) {
      this.applyModel(response.model ?? model);
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");
    if (this.currentThreadId !== threadId) {
      this.closeClient();
    }

    const client = await this.getClient();
    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/resume",
      this.buildThreadResumeRequest(threadId),
      THREAD_LIFECYCLE_TIMEOUT_MS,
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = response.thread.id;
    this.appServerAttachedThreadId = response.thread.id;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? this.currentWorkspace;
    if (response.model) {
      this.applyModel(response.model);
    }
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = this.resolveThread(threadId);
    const resolvedThreadId = record?.id ?? threadId;
    const previousWorkspace = this.currentWorkspace;
    const previousModel = this.currentModel;
    try {
      if (record?.cwd) {
        this.currentWorkspace = record.cwd;
      }
      if (record?.model) {
        // Before the resume, so the client spawns against the thread's own vendor.
        this.applyModel(record.model);
      }
      return await this.resumeThread(resolvedThreadId);
    } catch (error) {
      this.currentWorkspace = previousWorkspace;
      this.applyModel(previousModel);
      throw error;
    }
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
    const previousVendorId = this.currentVendor?.vendor.id ?? null;
    const sourceThreadId = this.currentThreadId;
    this.applyModel(slug);
    const nextVendorId = this.currentVendor?.vendor.id ?? null;
    if (sourceThreadId && previousVendorId !== nextVendorId) {
      // Responses item IDs and encrypted reasoning state belong to the provider
      // that created them. Replaying a Qwen/other-vendor rollout directly to
      // OpenAI produces hard 400s such as a reasoning item with a msg_ ID where
      // OpenAI requires rs_. Keep the source rollout intact and carry only the
      // portable visible conversation into a clean target-provider thread.
      this.pendingProviderHandoff = { sourceThreadId };
      this.currentThreadId = null;
      this.appServerAttachedThreadId = null;
      this.activeThreadLaunchProfile = null;
      this.resetSessionTokens();
    }
    return slug;
  }

  /**
   * Point the session at a model, and at the vendor endpoint that serves it.
   * Dropping the client is what actually moves the endpoint: the app-server child
   * reads its provider config and env once, when it is spawned. The thread id
   * survives, so the next request respawns and re-attaches via thread/resume.
   */
  private applyModel(slug: string | undefined): void {
    const previousVendorId = this.currentVendor?.vendor.id ?? null;
    this.currentModel = slug;
    this.currentVendor = slug ? resolveVendorModel(slug) : null;
    if ((this.currentVendor?.vendor.id ?? null) !== previousVendorId) {
      this.closeClient();
    }
  }

  private closeClient(client: AppServerClientLike | null = this.client): void {
    const closing = client?.close();
    if (this.client === client) {
      this.client = null;
    }
    this.appServerAttachedThreadId = null;
    if (closing) {
      // prepareNewThread and model changes are synchronous. The next attachment
      // must still wait until the old process has released its exclusive writers.
      this.clientClosePromise = Promise.all([this.clientClosePromise, closing]).then(() => undefined);
      void this.clientClosePromise.catch(() => undefined);
    }
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

  setReasoningEffort(effort: CodexReasoningEffort): void {
    this.ensureIdle("change reasoning effort");
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change launch profile");
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    return this.currentLaunchProfile;
  }

  /**
   * Close the app-server child so the next request respawns it with fresh CLI
   * config overrides (the /mcp toggle). The thread id survives; the next turn
   * re-attaches via thread/resume.
   */
  resetBackendClient(): void {
    this.ensureIdle("apply the MCP toggle");
    this.closeClient();
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.clearActiveRunState();
    this.closeClient();
    return info;
  }

  dispose(): void {
    this.closeClient();
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.clearActiveRunState();
  }

  private async getClient(): Promise<AppServerClientLike> {
    await this.clientClosePromise;
    if (this.client) {
      return this.client;
    }

    this.appServerAttachedThreadId = null;
    const vendor = this.currentVendor;
    const client = this.createClient({
      codexPath: this.config.codexAppServerPath,
      cwd: this.config.workspace,
      env: {
        ...buildAppServerEnv(this.config.codexApiKey),
        ...(vendor ? buildVendorCodexEnv(vendor, { workspace: this.config.workspace }) : {}),
      },
      configOverrides: vendor ? buildVendorCodexConfig(vendor) : {},
    });
    client.onNotification((notification) => this.handleNotification(notification));
    client.onRequest((request) => this.handleServerRequest(request));
    client.onExit?.((error) => this.handleClientExit(client, error));
    try {
      await client.start();
      await client.initialize(DEFAULT_APP_SERVER_NOTIFICATION_OPTOUTS);
      client.notifyInitialized();
      this.client = client;
      return client;
    } catch (error) {
      // A failed staged switch must not leave an unregistered child behind.
      this.closeClient(client);
      throw error;
    }
  }

  private async requestCurrentThread<T = unknown>(
    method: string,
    params: (threadId: string) => JsonValue | undefined,
  ): Promise<T> {
    const client = await this.getClient();
    await this.ensureCurrentThreadAttached(client);

    try {
      return await client.request<T>(method, params(this.requireCurrentThreadId()));
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }

      this.appServerAttachedThreadId = null;
      await this.ensureCurrentThreadAttached(client);
      return await client.request<T>(method, params(this.requireCurrentThreadId()));
    }
  }

  private async ensureCurrentThreadAttached(client: AppServerClientLike): Promise<void> {
    const threadId = this.requireCurrentThreadId();
    if (this.appServerAttachedThreadId === threadId) {
      return;
    }

    const response = await client.request<{ thread: AppServerThread; model?: string; cwd?: string }>(
      "thread/resume",
      this.buildThreadResumeRequest(threadId),
      THREAD_LIFECYCLE_TIMEOUT_MS,
    );

    this.resetSessionTokens();
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = response.thread.id;
    this.appServerAttachedThreadId = response.thread.id;
    this.currentWorkspace = response.cwd ?? response.thread.cwd ?? this.currentWorkspace;
    if (response.model) {
      this.currentModel = response.model;
    }
  }

  private requireCurrentThreadId(): string {
    if (!this.currentThreadId) {
      throw new Error("No active app-server thread");
    }
    return this.currentThreadId;
  }

  private buildThreadResumeRequest(threadId: string): JsonValue {
    return {
      threadId,
      cwd: this.currentWorkspace,
      model: this.currentModel ?? null,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      sandbox: this.currentLaunchProfile.sandboxMode,
    };
  }

  private handleClientExit(client: AppServerClientLike, error: Error): void {
    if (this.client === client) {
      this.client = null;
      this.appServerAttachedThreadId = null;
    }
    this.rejectActiveRun(error);
  }

  private handleNotification(notification: AppServerNotification): void {
    const callbacks = this.activeCallbacks;
    if (!callbacks) {
      return;
    }

    if (notification.method === "turn/started") {
      const params = notification.params as { threadId?: string; turn?: AppServerTurn } | undefined;
      if (params?.threadId !== this.currentThreadId || !params.turn?.id || !this.activeRunKind) {
        return;
      }
      if (!this.activeTurnId) {
        this.activeTurnId = params.turn.id;
        this.agentTextByPhase.clear();
        this.lastCommandOutput.clear();
        this.clearGoalIdleTimeout();
      }
      return;
    }

    if (notification.method === "thread/goal/updated") {
      this.handleGoalUpdatedNotification(notification);
      return;
    }

    if (notification.method === "thread/goal/cleared") {
      this.handleGoalClearedNotification(notification);
      return;
    }

    if (notification.method === "thread/compacted") {
      if (this.activeRunKind === "goal") {
        const itemId = `context-compaction:${Date.now()}`;
        callbacks.onToolStart("context_compaction", itemId);
        callbacks.onToolEnd(itemId, false);
      }
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
      } else if (item.type === "collabAgentToolCall") {
        callbacks.onToolStart(`mcp:codex_apps/${item.tool ?? "agent"}`, item.id);
        if (item.prompt) {
          callbacks.onToolUpdate(item.id, `Prompt: ${item.prompt}`);
        }
        if (item.receiverThreadIds?.length) {
          callbacks.onChildThreads?.({
            toolCallId: item.id,
            toolName: item.tool ?? "agent",
            threadIds: item.receiverThreadIds,
            prompt: item.prompt ?? undefined,
          });
        }
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
        callbacks.onTurnComplete?.({
          inputTokens: usage.input,
          cachedInputTokens: usage.cached,
          outputTokens: usage.output,
        });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const params = notification.params as { turn?: AppServerTurn } | undefined;
      if (params?.turn?.id !== this.activeTurnId) {
        return;
      }
      if (params.turn.status === "failed") {
        this.rejectActiveRun(new Error(formatTurnError(params.turn.error)));
      } else {
        callbacks.onAgentEnd();
        if (this.activeRunKind === "goal") {
          this.activeTurnId = null;
          this.agentTextByPhase.clear();
          this.lastCommandOutput.clear();
          if (this.activeGoalCleared || (this.activeGoal && !isActiveGoal(this.activeGoal))) {
            this.resolveActiveRun();
          } else {
            this.scheduleGoalIdleTimeout();
          }
        } else {
          this.resolveActiveRun();
        }
      }
    }
  }

  private handleGoalUpdatedNotification(notification: AppServerNotification): void {
    const params = notification.params as { threadId?: string; goal?: CodexThreadGoal } | undefined;
    if (params?.threadId !== this.currentThreadId || !params.goal) {
      return;
    }

    const goal = normalizeThreadGoal(params.goal);
    this.activeGoal = goal;
    if (this.activeRunKind !== "goal") {
      return;
    }

    if (isActiveGoal(goal)) {
      if (!this.activeTurnId) {
        this.scheduleGoalIdleTimeout();
      }
      return;
    }

    this.clearGoalIdleTimeout();
    if (!this.activeTurnId) {
      this.resolveActiveRun();
    }
  }

  private handleGoalClearedNotification(notification: AppServerNotification): void {
    const params = notification.params as { threadId?: string } | undefined;
    if (params?.threadId !== this.currentThreadId) {
      return;
    }

    this.activeGoal = null;
    this.activeGoalCleared = true;
    this.clearGoalIdleTimeout();
    if (this.activeRunKind === "goal" && !this.activeTurnId) {
      this.resolveActiveRun();
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
      const phase = normalizeAgentMessagePhase(item.phase);
      const phaseKey = phase ?? "";
      const nextText = item.text ?? "";
      const previousText = this.agentTextByPhase.get(phaseKey) ?? "";
      const delta = computeTextDelta(previousText, nextText);
      this.agentTextByPhase.set(phaseKey, nextText);
      if (delta) {
        callbacks.onTextDelta(delta, { phase });
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
    } else if (item.type === "dynamicToolCall") {
      const toolName = `dynamic:${[item.namespace, item.tool].filter(Boolean).join("/") || "tool"}`;
      callbacks.onToolStart(toolName, item.id);
      const content = formatDynamicToolContent(item);
      if (content) {
        callbacks.onToolUpdate(item.id, content);
      }
      callbacks.onToolEnd(item.id, item.status === "failed" || item.success === false);
    } else if (item.type === "collabAgentToolCall") {
      callbacks.onToolStart(`mcp:codex_apps/${item.tool ?? "agent"}`, item.id);
      if (item.receiverThreadIds?.length) {
        callbacks.onChildThreads?.({
          toolCallId: item.id,
          toolName: item.tool ?? "agent",
          threadIds: item.receiverThreadIds,
          prompt: item.prompt ?? undefined,
        });
      }
      const detail = [
        item.prompt ? `Prompt: ${item.prompt}` : "",
        item.receiverThreadIds?.length ? `Threads: ${item.receiverThreadIds.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      if (detail) {
        callbacks.onToolUpdate(item.id, detail);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
    } else if (item.type === "imageGeneration") {
      callbacks.onToolStart("image_generation", item.id);
      const detail = [item.result, item.savedPath ? `Saved: ${item.savedPath}` : ""].filter(Boolean).join("\n");
      if (detail) {
        callbacks.onToolUpdate(item.id, detail);
      }
      callbacks.onToolEnd(item.id, item.status === "failed");
    } else if (item.type === "imageView") {
      callbacks.onToolStart("image_view", item.id);
      if (item.path) {
        callbacks.onToolUpdate(item.id, item.path);
      }
      callbacks.onToolEnd(item.id, false);
    } else if (item.type === "contextCompaction") {
      callbacks.onToolStart("context_compaction", item.id);
      callbacks.onToolEnd(item.id, false);
    }
  }

  private isActiveTurn(notification: AppServerNotification): boolean {
    const params = notification.params as { turnId?: unknown } | undefined;
    return typeof params?.turnId === "string" && params.turnId === this.activeTurnId;
  }

  private resolveActiveRun(): void {
    const resolve = this.activeResolve;
    this.activeResolve = null;
    this.activeReject = null;
    resolve?.();
  }

  private rejectActiveRun(error: Error): void {
    const reject = this.activeReject;
    this.activeResolve = null;
    this.activeReject = null;
    reject?.(error);
  }

  private clearActiveRunState(): void {
    this.clearGoalIdleTimeout();
    this.activeRunKind = null;
    this.activeTurnId = null;
    this.activeCallbacks = null;
    this.activeResolve = null;
    this.activeReject = null;
    this.activeGoal = null;
    this.activeGoalCleared = false;
    this.agentTextByPhase.clear();
    this.lastCommandOutput.clear();
  }

  private scheduleGoalIdleTimeout(): void {
    if (this.activeRunKind !== "goal" || this.activeTurnId || !this.activeGoal || !isActiveGoal(this.activeGoal)) {
      return;
    }

    this.clearGoalIdleTimeout();
    this.goalIdleTimer = setTimeout(() => {
      this.goalIdleTimer = null;
      this.reportIdleGoalMonitor();
    }, GOAL_IDLE_PROGRESS_MS);
  }

  private clearGoalIdleTimeout(): void {
    if (!this.goalIdleTimer) {
      return;
    }
    clearTimeout(this.goalIdleTimer);
    this.goalIdleTimer = null;
  }

  private reportIdleGoalMonitor(): void {
    if (
      this.activeRunKind !== "goal" ||
      this.activeTurnId ||
      !this.currentThreadId ||
      !this.activeGoal ||
      !isActiveGoal(this.activeGoal)
    ) {
      return;
    }

    const callbacks = this.activeCallbacks;
    const itemId = `goal-idle-${Date.now()}`;
    callbacks?.onToolStart("goal_idle_watchdog", itemId);
    callbacks?.onToolUpdate(
      itemId,
      `Native goal is still active. Waiting for the next continuation turn while keeping Telegram attached. Use /goal pause to stop it, or /steer to add guidance when a turn is active.`,
    );
    callbacks?.onToolEnd(itemId, false);
    this.scheduleGoalIdleTimeout();
  }

  private buildAppServerInput(input: CodexPromptInput): JsonValue[] {
    const handoffText = this.pendingProviderHandoff
      ? this.buildProviderHandoffText(this.pendingProviderHandoff, input)
      : null;
    if (typeof input === "string") {
      return [{
        type: "text",
        text: [input, handoffText].filter(Boolean).join("\n\n"),
        text_elements: [],
      }];
    }

    const result: JsonValue[] = [];
    // User text first: Codex titles threads from the start of the first message,
    // so the staged-file/output instructions must not lead the prompt.
    const textParts = [input.text, handoffText, input.stagedFileInstructions].filter(
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

  private buildProviderHandoffText(handoff: ProviderHandoff, input: CodexPromptInput): string {
    const history = readThreadHistory(handoff.sourceThreadId, PROVIDER_HANDOFF_HISTORY_LIMIT);
    const currentText = promptInputText(input).trim();
    if (
      currentText &&
      history.at(-1)?.role === "user" &&
      normalizeHandoffText(history.at(-1)?.text ?? "") === normalizeHandoffText(currentText)
    ) {
      // The app-server persists the user item before an upstream 400. Do not
      // duplicate that failed message when retrying it on the clean thread.
      history.pop();
    }

    let remaining = PROVIDER_HANDOFF_TOTAL_CHAR_LIMIT;
    const copied: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const message of [...history].reverse()) {
      if (remaining <= 0) {
        break;
      }
      const text = message.text.slice(0, Math.min(PROVIDER_HANDOFF_MESSAGE_CHAR_LIMIT, remaining));
      if (!text) {
        continue;
      }
      copied.push({ role: message.role, text });
      remaining -= text.length;
    }
    copied.reverse();

    return [
      "<telecode_cross_provider_handoff>",
      "TeleCode created a clean Codex thread because raw Responses history contains provider-specific item IDs and reasoning state that cannot safely be replayed across model vendors.",
      `The original source thread is preserved and resumable: ${handoff.sourceThreadId}`,
      "The user's current message appears above this block and remains authoritative. The JSON lines below are recent visible conversation copied from the source rollout as prior context. Inspect the workspace and source thread when more detail is needed.",
      ...copied.map((message) => JSON.stringify(message)),
      "</telecode_cross_provider_handoff>",
    ].join("\n");
  }

  private ensureIdle(action: string): void {
    if (this.activeRunKind || this.activeTurnId) {
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
    if (/^(?:previous|prev)$/i.test(value)) {
      return listThreads(10).find((thread) => thread.id !== this.currentThreadId) ?? null;
    }
    return getThread(value) ?? getThreadByPrefix(value);
  }
}

function getLaunchProfile(config: TeleCodeConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function buildThreadGoalSetRequest(threadId: string, params: CodexThreadGoalSetParams): JsonValue {
  const request: { [key: string]: JsonValue } = { threadId };
  if (params.objective !== undefined) {
    request.objective = params.objective;
  }
  if (params.status !== undefined) {
    request.status = params.status;
  }
  if ("tokenBudget" in params) {
    request.tokenBudget = params.tokenBudget ?? null;
  }
  return request;
}

function normalizeThreadGoal(goal: CodexThreadGoal): CodexThreadGoal {
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
  };
}

function isActiveGoal(goal: CodexThreadGoal): boolean {
  return goal.status === "active";
}

function isThreadNotFoundError(error: unknown): boolean {
  return /\bthread not found\b/i.test(formatErrorMessage(error));
}

function isNonPortableResponseItemIdError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /invalid_id_prefix/i.test(message) && /Expected an ID that begins with ['"][a-z]+/i.test(message);
}

function promptInputText(input: CodexPromptInput): string {
  if (typeof input === "string") {
    return input;
  }
  return [input.text, input.stagedFileInstructions]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");
}

function normalizeHandoffText(text: string): string {
  return text.split(String.fromCharCode(13)).join("").trim();
}

function getNotificationItem(notification: AppServerNotification): AppServerThreadItem | null {
  const params = notification.params as { item?: AppServerThreadItem } | undefined;
  return params?.item ?? null;
}

function normalizeAgentMessagePhase(phase: unknown): string | null {
  return typeof phase === "string" && phase.trim() ? phase : null;
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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function formatDynamicToolContent(item: AppServerThreadItem): string {
  const parts: string[] = [];
  for (const contentItem of item.contentItems ?? []) {
    if (contentItem.type === "inputText" && contentItem.text) {
      parts.push(contentItem.text);
    } else if (contentItem.type === "inputImage" && contentItem.imageUrl) {
      parts.push(contentItem.imageUrl);
    }
  }
  return parts.join("\n");
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
