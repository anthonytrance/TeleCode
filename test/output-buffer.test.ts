import { OutputBuffer } from "../src/output-buffer.js";

describe("OutputBuffer", () => {
  it("buffers events per session and marks final output as priority", () => {
    let id = 0;
    const buffer = new OutputBuffer({
      idGenerator: () => `event-${++id}`,
      now: () => 1000 + id,
    });

    buffer.append("session-a", { kind: "assistant", text: "Working" });
    const final = buffer.append("session-a", { kind: "final", text: "Done" });
    buffer.append("session-b", { kind: "artifact", artifactPath: "/tmp/result.txt" });

    expect(final.priority).toBe(true);
    expect(buffer.list("session-a").map((event) => event.text)).toEqual(["Working", "Done"]);
    expect(buffer.summarize("session-a")).toMatchObject({
      sessionId: "session-a",
      total: 2,
      priority: 1,
      finalMessages: 1,
      artifacts: 0,
    });
    expect(buffer.summarize("session-b")).toMatchObject({
      total: 1,
      priority: 1,
      artifacts: 1,
    });
  });

  it("drains unread output without affecting other sessions", () => {
    const buffer = new OutputBuffer({ idGenerator: () => "event", now: () => 1000 });
    buffer.append("session-a", { kind: "final", text: "Done" });
    buffer.append("session-b", { kind: "question", text: "Choose one" });

    expect(buffer.hasUnread("session-a")).toBe(true);
    expect(buffer.drain("session-a")).toHaveLength(1);
    expect(buffer.hasUnread("session-a")).toBe(false);
    expect(buffer.hasUnread("session-b")).toBe(true);
  });

  it("can drain only priority output while keeping narration history", () => {
    let id = 0;
    const buffer = new OutputBuffer({ idGenerator: () => `event-${++id}`, now: () => 1000 + id });
    buffer.append("session-a", { kind: "assistant", text: "Working" });
    buffer.append("session-a", { kind: "tool", text: "Read file" });
    buffer.append("session-a", { kind: "final", text: "Done" });

    const priority = buffer.drainWhere("session-a", (event) => event.priority);

    expect(priority.map((event) => event.text)).toEqual(["Done"]);
    expect(buffer.list("session-a").map((event) => event.text)).toEqual(["Working", "Read file"]);
  });

  it("bounds retained events while preserving priority output when possible", () => {
    let id = 0;
    const buffer = new OutputBuffer({
      idGenerator: () => `event-${++id}`,
      now: () => 1000 + id,
      maxEventsPerSession: 3,
    });
    buffer.append("session-a", { kind: "question", text: "Choose one" });
    buffer.append("session-a", { kind: "assistant", text: "First" });
    buffer.append("session-a", { kind: "assistant", text: "Second" });
    buffer.append("session-a", { kind: "assistant", text: "Third" });

    expect(buffer.list("session-a").map((event) => event.text)).toEqual([
      "Choose one",
      "Second",
      "Third",
    ]);
  });
});
