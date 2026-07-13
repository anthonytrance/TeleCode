import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createCodexSession, type CodexSessionRuntime } from "./codex-backend.js";
import { isCodexMcpEnabled, setCodexMcpEnabled } from "./codex-mcp-toggle.js";
import { findLaunchProfile } from "./codex-launch.js";
import type { CodexBackend, ProgressDelivery, TeleCodeConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { parseJsonFileText } from "./json.js";
import type { AgentProviderKind } from "./providers/types.js";
import { normalizePersistedWorkspace } from "./workspace-normalization.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  backend?: CodexBackend;
  activeProvider?: AgentProviderKind;
  progressDelivery?: ProgressDelivery;
  updatedAt: number;
}

interface TeleCodePreferences {
  selectedCodexModel?: string;
  codexMcpEnabled?: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionRuntime>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private readonly preferencesPath: string;
  private selectedCodexModel?: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodeConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.preferencesPath = path.join(config.workspace, ".telecodex", "preferences.json");
    this.loadPersistedMetadata();
    this.loadPreferences();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean; skipThreadResume?: boolean },
  ): Promise<CodexSessionRuntime> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const effectiveConfig = {
      ...this.config,
      codexBackend: meta?.backend ?? this.config.codexBackend,
    };
    session = await createCodexSession(effectiveConfig, {
      workspace: meta?.workspace,
      model: meta?.model ?? this.selectedCodexModel,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.skipThreadResume || (options?.deferThreadStart && !meta?.threadId),
      resumeThreadId: options?.skipThreadResume ? undefined : meta?.threadId ?? undefined,
    });

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionRuntime | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  getBackend(contextKey: TelegramContextKey): CodexBackend {
    return this.metadata.get(contextKey)?.backend ?? this.config.codexBackend;
  }

  getActiveProvider(contextKey: TelegramContextKey): AgentProviderKind {
    return this.metadata.get(contextKey)?.activeProvider ?? "codex";
  }

  getDefaultModel(): string | undefined {
    return this.selectedCodexModel ?? this.config.codexModel;
  }

  setDefaultModel(model: string): void {
    this.selectedCodexModel = model;
    this.persistPreferences();
  }

  getCodexMcpEnabled(): boolean {
    return isCodexMcpEnabled();
  }

  /**
   * Flip the /mcp toggle, persist it, and reset every idle Codex backend client
   * so the change applies from each session's next turn. Busy sessions are left
   * alone; they pick the toggle up on their next backend spawn.
   */
  setCodexMcpEnabled(enabled: boolean): { resetSessions: number; busySessions: number } {
    setCodexMcpEnabled(enabled);
    this.persistPreferences();

    let resetSessions = 0;
    let busySessions = 0;
    for (const session of this.sessions.values()) {
      if (!session.resetBackendClient) {
        continue;
      }
      if (session.isProcessing()) {
        busySessions += 1;
        continue;
      }
      try {
        session.resetBackendClient();
        resetSessions += 1;
      } catch {
        busySessions += 1;
      }
    }
    return { resetSessions, busySessions };
  }

  setActiveProvider(contextKey: TelegramContextKey, provider: AgentProviderKind): void {
    const previous = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: previous?.threadId ?? null,
      workspace: previous?.workspace ?? this.config.workspace,
      model: previous?.model ?? this.getDefaultModel(),
      reasoningEffort: previous?.reasoningEffort,
      launchProfileId: previous?.launchProfileId ?? this.config.defaultLaunchProfileId,
      backend: previous?.backend ?? this.config.codexBackend,
      activeProvider: provider,
      progressDelivery: previous?.progressDelivery,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  getProgressDelivery(contextKey: TelegramContextKey): ProgressDelivery {
    return this.metadata.get(contextKey)?.progressDelivery ?? this.config.progressDelivery;
  }

  setProgressDelivery(contextKey: TelegramContextKey, progressDelivery: ProgressDelivery): void {
    const previous = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: previous?.threadId ?? null,
      workspace: previous?.workspace ?? this.config.workspace,
      model: previous?.model ?? this.getDefaultModel(),
      reasoningEffort: previous?.reasoningEffort,
      launchProfileId: previous?.launchProfileId ?? this.config.defaultLaunchProfileId,
      backend: previous?.backend ?? this.config.codexBackend,
      activeProvider: previous?.activeProvider,
      progressDelivery,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  setBackend(contextKey: TelegramContextKey, backend: CodexBackend): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);

    const previous = this.metadata.get(contextKey);
    const next: ContextMetadata = {
      contextKey,
      threadId: previous?.threadId ?? null,
      workspace: previous?.workspace ?? this.config.workspace,
      model: previous?.model ?? this.getDefaultModel(),
      reasoningEffort: previous?.reasoningEffort,
      launchProfileId: previous?.launchProfileId ?? this.config.defaultLaunchProfileId,
      backend,
      activeProvider: previous?.activeProvider,
      updatedAt: Date.now(),
    };
    if (previous?.progressDelivery) {
      next.progressDelivery = previous.progressDelivery;
    }
    this.metadata.set(contextKey, next);
    this.persistMetadata();
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionRuntime): void {
    const info = session.getInfo();
    const previous = this.metadata.get(contextKey);
    const next: ContextMetadata = {
      contextKey,
      threadId: info.threadId,
      workspace: normalizePersistedWorkspace(info.workspace, this.config.workspace),
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      backend: previous?.backend ?? this.config.codexBackend,
      activeProvider: previous?.activeProvider,
      updatedAt: Date.now(),
    };
    if (previous?.progressDelivery) {
      next.progressDelivery = previous.progressDelivery;
    }
    this.metadata.set(contextKey, next);
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = parseJsonFileText<ContextMetadata[]>(raw);
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, {
            ...entry,
            workspace: normalizePersistedWorkspace(entry.workspace, this.config.workspace),
          });
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }

  private persistPreferences(): void {
    try {
      const dir = path.dirname(this.preferencesPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: TeleCodePreferences = {
        selectedCodexModel: this.selectedCodexModel,
        codexMcpEnabled: isCodexMcpEnabled(),
      };
      writeFileSync(this.preferencesPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist TeleCode preferences:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPreferences(): void {
    try {
      if (!existsSync(this.preferencesPath)) {
        return;
      }
      const raw = readFileSync(this.preferencesPath, "utf8");
      const preferences = parseJsonFileText<TeleCodePreferences>(raw);
      this.selectedCodexModel = preferences.selectedCodexModel;
      setCodexMcpEnabled(preferences.codexMcpEnabled === true);
    } catch {
      // Silently ignore load errors.
    }
  }
}

function resolveLaunchProfileId(
  config: TeleCodeConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
