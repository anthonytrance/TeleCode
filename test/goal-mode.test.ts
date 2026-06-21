import { describe, expect, it } from "vitest";

import { applyGoalModeConstraints, formatThreadGoal, parseGoalModeArgument } from "../src/goal-mode.js";

describe("parseGoalModeArgument", () => {
  it("parses status and control commands", () => {
    expect(parseGoalModeArgument("")).toEqual({ kind: "status" });
    expect(parseGoalModeArgument("status")).toEqual({ kind: "status" });
    expect(parseGoalModeArgument("pause")).toEqual({ kind: "pause" });
    expect(parseGoalModeArgument("resume")).toEqual({ kind: "resume" });
    expect(parseGoalModeArgument("clear")).toEqual({ kind: "clear" });
  });

  it("parses a plain goal", () => {
    expect(parseGoalModeArgument("finish the command")).toEqual({
      kind: "set",
      objective: "finish the command",
      noAgents: false,
    });
  });

  it("parses no-agents goal aliases", () => {
    expect(parseGoalModeArgument("no-agents finish the command")).toEqual({
      kind: "set",
      objective: "finish the command",
      noAgents: true,
    });
    expect(parseGoalModeArgument("--no-agents finish the command")).toEqual({
      kind: "set",
      objective: "finish the command",
      noAgents: true,
    });
    expect(parseGoalModeArgument("noagents finish the command")).toEqual({
      kind: "set",
      objective: "finish the command",
      noAgents: true,
    });
  });

  it("returns an empty objective for a bare no-agents flag", () => {
    expect(parseGoalModeArgument("no-agents")).toEqual({
      kind: "set",
      objective: "",
      noAgents: true,
    });
  });
});

describe("applyGoalModeConstraints", () => {
  it("keeps normal objectives untouched", () => {
    expect(applyGoalModeConstraints("  ship it  ")).toBe("ship it");
  });

  it("adds the no-agents constraint to the objective", () => {
    const objective = applyGoalModeConstraints("ship it", { noAgents: true });

    expect(objective).toContain("ship it");
    expect(objective).toContain("do not spawn subagents or child sessions");
  });
});

describe("formatThreadGoal", () => {
  it("formats missing goals", () => {
    expect(formatThreadGoal(null)).toBe("No goal is currently set for this thread.");
  });

  it("formats active goals with commands", () => {
    expect(
      formatThreadGoal({
        threadId: "thread-1",
        objective: "finish the bridge",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 12_500,
        timeUsedSeconds: 3660,
        createdAt: 1,
        updatedAt: 2,
      }),
    ).toContain("Commands: /goal resume, /goal pause, /goal clear");
  });
});
