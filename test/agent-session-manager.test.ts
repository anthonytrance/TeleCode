import type { ContextMetadata } from "../src/session-registry.js";
import { AgentSessionManager } from "../src/agent-session-manager.js";

describe("AgentSessionManager", () => {
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

  it("serializes and reloads state", () => {
    const manager = createManager();
    const session = manager.createSession("123", "claude", { workspace: "/workspace" });
    const job = manager.startJob(session.id);
    const serialized = manager.serialize();

    const reloaded = new AgentSessionManager({ state: serialized });

    expect(reloaded.getSelectedSession("123")).toEqual(manager.getSelectedSession("123"));
    expect(reloaded.listJobs()).toEqual([job]);
  });
});
