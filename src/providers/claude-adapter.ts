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
  CLAUDE_FULLSCREEN_PROMPT_MARKERS,
  CLAUDE_READY_MARKERS,
  CLAUDE_TRUST_MARKERS,
  ClaudePty,
} from "./claude-pty.js";
import {
  ClaudeProcessRegistry,
  claudeProcessRegistryPath,
} from "./claude-process-registry.js";
import {
  findTranscript,
  locateActiveTranscript,
  locateActiveTranscriptTurnByPrompt,
  locateTranscriptTurnByPrompt,
  sessionIdFromTranscriptPath,
  snapshotTranscriptSizes,
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
  ptyPid?: number;
}

type LocatedTurnOutput =
  | { transcriptPath: string; startOffset: number }
  | { fallbackText: string };

export class ClaudeProviderAdapter implements AgentProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly processRegistry: ClaudeProcessRegistry;

  constructor(private readonly config: TeleCodexConfig) {
    this.processRegistry = new ClaudeProcessRegistry(claudeProcessRegistryPath(config.workspace));
  }

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
      const modelCommand = parseClaudeModelCommand(promptText);
      if (modelCommand) {
        await this.applyModelCommand(runtime, promptText, modelCommand);
        const text = `Claude model command applied: ${modelCommand}`;
        yield {
          type: "assistant_text_delta",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        };
        yield {
          type: "assistant_message_complete",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        };
        return;
      }

      const output = await this.locateTurnTranscript(
        runtime,
        promptText,
        () => runtime.pty!.sendPrompt(promptText),
        { requirePromptEcho: true },
      );

      if ("fallbackText" in output) {
        yield {
          type: "assistant_text_delta",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text: output.fallbackText,
        };
        yield {
          type: "assistant_message_complete",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text: output.fallbackText,
        };
        return;
      }

      const tailer = new TranscriptTailer(output.transcriptPath, { startOffset: output.startOffset });
      let partialAssistantText = "";
      for await (const event of tailer.eventsUntilTurnEnd({
        sessionId: runtime.descriptor.id,
        jobId: options.jobId,
        idleTimeoutMs: this.config.claudeTurnIdleTimeoutSeconds * 1000,
      })) {
        if (event.type === "error") {
          await this.stopRuntimePty(runtime);
          if (partialAssistantText.trim()) {
            yield {
              type: "assistant_message_complete",
              sessionId: runtime.descriptor.id,
              jobId: options.jobId,
              text: `${partialAssistantText.trim()}\n\nClaude stopped before finishing the turn: ${event.message}`,
            };
            return;
          }
          throw new Error(event.message);
        }
        if (event.type === "assistant_text_delta") {
          partialAssistantText += event.text;
        }
        if (event.type === "usage_updated") {
          runtime.lastUsage = {
            inputTokens: event.inputTokens ?? 0,
            cachedInputTokens: event.cachedInputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
            contextTokens: (event.inputTokens ?? 0) + (event.cachedInputTokens ?? 0),
          };
        } else if (event.type === "session_title_changed") {
          runtime.descriptor.displayName = event.title;
          runtime.descriptor.updatedAt = Date.now();
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
      const output = await this.locateTurnTranscript(
        runtime,
        "/compact",
        () => runtime.pty!.sendCommand("/compact"),
        { requirePromptEcho: false },
      );
      if ("fallbackText" in output) {
        throw new Error("Claude compaction completed on screen, but no compact transcript boundary was written");
      }
      const tailer = new TranscriptTailer(output.transcriptPath, { startOffset: output.startOffset });
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
      this.removeRegisteredProcessSession(sessionId);
      this.sessions.delete(sessionId);
      return;
    }

    for (const runtime of this.sessions.values()) {
      await runtime.pty?.dispose(true);
      this.removeRegisteredProcessSession(runtime.descriptor.id);
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
          "--permission-mode",
          runtime.permissionMode,
        ]
      : [
          "--resume",
          runtime.providerSessionId,
          "--permission-mode",
          runtime.permissionMode,
        ];

    if (shouldPassClaudeModel(runtime.model)) {
      args.push("--model", runtime.model);
    }

    if (runtime.permissionMode === "bypassPermissions") {
      args.unshift("--dangerously-skip-permissions");
    }

    args.push("--settings", JSON.stringify(TELECODEX_CLAUDE_SETTINGS));
    args.push("--append-system-prompt", TELECODEX_CLAUDE_SYSTEM_PROMPT);

    const strictMcp = this.config.claudeStrictMcpConfig;
    if (strictMcp) {
      // Launch against the real ~/.claude but ignore config-file mcp servers, so the
      // user-scoped telegram plugin never starts a second getUpdates poller (which 409s
      // the live bridge). Interactive turns do not execute under an isolated config dir,
      // so this is the path that actually works end to end.
      args.push("--strict-mcp-config");
    } else {
      ensureClaudeConfigDir(this.config.claudeConfigDir);
    }
    ptySession.spawn({
      bin: this.config.claudeBin,
      args,
      cwd: runtime.workspace,
      configDir: strictMcp ? undefined : this.config.claudeConfigDir,
    });
    runtime.ptyPid = ptySession.pid;
    if (runtime.ptyPid) {
      this.registerProcess({
        pid: runtime.ptyPid,
        sessionId: runtime.descriptor.id,
        providerSessionId: runtime.providerSessionId,
        startedAt: Date.now(),
      });
    }

    const firstMarker = await ptySession.waitForMarker([
      ...CLAUDE_TRUST_MARKERS,
      ...CLAUDE_FULLSCREEN_PROMPT_MARKERS,
      ...CLAUDE_READY_MARKERS,
    ], 30000);
    if (!firstMarker) {
      await ptySession.dispose(false);
      this.removeRegisteredProcessSession(runtime.descriptor.id);
      throw new Error("Claude did not reach a ready prompt");
    }
    if (firstMarker === CLAUDE_TRUST_MARKERS[0]!.source) {
      ptySession.pressEnter();
      const ready = await ptySession.waitForMarker(CLAUDE_READY_MARKERS, 30000);
      if (!ready) {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error("Claude trust dialog was accepted, but the prompt did not become ready");
      }
    }
    if (firstMarker === CLAUDE_FULLSCREEN_PROMPT_MARKERS[0]!.source) {
      ptySession.typeText("2");
      ptySession.pressEnter();
      const ready = await ptySession.waitForMarker(CLAUDE_READY_MARKERS, 30000);
      if (!ready) {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error("Claude fullscreen prompt was dismissed, but the prompt did not become ready");
      }
    }

    ptySession.on("exit", () => {
      if (runtime.ptyPid) {
        this.removeRegisteredProcessPid(runtime.ptyPid);
      }
      runtime.ptyPid = undefined;
      runtime.pty = undefined;
      runtime.descriptor.status = runtime.busy ? "failed" : "idle";
      runtime.descriptor.updatedAt = Date.now();
    });
    runtime.pty = ptySession;
  }

  private async applyModelCommand(runtime: RuntimeSession, commandText: string, model: string): Promise<void> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      throw new Error("Claude PTY is not running");
    }

    ptySession.clearBuffer();
    await ptySession.sendCommand(commandText);
    const confirmation = await ptySession.waitForMarker(
      [/switchmodel/, /yes,switchto/],
      5000,
    );
    if (confirmation) {
      ptySession.typeText("1");
      ptySession.pressEnter();
      await sleep(1000);
    }

    runtime.model = model;
    runtime.descriptor.metadata = {
      ...runtime.descriptor.metadata,
      model,
    };
    runtime.descriptor.updatedAt = Date.now();
  }

  private registerProcess(record: {
    pid: number;
    sessionId: string;
    providerSessionId: string;
    startedAt: number;
  }): void {
    try {
      this.processRegistry.upsert(record);
    } catch (error) {
      console.warn("Failed to record TeleCodex Claude process", error);
    }
  }

  private removeRegisteredProcessPid(pid: number): void {
    try {
      this.processRegistry.removePid(pid);
    } catch (error) {
      console.warn("Failed to remove TeleCodex Claude process record", error);
    }
  }

  private removeRegisteredProcessSession(sessionId: string): void {
    try {
      this.processRegistry.removeSession(sessionId);
    } catch (error) {
      console.warn("Failed to remove TeleCodex Claude session process record", error);
    }
  }

  private async stopRuntimePty(runtime: RuntimeSession): Promise<void> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      return;
    }
    const pid = runtime.ptyPid;
    runtime.pty = undefined;
    runtime.ptyPid = undefined;
    await ptySession.dispose(true);
    if (pid) {
      this.removeRegisteredProcessPid(pid);
    } else {
      this.removeRegisteredProcessSession(runtime.descriptor.id);
    }
  }

  /**
   * Send a turn and locate the transcript Claude writes for it. Interactive Claude
   * ignores the --session-id we pass, so we cannot predict the filename. We snapshot the
   * transcripts on disk before sending, then detect the file that appears or grows, and
   * reconcile the runtime's session id to the real one so later --resume and reads work.
   */
  /**
   * Config dir to scan for transcripts. In strict-mcp mode the child runs against the
   * real ~/.claude (undefined => homedir/.claude); otherwise the isolated config dir.
   */
  private get transcriptConfigDir(): string | undefined {
    return this.config.claudeStrictMcpConfig ? undefined : this.config.claudeConfigDir;
  }

  private async locateTurnTranscript(
    runtime: RuntimeSession,
    promptText: string,
    send: () => Promise<void>,
    options: { requirePromptEcho?: boolean } = {},
  ): Promise<LocatedTurnOutput> {
    const configDir = this.transcriptConfigDir;
    let knownPath = runtime.transcriptPath;
    if (!knownPath) {
      knownPath = (await findTranscript(runtime.providerSessionId, 1000, configDir)) ?? undefined;
    }
    const knownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;

    const before = await snapshotTranscriptSizes(configDir);
    const screenBefore = runtime.pty?.strippedText() ?? "";
    await send();

    const requirePromptEcho = options.requirePromptEcho ?? true;
    const active = requirePromptEcho
      ? await locateActiveTranscriptTurnByPrompt({
          before,
          promptText,
          expectedSessionId: runtime.providerSessionId,
          knownPath,
          knownOffset,
          timeoutMs: 30000,
          configDir,
        })
      : await locateActiveTranscript({
          before,
          expectedSessionId: runtime.providerSessionId,
          knownPath,
          knownOffset,
          timeoutMs: 30000,
          configDir,
        });
    if (!active) {
      if (requirePromptEcho) {
        const recovered = await locateTranscriptTurnByPrompt({
          promptText,
          expectedSessionId: runtime.providerSessionId,
          knownPath,
          minOffset: knownOffset,
          configDir,
        });
        if (recovered) {
          return this.reconcileLocatedTranscript(runtime, recovered);
        }

        const tail = screenTail(runtime.pty);
        await this.stopRuntimePty(runtime);
        throw new Error(`Claude did not record the prompt in its transcript. Screen tail: ${tail}`);
      }

      const fallbackText = extractScreenFallbackText(screenBefore, runtime.pty?.strippedText() ?? "");
      if (fallbackText) {
        return { fallbackText };
      }
      const tail = screenTail(runtime.pty);
      await this.stopRuntimePty(runtime);
      throw new Error(`Claude transcript was not created. Screen tail: ${tail}`);
    }

    return this.reconcileLocatedTranscript(runtime, active);
  }

  private reconcileLocatedTranscript(
    runtime: RuntimeSession,
    active: { path: string; startOffset: number },
  ): { transcriptPath: string; startOffset: number } {
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

function parseClaudeModelCommand(text: string): string | undefined {
  const match = text.trim().match(/^\/model(?:@\w+)?\s+([a-zA-Z0-9_.:-]+)$/u);
  return match?.[1];
}

function shouldPassClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return Boolean(normalized && normalized !== "default");
}

