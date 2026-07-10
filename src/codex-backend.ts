import type { ModelReasoningEffort } from "@openai/codex-sdk";

import { AppServerSessionService } from "./app-server-session.js";
import type { CodexLaunchProfile } from "./codex-launch.js";
import {
  CodexSessionService,
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexThreadGoal,
  type CodexThreadGoalSetParams,
  type CodexSessionInfo,
  type CreateOptions,
} from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { CodexModelRecord, CodexThreadRecord } from "./codex-state.js";

export interface CodexSessionRuntime {
  getInfo(): CodexSessionInfo;
  isProcessing(): boolean;
  getProcessingKind?(): "prompt" | "goal" | null;
  hasActiveThread(): boolean;
  getCurrentWorkspace(): string;
  prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void>;
  getThreadGoal?(): Promise<CodexThreadGoal | null>;
  setThreadGoal?(params: CodexThreadGoalSetParams): Promise<CodexThreadGoal>;
  clearThreadGoal?(): Promise<boolean>;
  runThreadGoal?(params: CodexThreadGoalSetParams, callbacks: CodexSessionCallbacks): Promise<CodexThreadGoal | null>;
  pauseActiveGoal?(): Promise<CodexThreadGoal | null>;
  steer?(input: CodexPromptInput): Promise<void>;
  forkThread?(): Promise<CodexSessionInfo>;
  getTurnCount?(): Promise<number>;
  compactThread?(): Promise<void>;
  renameThread?(name: string): Promise<void>;
  rollbackThread?(turnCount: number): Promise<void>;
  abort(): Promise<void>;
  resetBackendClient?(): void;
  prepareNewThread(workspace?: string, model?: string): CodexSessionInfo;
  newThread(workspace?: string, model?: string): Promise<CodexSessionInfo>;
  resumeThread(threadId: string): Promise<CodexSessionInfo>;
  switchSession(threadId: string): Promise<CodexSessionInfo>;
  listAllSessions(limit?: number): CodexThreadRecord[];
  listWorkspaces(): string[];
  listModels(): CodexModelRecord[];
  setModel(slug: string): string;
  runText(input: CodexPromptInput): Promise<string>;
  setReasoningEffort(effort: ModelReasoningEffort): void;
  setLaunchProfile(profileId: string): CodexLaunchProfile;
  getSelectedLaunchProfile(): CodexLaunchProfile;
  handback(): { threadId: string | null; workspace: string };
  dispose(): void;
}

export async function createCodexSession(
  config: TeleCodexConfig,
  options?: CreateOptions,
): Promise<CodexSessionRuntime> {
  if (config.codexBackend === "sdk") {
    return await CodexSessionService.create(config, options);
  }

  return await AppServerSessionService.create(config, options);
}
