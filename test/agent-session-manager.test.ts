import type { ContextMetadata } from "../src/session-registry.js";
import { AgentSessionManager } from "../src/agent-session-manager.js";

describe("AgentSessionManager", () => {
  it("aborts jobs that were still in flight in persisted state", () => {
    const manager = new AgentSessionManager({
      now: () => 200,
      state: {
        version: 1,
        lanes: [{
          laneKey: "123",
          defaultProvider: "claude",
          sessionIds: ["claude-1"],
          selectedSessionId: "claude-1",
          deliveryMode: "buffer-background",
          notifyOnBackgroundCompletion: true,
          createdAt: 100,
          updatedAt: 100,
        }],
        sessions: [{
          id: "claude-1",
          laneKey: "123",
          provider: "claude",
          workspace: "C:\\workspace",
          status: "running",
          currentJobId: "job-1",
          createdAt: 100,
          updatedAt: 100,
        }],
        jobs: [{
          id: "job-1",
          laneKey: "123",
          sessionId: "claude-1",
          provider: "claude",
          status: "running",
          startedAt: 100,
          updatedAt: 100,
        }],
      },
    });

    expect(manager.abortPersistedJobs()).toHaveLength(1);
    expect(manager.getSession("claude-1")).toMatchObject({ status: "aborted", currentJobId: undefined });
    expect(manager.listJobs()[0]).toMatchObject({ status: "aborted", completedAt: 200 });
  });

  const createManager = () => {
    let now = 1000;
    let id = 0;
    return new AgentSessionManager({
      now: () => {
        now += 10;
        return now;
      },
      idGenerator: (prefix) => `${prefix}-${++id}`,
    });
  };

  it("creates lanes and selects the first session by default", () => {
    const manager = createManager();

    const session = manager.createSession("123", "codex", {
      workspace: "/workspace",
      displayName: "Codex main",
    });

    expect(manager.getLane("123")).toMatchObject({
      laneKey: "123",
      selectedSessionId: session.id,
      defaultProvider: "codex",
      sessionIds: [session.id],
    });
    expect(manager.getSelectedSession("123")).toEqual(session);
  });

  it("switches selected sessions without changing running background jobs", () => {
    const manager = createManager();
    const codex = manager.createSession("123", "codex", { workspace: "/workspace" });
    const claude = manager.createSession("123", "claude", {
      workspace: "/workspace",
      select: false,
    });

    const codexJob = manager.startJob(codex.id);
    manager.selectSession("123", claude.id);

    expect(manager.getSelectedSession("123")?.id).toBe(claude.id);
    expect(manager.getSession(codex.id)).toMatchObject({
      id: codex.id,
      status: "running",
      currentJobId: codexJob.id,
    });
    expect(manager.listJobs("123")).toEqual([codexJob]);
  });

  it("marks jobs and sessions completed together", () => {
    const manager = createManager();
    const session = manager.createSession("123", "codex", { workspace: "/workspace" });
    const job = manager.startJob(session.id);

    const completed = manager.completeJob(job.id);

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(manager.getSession(session.id)).toMatchObject({
      status: "completed",
      currentJobId: undefined,
    });
  });

  it("updates a session display name without changing the selected session", () => {
    const manager = createManager();
    const session = manager.createSession("123", "claude", {
      workspace: "/workspace",
      displayName: "Claude",
    });

    const updated = manager.updateDisplayName(session.id, "Daily Codex integration");

    expect(updated.displayName).toBe("Daily Codex integration");
    expect(manager.getSelectedSession("123")).toMatchObject({
      id: session.id,
      displayName: "Daily Codex integration",
    });
  });

  it("updates session metadata without changing the selected session", () => {
    const manager = createManager();
    const session = manager.createSession("123", "claude", {
      workspace: "/workspace",
      metadata: { model: "sonnet" },
    });

    const updated = manager.updateMetadata(session.id, { model: "fable" });

    expect(updated.metadata).toEqual({ model: "fable" });
    expect(manager.getSelectedSession("123")).toMatchObject({
      id: session.id,
      metadata: { model: "fable" },
    });
  });

  it("imports legacy Codex context metadata into stable selected sessions", () => {
    const manager = createManager();
    const contexts: ContextMetadata[] = [
      {
        contextKey: "123",
        threadId: "thread-a",
        workspace: "/workspace/a",
        model: "gpt-5.4",
        reasoningEffort: "high",
        launchProfileId: "default",
        backend: "sdk",
        progressDelivery: "messages",
        updatedAt: 1,
      },
      {
        contextKey: "123:42",
        threadId: "thread-b",
        workspace: "/workspace/b",
        updatedAt: 2,
      },
    ];

    const imported = manager.importLegacyContexts(contexts);

    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      laneKey: "123",
      provider: "codex",
      providerSessionId: "thread-a",
      workspace: "/workspace/a",
      metadata: {
        legacyContextKey: "123",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
    });
    expect(manager.getSelectedSession("123")?.id).toBe(imported[0]!.id);
    expect(manager.getSelectedSession("123:42")?.providerSessionId).toBe("thread-b");
  });

  it("reconciles and reselects an existing legacy session when its context thread changes", () => {
    const manager = createManager();
    manager.importLegacyContexts([{
      contextKey: "123",
      threadId: "wrong-thread",
      workspace: "/workspace/old",
      model: "old-model",
      updatedAt: 1,
    }]);
    const newer = manager.createSession("123", "codex", {
      workspace: "/workspace/current",
      providerSessionId: "newer-thread",
    });
    expect(manager.getSelectedSession("123")?.id).toBe(newer.id);

    const [restored] = manager.importLegacyContexts([{
      contextKey: "123",
      threadId: "original-thread",
      workspace: "/workspace/restored",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      updatedAt: 2,
    }], { selectImported: true });

    expect(restored).toMatchObject({
      providerSessionId: "original-thread",
      workspace: "/workspace/restored",
      metadata: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });
    expect(manager.getSelectedSession("123")?.id).toBe(restored!.id);
  });

  it("preserves a legacy conversation's identity and title when a different thread is restored", () => {
    const manager = createManager();
    const [legacy] = manager.importLegacyContexts([{
      contextKey: "123", threadId: "djay-thread", workspace: "/workspace", updatedAt: 1,
    }]);
    manager.updateDisplayName(legacy!.id, "DJ pro accessibility");
    const [restored] = manager.importLegacyContexts([{
      contextKey: "123", threadId: "telecode-thread", workspace: "/workspace", updatedAt: 2,
    }]);

    expect(restored!.id).not.toBe(legacy!.id);
    expect(restored!.displayName).not.toBe("DJ pro accessibility");
    expect(manager.getSession(legacy!.id)).toMatchObject({
      providerSessionId: "djay-thread", displayName: "DJ pro accessibility",
    });
    expect(manager.getSelectedSession("123")?.providerSessionId).toBe("telecode-thread");
  });

  it("restores the existing record for the exact thread rather than repointing the legacy record", () => {
    const manager = createManager();
    const [legacy] = manager.importLegacyContexts([{
      contextKey: "123", threadId: "djay-thread", workspace: "/workspace", updatedAt: 1,
    }]);
    const current = manager.createSession("123", "codex", {
      workspace: "/workspace", providerSessionId: "telecode-thread", displayName: "TeleCode routing",
    });
    const [restored] = manager.importLegacyContexts([{
      contextKey: "123", threadId: "telecode-thread", workspace: "/workspace", updatedAt: 2,
    }]);

    expect(restored!.id).toBe(current.id);
    expect(restored!.displayName).toBe("TeleCode routing");
    expect(manager.getSession(legacy!.id)?.providerSessionId).toBe("djay-thread");
    expect(manager.listLaneSessions("123")).toHaveLength(2);
  });

  it("serializes and reloads state", () => {
    const manager = createManager();
    const session = manager.createSession("123", "claude", { workspace: "/workspace" });
    const job = manager.startJob(session.id);
    const serialized = manager.serialize();

    const reloaded = new AgentSessionManager({ state: serialized });

    expect(reloaded.getSelectedSession("123")).toEqual(manager.getSelectedSession("123"));
    expect(reloaded.listJobs()).toEqual([job]);
  });

  it("persists the ordering preference independently for each lane", () => {
    const manager = createManager();
    manager.ensureLane("123");
    manager.ensureLane("456");
    expect(manager.getSessionOrder("123")).toBe("used");
    manager.setSessionOrder("123", "created");
    const reloaded = new AgentSessionManager({ state: manager.serialize() });
    expect(reloaded.getSessionOrder("123")).toBe("created");
    expect(reloaded.getSessionOrder("456")).toBe("used");
  });

  it("records successful selections monotonically without counting background activity", () => {
    const manager = new AgentSessionManager({ now: () => 1000 });
    const first = manager.createSession("123", "codex", { workspace: "/workspace" });
    const second = manager.createSession("123", "claude", { workspace: "/workspace" });
    expect(second.lastSelectedAt).toBeGreaterThan(first.lastSelectedAt!);
    const before = manager.getSession(first.id)?.lastSelectedAt;
    const job = manager.startJob(first.id);
    manager.completeJob(job.id);
    manager.updateDisplayName(first.id, "Background answer");
    manager.updateMetadata(first.id, { model: "test" });
    expect(manager.getSession(first.id)?.lastSelectedAt).toBe(before);
    manager.selectSession("123", first.id);
    const selectedAt = manager.getSession(first.id)!.lastSelectedAt!;
    expect(selectedAt).toBeGreaterThan(second.lastSelectedAt!);
    manager.selectSession("123", first.id);
    expect(manager.getSession(first.id)?.lastSelectedAt).toBe(selectedAt);
  });

  it("restores legacy state and preserves selection recency across metadata import", () => {
    const manager = createManager();
    const first = manager.createSession("123", "codex", { workspace: "/workspace", providerSessionId: "thread-1" });
    const second = manager.createSession("123", "codex", { workspace: "/workspace", providerSessionId: "thread-2" });
    const state = manager.serialize();
    delete state.sessions[0].lastSelectedAt;
    const restored = new AgentSessionManager({ state });
    restored.importLegacyContexts([{ contextKey: "123", threadId: "thread-2", workspace: "/workspace", updatedAt: 9999 }]);
    expect(restored.getSession(second.id)?.lastSelectedAt).toBe(second.lastSelectedAt);
    restored.selectSession("123", first.id);
    expect(restored.getSession(first.id)?.lastSelectedAt).toBeGreaterThan(second.lastSelectedAt!);
  });
});
