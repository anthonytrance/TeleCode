import { formatToolSummaryLine, formatTurnUsageLine, renderSummaryProgressMessage, summarizeToolName } from "../src/bot.js";

describe("tool summary formatting", () => {
  it("normalizes raw tool names into compact summary categories", () => {
    expect(summarizeToolName("ls -la")).toBe("bash");
    expect(summarizeToolName("🔍 latest codex release")).toBe("web_fetch");
    expect(summarizeToolName("mcp:codex_apps/spawn_agent")).toBe("subagent");
    expect(summarizeToolName("mcp:codex_apps/github_fetch")).toBe("github_fetch");
    expect(summarizeToolName("file_change")).toBe("file_change");
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
      "Working: npm test\nRecent:\n- Started git status\n- Started npm test\nTools used: 2x bash",
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
