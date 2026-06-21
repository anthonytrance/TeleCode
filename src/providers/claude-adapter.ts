import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { ClaudePermissionMode, TeleCodexConfig } from "../config.js";
import type {
  AgentProviderAdapter,
  AgentProviderCapabilities,
  AgentProviderEvent,
  AgentSendPromptOptions,
  AgentSessionDescriptor,
  CreateAgentSessionOptions,
} from "./types.js";
import { ensureClaudeConfigDir } from "./claude-config-dir.js";
import {
  CLAUDE_READY_MARKERS,
  CLAUDE_TRUST_MARKERS,
  ClaudePty,
} from "./claude-pty.js";
import {
  findTranscript,
  locateActiveTranscript,
  sessionIdFromTranscriptPath,
  snapshotTranscripts,
  TranscriptTailer,
  type ClaudeUsageSnapshot,
} from "./claude-transcript.js";

const CLAUDE_CAPABILITIES: AgentProviderCapabilities = {
  streamingText: true,
  streamingInput: false,
  abort: true,
  fork: false,
  rename: false,
  compact: true,
  usage: true,
  context: true,
  slashCommands: true,
  permissions: false,
  userQuestions: false,
  artifacts: false,
};

interface RuntimeSession {
  descriptor: AgentSessionDescriptor;
  providerSessionId: string;
  workspace: string;
  model: string;
  permissionMode: ClaudePermissionMode;
  pty?: ClaudePty;
  busy: boolean;
  lastUsage?: ClaudeUsageSnapshot;
  /** Path to the transcript Claude actually writes; discovered on the first turn. */
  transcriptPath?: string;
}

