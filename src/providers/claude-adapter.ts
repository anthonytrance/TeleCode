import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
import { getClaudeCommandSpec, parseClaudeSlashCommand } from "./claude-commands.js";
import {
  CLAUDE_FULLSCREEN_PROMPT_MARKERS,
  CLAUDE_READY_MARKERS,
  CLAUDE_RESUME_WARNING_MARKERS,
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
  locateSingleHumanPromptTurn,
  locateTranscriptTurnByPrompt,
  sessionIdFromTranscriptPath,
  snapshotTranscriptSizes,
  TranscriptTailer,
  type ActiveTranscript,
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
  /** Set by abort(); the running turn's tailer stops promptly instead of idling out. */
  abortRequested?: boolean;
  lastUsage?: ClaudeUsageSnapshot;
  /** Path to the transcript Claude actually writes; discovered on the first turn. */
  transcriptPath?: string;
  ptyPid?: number;
}

type LocatedTurnOutput =
  | { transcriptPath: string; startOffset: number }
  | { fallbackText: string };

type StartupStatusCallback = (text: string) => void | Promise<void>;

export class ClaudeProviderAdapter implements AgentProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly processRegistry: ClaudeProcessRegistry;

  constructor(private readonly config: TeleCodexConfig) {
    this.processRegistry = new ClaudeProcessRegistry(claudeProcessRegistryPath(config.workspace));
  }

  async createSession(
    options: CreateAgentSessionOptions,
    onStartupStatus?: StartupStatusCallback,
  ): Promise<AgentSessionDescriptor> {
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
    try {
      await this.ensurePty(runtime, "new", onStartupStatus);
    } catch (error) {
      this.sessions.delete(descriptor.id);
      await this.stopRuntimePty(runtime, { graceful: false }).catch(() => {});
      throw error;
    }
    return { ...descriptor };
  }

  async resumeSession(
    session: AgentSessionDescriptor,
    onStartupStatus?: StartupStatusCallback,
  ): Promise<AgentSessionDescriptor> {
    this.validateEnabled();
    const runtime = this.runtimeFromDescriptor(session);
    this.sessions.set(session.id, runtime);
    try {
      await this.ensurePty(runtime, "resume", onStartupStatus);
    } catch (error) {
      this.sessions.delete(session.id);
      await this.stopRuntimePty(runtime, { graceful: false }).catch(() => {});
      throw error;
    }
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
    runtime.abortRequested = false;
    runtime.descriptor.status = "running";
    runtime.descriptor.updatedAt = Date.now();
    yield { type: "session_status_changed", sessionId: runtime.descriptor.id, status: "running" };

    try {
      const startupEvents: AgentProviderEvent[] = [];
      let startupError: unknown;
      let startupDone = false;
      const startup = this.ensurePty(runtime, "resume", (text) => {
        startupEvents.push({
          type: "status_message",
          sessionId: runtime.descriptor.id,
          jobId: options.jobId,
          text,
        });
      });
      startup.then(
        () => {
          startupDone = true;
        },
        (error: unknown) => {
          startupError = error;
          startupDone = true;
        },
      );
      while (!startupDone || startupEvents.length > 0) {
        while (startupEvents.length > 0) {
          yield startupEvents.shift()!;
        }
        if (!startupDone) {
          await sleep(250);
        }
      }
      if (startupError) {
        throw startupError;
      }
      const modelCommand = parseClaudeModelCommand(promptText);
      if (modelCommand) {
        const resultText = await this.applyModelCommand(runtime, promptText, modelCommand);
        const text = resultText || `Claude model command sent: ${modelCommand}. Use /status to confirm the active model.`;
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

      // Real Claude slash commands (DISPATCH / DISPATCH+ARG, e.g. /diff, /memory, /review)
      // are typed into the PTY, but Claude records them as <command-name> entries rather
      // than a plain user prompt, so requiring a prompt echo would time out and then kill
      // the PTY. Detect those and locate the turn by transcript growth instead, and never
      // dispose the session if the command produced no readable turn.
      const isSlashCommand = isDispatchSlashCommand(promptText);
      const output = await this.locateTurnTranscript(
        runtime,
        promptText,
        () => runtime.pty!.sendPrompt(promptText),
        { requirePromptEcho: !isSlashCommand, disposeOnFailure: !isSlashCommand },
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

      const tailer = new TranscriptTailer(output.transcriptPath, {
        startOffset: output.startOffset,
        // Poll faster than the 750ms default so narration lines reach Telegram promptly.
        pollIntervalMs: 300,
      });
      let partialAssistantText = "";
      for await (const event of tailer.eventsUntilTurnEnd({
        sessionId: runtime.descriptor.id,
        jobId: options.jobId,
        idleTimeoutMs: this.config.claudeTurnIdleTimeoutSeconds * 1000,
        shouldStop: () => runtime.abortRequested === true,
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
        } else if (event.type === "model_updated") {
          runtime.model = event.model;
          runtime.descriptor.metadata = {
            ...runtime.descriptor.metadata,
            model: event.model,
          };
          runtime.descriptor.updatedAt = Date.now();
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
    runtime.abortRequested = true;
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

  /**
   * Scrape Claude Code's own `/usage` panel, which is the only place the live subscription
   * rate-limit picture (5-hour block, weekly, resets) is shown — it is not in the transcript
   * or any local file. We drive the interactive panel in the PTY, capture the rendered text,
   * then dismiss it and confirm the prompt returned so the session stays usable.
   */
  async getUsageReport(sessionId: string): Promise<string | null> {
    const runtime = this.requireRuntime(sessionId);
    if (runtime.busy) {
      throw new Error("Cannot read Claude usage while a turn is running");
    }
    await this.ensurePty(runtime, "resume");
    const ptySession = runtime.pty;
    if (!ptySession) {
      return null;
    }

    ptySession.clearBuffer();
    await ptySession.sendCommand("/usage");
    // Wait for the panel to paint; on no match, fall through and scrape whatever rendered.
    await ptySession.waitForMarker(
      [/current/, /resets?/, /limit/, /%/, /week/, /session/, /usage/],
      8000,
    );
    await sleep(900);
    const screen = ptySession.strippedText();

    // Dismiss the panel and confirm the interactive prompt came back, so the next turn is
    // typed at the prompt and not into a stuck panel.
    ptySession.pressEscape();
    ptySession.clearBuffer();
    const ready = await ptySession.waitForReadyPrompt(4000);
    if (!ready) {
      ptySession.pressEscape();
      await sleep(400);
    }

    return cleanUsagePanel(screen);
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

  private async ensurePty(
    runtime: RuntimeSession,
    mode: "new" | "resume",
    onStartupStatus?: StartupStatusCallback,
  ): Promise<void> {
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

    const readyTimeoutMs = mode === "resume" ? 90000 : 30000;
    const firstMarker = await ptySession.waitForMarker([
      ...CLAUDE_TRUST_MARKERS,
      ...CLAUDE_FULLSCREEN_PROMPT_MARKERS,
      ...CLAUDE_RESUME_WARNING_MARKERS,
      ...CLAUDE_READY_MARKERS,
    ], readyTimeoutMs);
    if (!firstMarker) {
      await ptySession.dispose(false);
      this.removeRegisteredProcessSession(runtime.descriptor.id);
      throw new Error(`Claude did not reach a ready prompt. Screen tail: ${screenTail(ptySession)}`);
    }
    if (firstMarker === CLAUDE_TRUST_MARKERS[0]!.source) {
      ptySession.pressEnter();
      ptySession.clearBuffer();
      const ready = await ptySession.waitForReadyPrompt(30000);
      if (!ready) {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error(`Claude trust dialog was accepted, but the prompt did not become ready. Screen tail: ${screenTail(ptySession)}`);
      }
    }
    if (firstMarker === CLAUDE_FULLSCREEN_PROMPT_MARKERS[0]!.source) {
      ptySession.typeText("2");
      ptySession.pressEnter();
      ptySession.clearBuffer();
      const ready = await ptySession.waitForReadyPrompt(30000);
      if (!ready) {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error(`Claude fullscreen prompt was dismissed, but the prompt did not become ready. Screen tail: ${screenTail(ptySession)}`);
      }
    }
    if (CLAUDE_RESUME_WARNING_MARKERS.some((marker) => marker.source === firstMarker)) {
      if (this.config.claudeLargeSessionResume === "manual") {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error(
          "Claude is asking how to resume a very large session. Set CLAUDE_LARGE_SESSION_RESUME=summary or full, then restart TeleCodex.",
        );
      }
      const resumeStartedAt = Date.now();
      const resumeStrategy = this.config.claudeLargeSessionResume;
      runtime.descriptor.metadata = {
        ...runtime.descriptor.metadata,
        startupResumeStrategy: resumeStrategy,
        startupResumeStartedAt: resumeStartedAt,
        startupResumeFinishedAt: undefined,
      };
      runtime.descriptor.updatedAt = resumeStartedAt;
      await onStartupStatus?.(
        resumeStrategy === "full"
          ? "Claude is resuming a very large session in full. This can take a while; I will wait before sending your prompt."
          : "Claude is compacting a very large session into a summary. I will wait before sending your prompt.",
      );
      if (this.config.claudeLargeSessionResume === "full") {
        ptySession.typeText("2");
      }
      ptySession.pressEnter();
      ptySession.clearBuffer();
      const ready = await ptySession.waitForReadyPrompt(600000);
      if (!ready) {
        await ptySession.dispose(false);
        this.removeRegisteredProcessSession(runtime.descriptor.id);
        throw new Error(`Claude resume warning was accepted, but the prompt did not become ready. Screen tail: ${screenTail(ptySession)}`);
      }
      const resumeFinishedAt = Date.now();
      runtime.descriptor.metadata = {
        ...runtime.descriptor.metadata,
        startupResumeStrategy: resumeStrategy,
        startupResumeStartedAt: resumeStartedAt,
        startupResumeFinishedAt: resumeFinishedAt,
      };
      runtime.descriptor.updatedAt = resumeFinishedAt;
      await onStartupStatus?.(
        resumeStrategy === "full"
          ? "Claude full-session resume finished. Sending your prompt now."
          : "Claude summary compaction finished. Sending your prompt now.",
      );
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

  private async applyModelCommand(runtime: RuntimeSession, commandText: string, model: string): Promise<string | undefined> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      throw new Error("Claude PTY is not running");
    }

    ptySession.clearBuffer();
    await ptySession.sendCommand(commandText);
    let confirmation = await ptySession.waitForMarker(
      [...CLAUDE_MODEL_CONFIRMATION_MARKERS, ...CLAUDE_MODEL_FAILURE_MARKERS],
      5000,
    );
    let failure = extractModelCommandFailure(ptySession.strippedText());
    if (failure) {
      throw new Error(`Claude model switch failed: ${failure}`);
    }
    if (confirmation) {
      ptySession.typeText("1");
      ptySession.pressEnter();
      ptySession.clearBuffer();
    }

    await sleep(1500);
    await ptySession.waitForReadyPrompt(10000);
    failure = extractModelCommandFailure(ptySession.strippedText());
    if (failure) {
      throw new Error(`Claude model switch failed: ${failure}`);
    }

    runtime.model = model;
    runtime.descriptor.metadata = {
      ...runtime.descriptor.metadata,
      model,
    };
    runtime.descriptor.updatedAt = Date.now();
    return `Claude model command accepted: ${model}. Use /status to confirm the active model.`;
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

  private async stopRuntimePty(runtime: RuntimeSession, options: { graceful?: boolean } = {}): Promise<void> {
    const ptySession = runtime.pty;
    if (!ptySession) {
      return;
    }
    const pid = runtime.ptyPid;
    runtime.pty = undefined;
    runtime.ptyPid = undefined;
    await ptySession.dispose(options.graceful ?? true);
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
    options: { requirePromptEcho?: boolean; disposeOnFailure?: boolean } = {},
  ): Promise<LocatedTurnOutput> {
    const configDir = this.transcriptConfigDir;
    let knownPath = runtime.transcriptPath;
    if (!knownPath) {
      knownPath = (await findTranscript(runtime.providerSessionId, 1000, configDir)) ?? undefined;
    }
    const knownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;
    // Once we know Claude's real transcript path, only look inside that project directory
    // so a concurrent standalone Claude cannot have its transcript mistaken for this turn.
    const projectDir = knownPath ? dirname(knownPath) : undefined;

    const screenBefore = runtime.pty?.strippedText() ?? "";
    const requirePromptEcho = options.requirePromptEcho ?? true;
    const disposeOnFailure = options.disposeOnFailure ?? true;
    const locate = async (
      before: Map<string, number>,
      offset: number,
      timeoutMs: number,
    ): Promise<ActiveTranscript | null> => {
      return requirePromptEcho
        ? await locateActiveTranscriptTurnByPrompt({
            before,
            promptText,
            expectedSessionId: runtime.providerSessionId,
            knownPath,
            knownOffset: offset,
            timeoutMs,
            configDir,
            projectDir,
          })
        : await locateActiveTranscript({
            before,
            expectedSessionId: runtime.providerSessionId,
            knownPath,
            knownOffset: offset,
            timeoutMs,
            configDir,
            projectDir,
          });
    };

    const before = await snapshotTranscriptSizes(configDir);
    await send();

    let active = await locate(before, knownOffset, requirePromptEcho ? 8000 : 30000);
    if (!active && requirePromptEcho && runtime.pty?.isAlive) {
      const ready = await runtime.pty.waitForReadyPrompt(2500);
      if (ready) {
        runtime.pty.clearInput();
        await sleep(100);
        const retryKnownOffset = knownPath && existsSync(knownPath) ? safeFileSize(knownPath) : 0;
        const retryBefore = await snapshotTranscriptSizes(configDir);
        await send();
        active = await locate(retryBefore, retryKnownOffset, 30000);
      } else {
        active = await locate(before, knownOffset, 22000);
      }
    }
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
        const singlePrompt = await locateSingleHumanPromptTurn({
          expectedSessionId: runtime.providerSessionId,
          knownPath,
          minOffset: knownOffset,
          configDir,
        });
        if (singlePrompt) {
          return this.reconcileLocatedTranscript(runtime, singlePrompt);
        }

        const tail = screenTail(runtime.pty);
        // Do not type /exit here. On prompt-location failure Claude may still have the
        // user's prompt sitting in the input box; graceful /exit would append to it and
        // can submit a corrupted prompt.
        if (runtime.pty?.isAlive) {
          const ready = await runtime.pty.waitForReadyPrompt(1000);
          if (ready) {
            runtime.pty.clearInput();
          } else {
            await this.stopRuntimePty(runtime, { graceful: false });
          }
        }
        throw new Error(`Claude did not record the prompt in its transcript. Screen tail: ${tail}`);
      }

      const fallbackText = extractScreenFallbackText(screenBefore, runtime.pty?.strippedText() ?? "");
      if (fallbackText) {
        return { fallbackText };
      }
      if (!disposeOnFailure) {
        // Slash command that wrote no readable turn (e.g. a config-only command). Keep the
        // session alive and report a benign result instead of killing the PTY.
        return { fallbackText: "Claude handled the command. It did not produce a transcript response to read back." };
      }
      const tail = screenTail(runtime.pty);
      // Same as above: if no transcript turn was found, avoid writing /exit into a
      // potentially live input buffer.
      await this.stopRuntimePty(runtime, { graceful: false });
      throw new Error(`Claude transcript was not created. Screen tail: ${tail}`);
    }

    return this.reconcileLocatedTranscript(runtime, active);
  }

  private reconcileLocatedTranscript(
    runtime: RuntimeSession,
    active: { path: string; startOffset: number },
  ): { transcriptPath: string; startOffset: number } {
    runtime.transcriptPath = active.path;
    runtime.descriptor.metadata = {
      ...runtime.descriptor.metadata,
      transcriptPath: active.path,
    };
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
      transcriptPath: asString(descriptor.metadata?.transcriptPath) || undefined,
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

const CLAUDE_MODEL_CONFIRMATION_MARKERS = [
  /switchmodel/,
  /yes,switchto/,
  /switchto/,
  /confirmmodel/,
];

const CLAUDE_MODEL_FAILURE_MARKERS = [
  /model(?:is)?notavailable/,
  /modelunavailable/,
  /notinyourorganizationsallowedmodels/,
  /notinyourorganization'sallowedmodels/,
  /requiresusagecredits/,
  /enableusagecredits/,
  /unknownmodel/,
  /invalidmodel/,
  /notenabled/,
];

function extractModelCommandFailure(screen: string): string | undefined {
  const lines = screen
    .replace(/[\u2500-\u257f\u25cf\u25b0\u25b1\u2722\u273b\u273d\u2736]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const failureLines = lines.filter((line) => {
    const compact = line.replace(/\s+/g, "").toLowerCase();
    return CLAUDE_MODEL_FAILURE_MARKERS.some((marker) => marker.test(compact));
  });
  const candidate = failureLines.at(-1);
  if (!candidate) {
    return undefined;
  }
  return cleanScreenFallbackCandidate(candidate) ?? candidate;
}

/**
 * True when the prompt is a real Claude Code slash command that TeleCodex forwards to the
 * PTY (DISPATCH / DISPATCH+ARG). These are recorded by Claude as <command-name> transcript
 * entries, not plain user prompts, so their turns must be located by transcript growth
 * rather than by prompt echo. /model is handled separately, so it is excluded here.
 */
function isDispatchSlashCommand(text: string): boolean {
  const parsed = parseClaudeSlashCommand(text);
  if (!parsed || parsed.name === "model") {
    return false;
  }
  const spec = getClaudeCommandSpec(parsed.name);
  return spec?.class === "dispatch" || spec?.class === "dispatch_arg";
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

/**
 * Turn a raw `/usage` panel screen capture into a clean, screen-reader-friendly block:
 * drop box-drawing chrome, the input prompt/footer, and the TeleCodex system-prompt echo,
 * then collapse blank runs. Returns null when nothing usable is left.
 */
function cleanUsagePanel(screen: string): string | null {
  const lines = screen
    .replace(/[─-╿⬢⬡●▌▐█]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      const lower = line.toLowerCase();
      return !(
        lower.includes("shift+tab") ||
        lower.includes("? for shortcuts") ||
        lower.includes("esc to") ||
        lower.includes("to go back") ||
        lower.includes("telecodex") ||
        lower.startsWith(">") ||
        lower === "usage" ||
        /^[\s>│|]+$/.test(line)
      );
    });

  const seen = new Set<string>();
  const deduped = lines.filter((line) => {
    if (seen.has(line)) {
      return false;
    }
    seen.add(line);
    return true;
  });

  const text = deduped.join("\n").trim();
  return text.length > 0 ? text : null;
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
