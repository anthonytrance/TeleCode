import { describe, expect, it } from "vitest";

import {
  addRequiredNativeReasoningEfforts,
  LEGACY_CODEX_REASONING_EFFORTS,
} from "../src/reasoning-effort.js";

describe("native reasoning effort fallbacks", () => {
  it("removes unsupported minimal and retains max for GPT-6.1 Sol", () => {
    expect(addRequiredNativeReasoningEfforts("gpt-6.1-sol", LEGACY_CODEX_REASONING_EFFORTS)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps max available for Sol when a vendor catalog displaced the native cache", () => {
    expect(addRequiredNativeReasoningEfforts("gpt-5.6-sol", LEGACY_CODEX_REASONING_EFFORTS)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("repairs a stale Sol catalog entry that omits max", () => {
    expect(addRequiredNativeReasoningEfforts("gpt-5.6-sol", ["low", "medium", "high", "xhigh"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("does not invent max support for unrelated models", () => {
    expect(addRequiredNativeReasoningEfforts("gpt-5.5", LEGACY_CODEX_REASONING_EFFORTS)).toEqual(
      LEGACY_CODEX_REASONING_EFFORTS,
    );
  });
});
