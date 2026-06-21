import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentSessionManager } from "../src/agent-session-manager.js";
import {
  agentSessionStatePath,
  createEmptyAgentSessionState,
  JsonAgentSessionStore,
} from "../src/agent-session-store.js";

describe("JsonAgentSessionStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-agent-store-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses a separate agent session state path", () => {
    expect(agentSessionStatePath(tempDir)).toBe(path.join(tempDir, ".telecodex", "agent-sessions.json"));
  });

  it("returns empty state when no file exists", () => {
    const store = new JsonAgentSessionStore(agentSessionStatePath(tempDir));

    expect(store.load()).toEqual(createEmptyAgentSessionState());
  });

  it("saves and loads agent session state without touching legacy contexts", () => {
    const telecodexDir = path.join(tempDir, ".telecodex");
    const legacyPath = path.join(telecodexDir, "contexts.json");
    const storePath = agentSessionStatePath(tempDir);
    const manager = new AgentSessionManager({ idGenerator: (prefix) => `${prefix}-1`, now: () => 1000 });
    const session = manager.createSession("123", "codex", { workspace: tempDir });
    manager.startJob(session.id);

    mkdirSync(telecodexDir, { recursive: true });
    writeFileSync(legacyPath, JSON.stringify([{ contextKey: "legacy" }]), { encoding: "utf8", flag: "wx" });

    const store = new JsonAgentSessionStore(storePath);
    store.save(manager.serialize());

    expect(existsSync(storePath)).toBe(true);
    expect(readFileSync(legacyPath, "utf8")).toBe(JSON.stringify([{ contextKey: "legacy" }]));
    expect(new AgentSessionManager({ state: store.load() }).getSelectedSession("123")).toMatchObject({
      id: session.id,
      provider: "codex",
      workspace: tempDir,
    });
  });
});