export class ClaudeProviderAdapter implements AgentProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(private readonly config: TeleCodexConfig) {}

  async createSession(options: CreateAgentSessionOptions): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const providerSessionId = randomUUID();
    const descriptor = this.buildDescriptor({
      id: `claude-${providerSessionId.slice(0, 12)}`,
      providerSessionId,
      workspace: options.workspace || this.config.claudeWorkspace,
      displayName: options.displayName,
      model: asString(options.metadata?.model) || this.config.claudeDefaultModel,
      permissionMode: asPermissionMode(options.metadata?.permissionMode) || this.config.claudePermissionMode,
      status: "idle",
    });
    const runtime = this.runtimeFromDescriptor(descriptor);
    this.sessions.set(descriptor.id, runtime);
    await this.ensurePty(runtime, "new");
    return { ...descriptor };
  }

  async resumeSession(session: AgentSessionDescriptor): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const runtime = this.runtimeFromDescriptor(session);
    this.sessions.set(session.id, runtime);
    await this.ensurePty(runtime, "resume");
    return { ...runtime.descriptor };
  }

  async getSessionInfo(sessionId: string): Promise<AgentSessionDescriptor> {
    return { ...this.requireRuntime(sessionId).descriptor };
  }

  async *sendPrompt(options: AgentSendPromptOptions): AsyncIterable<AgentProviderEvent> {
    const runtime = this.requireRuntime(options.sessionId);
    if (runtime.busy) {
      throw new Error("Claude session is already running a turn");
    }
    const promptText = promptToText(options.input);
    if (!promptText.trim()) {
      throw new Error("Claude prompt is empty");
    }

    runtime.busy = true;
    runtime.descriptor.status = "running";
    runtime.descriptor.updatedAt = Date.now();
    yield { type: "session_status_changed", sessionId: runtime.descriptor.id, status: "running" };

    try {
      await this.ensurePty(runtime, "resume");
      const { transcriptPath, startOffset } = await this.locateTurnTranscript(
        runtime,
        () => runtime.pty!.sendPrompt(promptText),
      );

      const tailer = new TranscriptTailer(transcriptPath, { startOffset });
      for await (const event of tailer.eventsUntilTurnEnd({
        sessionId: runtime.descriptor.id,
        jobId: options.jobId,
        idleTimeoutMs: this.config.claudeTurnIdleTimeoutSeconds * 1000,
      })) {
        if (event.type === "usage_updated") {
          runtime.lastUsage = {
            inputTokens: event.inputTokens ?? 0,
            cachedInputTokens: event.cachedInputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            contextTokens: (event.inputTokens ?? 0) + (event.cachedInputTokens ?? 0),
          };
        }
        yield event;
      }
    } finally {
      runtime.busy = false;
      runtime.descriptor.status = "idle";
      runtime.descriptor.updatedAt = Date.now();
      yield { type: "session_status_changed", sessionId: runtime.descriptor.id, status: "idle" };
    }
  }

  async abort(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    runtime.pty?.pressEscape();
  }

  async compact(sessionId: string): Promise<void> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.busy) {
      throw new Error("Cannot compact while Claude is running");
    }
    runtime.busy = true;
    try {
      await this.ensurePty(runtime, "resume");
      const { transcriptPath, startOffset } = await this.locateTurnTranscript(
        runtime,
        () => runtime.pty!.sendCommand("/compact"),
      );
      const tailer = new TranscriptTailer(transcriptPath, { startOffset });
      const summary = await tailer.waitForCompact({
        sessionId,
        jobId: `compact-${Date.now()}`,
        timeoutMs: 120000,
      });
      if (!summary) {
        throw new Error("Claude compaction did not finish before timeout");
      }
    } finally {
      runtime.busy = false;
    }
  }

  async getUsage(sessionId: string): Promise<Record<string, unknown>> {
    const runtime = this.requireRuntime(sessionId);
    return runtime.lastUsage ? { ...runtime.lastUsage } : {};
  }

  async getContext(sessionId: string): Promise<Record<string, unknown>> {
    const runtime = this.requireRuntime(sessionId);
    const used = runtime.lastUsage?.contextTokens ?? 0;
    return {
      usedTokens: used,
      contextWindow: this.config.claudeContextWindow,
      percent: this.config.claudeContextWindow > 0 ? used / this.config.claudeContextWindow : 0,
    };
  }

  async dispose(sessionId?: string): Promise<void> {
    if (sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (runtime?.pty) {
        await runtime.pty.dispose(true);
      }
      this.sessions.delete(sessionId);
      return;
    }

    for (const runtime of this.sessions.values()) {
      await runtime.pty?.dispose(true);
    }
    this.sessions.clear();
  }

  private async ensurePty(runtime: RuntimeSession, mode: "new" | "resume"): Promise<void> {
    if (runtime.pty?.isAlive) {
      return;
    }
    if (!existsSync(this.config.claudeBin)) {
      throw new Error(`Claude binary not found: ${this.config.claudeBin}`);
    }

    const ptySession = new ClaudePty();
    const args = mode === "new"
      ? [
          "--session-id",
          runtime.providerSessionId,
          "-n",
          runtime.descriptor.displayName || "TeleCodex Claude",
          "--model",
          runtime.model,
          "--permission-mode",
          runtime.permissionMode,
        ]
      : [
          "--resume",
          runtime.providerSessionId,
          "--model",
          runtime.model,
          "--permission-mode",
          runtime.permissionMode,
        ];
    ensureClaudeConfigDir(this.config.claudeConfigDir);
    ptySession.spawn({
      bin: this.config.claudeBin,
      args,
      cwd: runtime.workspace,
      configDir: this.config.claudeConfigDir,
    });

    const firstMarker = await ptySession.waitForMarker([
      ...CLAUDE_TRUST_MARKERS,
      ...CLAUDE_READY_MARKERS,
    ], 30000);
    if (!firstMarker) {
      await ptySession.dispose(false);
      throw new Error("Claude did not reach a ready prompt");
    }
    if (firstMarker === CLAUDE_TRUST_MARKERS[0]!.source) {
      ptySession.pressEnter();
      const ready = await ptySession.waitForMarker(CLAUDE_READY_MARKERS, 30000);
      if (!ready) {
        await ptySession.dispose(false);
        throw new Error("Claude trust dialog was accepted, but the prompt did not become ready");
      }
    }

    ptySession.on("exit", () => {
      runtime.pty = undefined;
      runtime.descriptor.status = runtime.busy ? "failed" : "idle";
      runtime.descriptor.updatedAt = Date.now();
    });
    runtime.pty = ptySession;
  }

  /**
   * Send a turn and locate the transcript Claude writes for it. Interactive Claude
   * ignores the --session-id we pass, so we cannot predict the filename. We snapshot the
   * transcripts on disk before sending, then detect the file that appears or grows, and
   * reconcile the runtime's session id to the real one so later --resume and reads work.
   */
  private async locateTurnTranscript(
    runtime: RuntimeSession,
    send: () => Promise<void>,
  ): Promise<{ transcriptPath: string; startOffset: number }> {
    const configDir = this.config.claudeConfigDir;
    let knownPath = runtime.transcriptPath;
    if (!knownPath) {
      knownPath = (await findTranscript(runtime.providerSessionId, 1000, configDir)) ?? undefined;
    }
    const knownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;

    const before = await snapshotTranscripts(configDir);
    await send();

    const active = await locateActiveTranscript({
      before,
      knownPath,
      knownOffset,
      timeoutMs: 30000,
      configDir,
    });
    if (!active) {
      throw new Error("Claude transcript was not created");
    }

    runtime.transcriptPath = active.path;
    const realSessionId = sessionIdFromTranscriptPath(active.path);
    if (realSessionId && realSessionId !== runtime.providerSessionId) {
      runtime.providerSessionId = realSessionId;
      runtime.descriptor.providerSessionId = realSessionId;
      runtime.descriptor.updatedAt = Date.now();
    }
    return { transcriptPath: active.path, startOffset: active.startOffset };
  }

  private buildDescriptor(options: {
    id: string;
    providerSessionId: string;
    workspace: string;
    displayName?: string;
    model: string;
    permissionMode: ClaudePermissionMode;
    status: AgentSessionDescriptor["status"];
  }): AgentSessionDescriptor {
    const now = Date.now();
    return {
      id: options.id,
      provider: "claude",
      workspace: options.workspace,
      displayName: options.displayName,
      providerSessionId: options.providerSessionId,
      status: options.status,
      capabilities: CLAUDE_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      metadata: {
        model: options.model,
        permissionMode: options.permissionMode,
      },
    };
  }

  private runtimeFromDescriptor(descriptor: AgentSessionDescriptor): RuntimeSession {
    const providerSessionId = descriptor.providerSessionId;
    if (!providerSessionId) {
      throw new Error("Claude descriptor is missing providerSessionId");
    }
    return {
      descriptor: { ...descriptor, capabilities: CLAUDE_CAPABILITIES },
      providerSessionId,
      workspace: descriptor.workspace || this.config.claudeWorkspace,
      model: asString(descriptor.metadata?.model) || this.config.claudeDefaultModel,
      permissionMode: asPermissionMode(descriptor.metadata?.permissionMode) || this.config.claudePermissionMode,
      busy: false,
    };
  }

  private requireRuntime(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Unknown Claude session: ${sessionId}`);
    }
    return runtime;
  }

  private validateEnabled(): void {
    if (!this.config.enableClaudeProvider) {
      throw new Error("Claude provider is disabled. Set ENABLE_CLAUDE_PROVIDER=true to enable it.");
    }
  }
}

function promptToText(input: AgentSendPromptOptions["input"]): string {
  const parts: string[] = [];
  if (input.text) {
    parts.push(input.text);
  }
  for (const imagePath of input.imagePaths ?? []) {
    parts.push(`Image file: ${imagePath}`);
  }
  for (const filePath of input.filePaths ?? []) {
    parts.push(`File: ${filePath}`);
  }
  return parts.join("\n\n");
}

function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asPermissionMode(value: unknown): ClaudePermissionMode | undefined {
  return value === "default" || value === "acceptEdits" || value === "plan" || value === "bypassPermissions"
    ? value
    : undefined;
}
