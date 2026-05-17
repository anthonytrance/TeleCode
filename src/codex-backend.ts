import type { ModelReasoningEffort } from "@openai/codex-sdk";

import { AppServerSessionService } from "./app-server-session.js";
import type { CodexLaunchProfile } from "./codex-launch.js";
import {
  CodexSessionService,
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CreateOptions,
} from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { CodexModelRecord, CodexThreadRecord } from "./codex-state.js";

export interface CodexSessionRuntime {
  getInfo(): CodexSessionInfo;
  isProcessing(): boolean;
  hasActiveThread(): boolean;
  getCurrentWorkspace(): string;
  prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void>;
  steer?(input: CodexPromptInput): Promise<void>;
  forkThread?(): Promise<CodexSessionInfo>;
  compactThread?(): Promise<void>;
  renameThread?(name: string): Promise<void>;
  rollbackThread?(turnCount: number): Promise<void>;
  abort(): Promise<void>;
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
