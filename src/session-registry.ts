import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createCodexSession, type CodexSessionRuntime } from "./codex-backend.js";
import { findLaunchProfile } from "./codex-launch.js";
import type { CodexBackend, ProgressDelivery, TeleCodexConfig } from "./config.js";
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

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionRuntime>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
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
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
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

  setActiveProvider(contextKey: TelegramContextKey, provider: AgentProviderKind): void {
    const previous = this.metadata.get(contextKey);
    this.metadata.set(contextKey, {
      contextKey,
      threadId: previous?.threadId ?? null,
      workspace: previous?.workspace ?? this.config.workspace,
      model: previous?.model ?? this.config.codexModel,
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
      model: previous?.model ?? this.config.codexModel,
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
      model: previous?.model ?? this.config.codexModel,
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
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
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