const TELECODEX_CLAUDE_SETTINGS = {
  channelsEnabled: false,
  enabledPlugins: {
    "telegram@claude-plugins-official": false,
  },
};

const TELECODEX_CLAUDE_SYSTEM_PROMPT = [
  "You are running inside TeleCodex, which relays this Claude Code session to Anthony through its own Telegram bot.",
  "Do not send Telegram messages yourself. Do not use Telegram channel plugins, Telegram skills, Telegram bot tokens, curl requests to api.telegram.org, or scripts that contact Telegram.",
  "Return every response through the current Claude Code conversation transcript only; TeleCodex will deliver it to Anthony.",
].join("\n");

function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function screenTail(ptySession: ClaudePty | undefined): string {
  const text = ptySession?.strippedText().replace(/\s+/g, " ").trim() ?? "";
  return text.slice(-1000) || "(empty)";
}

function extractScreenFallbackText(before: string, after: string): string | undefined {
  const delta = after.length > before.length ? after.slice(before.length) : after;
  const normalized = delta.replace(/\s+/g, " ").trim();
  const candidates: string[] = [];
  for (const match of normalized.matchAll(/\u25cf\s*([^\u25cf]{1,2000})/giu)) {
    const candidate = cleanScreenFallbackCandidate(match[1] ?? "");
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates.at(-1);
}

function cleanScreenFallbackCandidate(raw: string): string | undefined {
  const candidate = raw
    .replace(/\s*[\u2722\u273b\u273d\u2736*]\s+\S+ing\b[\s\S]*$/iu, "")
    .replace(/[\u2500-\u257f]/g, " ")
    .replace(/[\u23f5\u25cf\u2722\u273b\u273d\u2736]/g, " ")
    .replace(/\s+(?:[\u00b7*]?\s*)?(?:Booping|Bootstrapping|Cogitated|Crunched|Worked|Thinking|Precipitating)\b[\s\S]*$/iu, "")
    .replace(/\s*\([^)]*\btokens?\)[\s\S]*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return undefined;
  }

  const lower = candidate.toLowerCase();
  if (
    lower.includes("accept edits") ||
    lower.includes("shift+tab") ||
    lower.includes("/effort") ||
    lower.includes("telecodex") ||
    lower.includes("tokens)") ||
    lower === "high" ||
    lower === "medium" ||
    lower === "low"
  ) {
    return undefined;
  }
  return candidate;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asPermissionMode(value: unknown): ClaudePermissionMode | undefined {
  return value === "default" || value === "acceptEdits" || value === "plan" || value === "bypassPermissions"
    ? value
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
