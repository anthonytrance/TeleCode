import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PersistedAgentSessionState } from "./agent-session-manager.js";

export function createEmptyAgentSessionState(): PersistedAgentSessionState {
  return {
    version: 1,
    lanes: [],
    sessions: [],
    jobs: [],
  };
}

export function agentSessionStatePath(workspace: string): string {
  return path.join(workspace, ".telecodex", "agent-sessions.json");
}

export class JsonAgentSessionStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedAgentSessionState {
    if (!existsSync(this.filePath)) {
      return createEmptyAgentSessionState();
    }

    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedAgentSessionState;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported agent session state version: ${parsed.version}`);
    }

    return {
      version: 1,
      lanes: parsed.lanes ?? [],
      sessions: parsed.sessions ?? [],
      jobs: parsed.jobs ?? [],
    };
  }

  save(state: PersistedAgentSessionState): void {
    if (state.version !== 1) {
      throw new Error(`Unsupported agent session state version: ${state.version}`);
    }

    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
