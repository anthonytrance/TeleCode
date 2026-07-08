import {
  formatClaudeContextLine,
  formatToolSummaryLine,
  formatTurnUsageLine,
  isOversizedProgressBlock,
  PROGRESS_EDIT_BUDGET_CHARS,
  renderAssistantProgressMessage,
  renderSummaryProgressMessage,
  summarizeToolName,
} from "../src/bot.js";

describe("tool summary formatting", () => {
  it("normalizes raw tool names into compact summary categories", () => {
    expect(summarizeToolName("ls -la")).toBe("bash");
    expect(summarizeToolName("🔍 latest codex release")).toBe("web_fetch");
    expect(summarizeToolName("search latest codex release")).toBe("web_search");
    expect(summarizeToolName("mcp:codex_apps/spawn_agent")).toBe("subagent");
    expect(summarizeToolName("mcp:codex_apps/github_fetch")).toBe("github_fetch");
    expect(summarizeToolName("file_change")).toBe("file_change");
    expect(summarizeToolName("plan")).toBe("plan");
  });

  it("formats a short summary line with grouped counts", () => {
    const toolCounts = new Map<string, number>([
      ["ls -la", 2],
      ["git status", 1],
      ["mcp:codex_apps/spawn_agent", 2],
      ["🔍 latest codex release", 1],
    ]);

    expect(formatToolSummaryLine(toolCounts)).toBe(
      "Tools used: 3x bash, 2x subagents, web_fetch",
    );
  });

  it("formats a single editable progress message for summary mode", () => {
    const toolCounts = new Map<string, number>([
      ["npm test", 1],
      ["git status", 1],
    ]);

    const rendered = renderSummaryProgressMessage("npm test", toolCounts, [
      "Started git status",
      "Started npm test",
    ]);

    expect(rendered.fallbackText).toBe(
      "Working: bash\nRecent:\n- Started git status\n- Started npm test\nTools used: 2x bash",
    );
    expect(rendered.text).toContain("<b>Working:</b>");
    expect(rendered.text).toContain("<b>Recent:</b>");
    expect(rendered.text).toContain("Tools used: 2x bash");
  });

  it("keeps only the latest progress lines in summary progress", () => {
    const rendered = renderSummaryProgressMessage(
      "tool 6",
      new Map<string, number>([["tool 6", 1]]),
      ["tool 1", "tool 2", "tool 3", "tool 4", "tool 5", "tool 6"],
    );

    expect(rendered.fallbackText).not.toContain("tool 1");
    expect(rendered.fallbackText).toContain("- tool 2");
    expect(rendered.fallbackText).toContain("- tool 6");
  });

  it("formats assistant progress without tool summary wording", () => {
    const rendered = renderAssistantProgressMessage([
      "I am checking the message handling path.",
      "I found the edit-mode throttle.",
    ]);

    expect(rendered.fallbackText).toBe(
      "Progress:\n- I am checking the message handling path.\n- I found the edit-mode throttle.",
    );
    expect(rendered.fallbackText).not.toContain("Working: bash");
    expect(rendered.fallbackText).not.toContain("Tools used");
  });

  it("never truncates narration blocks and preserves their newlines", () => {
    const block = `first paragraph line\nsecond paragraph line\n\n${"x".repeat(2000)}`;
    const rendered = renderAssistantProgressMessage([block]);

    expect(rendered.fallbackText).toBe(`Progress:\n- ${block}`);
    expect(rendered.fallbackText).not.toContain("...");
    expect(rendered.text.length).toBeLessThanOrEqual(4000);
  });

  it("drops oldest blocks, never characters, when the edit budget is exceeded", () => {
    const older = `OLDER ${"a".repeat(2000)}`;
    const middle = `MIDDLE ${"b".repeat(2000)}`;
    const newest = `NEWEST ${"c".repeat(2000)}`;
    const rendered = renderAssistantProgressMessage([older, middle, newest]);

    expect(rendered.fallbackText).toContain(newest);
    expect(rendered.fallbackText).not.toContain("MIDDLE");
    expect(rendered.fallbackText).not.toContain("OLDER");
    expect(rendered.fallbackText).not.toContain("...");
    expect(rendered.text.length).toBeLessThanOrEqual(4000);
  });

  it("classifies blocks larger than the budget as oversized", () => {
    expect(isOversizedProgressBlock("short update")).toBe(false);
    expect(isOversizedProgressBlock("y".repeat(PROGRESS_EDIT_BUDGET_CHARS + 1))).toBe(true);
  });

  it("reports a percentage only when usage fits the configured context window", () => {
    expect(formatClaudeContextLine(100000, 200000)).toBe("Context: 100000 of 200000 tokens (50%).");
    const exceeded = formatClaudeContextLine(228000, 200000);
    expect(exceeded).toContain("Context: 228000 tokens used.");
    expect(exceeded).toContain("real window is larger");
    expect(exceeded).not.toContain("%");
  });

  it("keeps the turn usage line format stable when enabled", () => {
    expect(
      formatTurnUsageLine({
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 9,
      }),
    ).toBe("🪙 in: 12 · cached: 3 · out: 9");
  });
});
