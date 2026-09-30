import { describe, expect, it } from "vitest";
import { formatClaudeModelChoice, resolveClaudeModelId } from "../src/bot.js";

const catalog = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 \u00b7 Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 \u00b7 Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 \u00b7 Most capable" },
];

describe("formatClaudeModelChoice", () => {
  it("names the exact model an alias runs on", () => {
    expect(formatClaudeModelChoice("opus", catalog)).toBe("opus, currently Opus 5.5 (claude-opus-5-5)");
    expect(formatClaudeModelChoice("default", catalog)).toBe("default, currently Opus 5.5 (claude-opus-5-5)");
    expect(formatClaudeModelChoice("fable", catalog)).toBe("fable, currently Fable 5.1 (claude-fable-5-1)");
  });

  it("keeps an exact ID short and adds its version name", () => {
    expect(formatClaudeModelChoice("claude-opus-5-5", catalog)).toBe("claude-opus-5-5 (Opus 5.5)");
    expect(formatClaudeModelChoice("claude-opus-5", catalog)).toBe("claude-opus-5");
  });

  it("says so when an alias cannot be resolved, and stays plain without a catalog", () => {
    expect(formatClaudeModelChoice("best", catalog)).toBe("best (exact version shows after the first reply)");
    expect(formatClaudeModelChoice("opus", undefined)).toBe("opus");
  });

  it("resolves the ID used to spot a model that answered differently", () => {
    expect(resolveClaudeModelId("opus", catalog)).toBe("claude-opus-5-5");
    expect(resolveClaudeModelId("best", catalog)).toBeUndefined();
  });
});
