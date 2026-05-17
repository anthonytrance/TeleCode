import { describe, expect, it } from "vitest";

import { renderUsagePlain, type CodexUsageSnapshot } from "../src/usage.js";

describe("usage rendering", () => {
  it("formats primary and secondary OpenAI limits separately", () => {
    const snapshot: CodexUsageSnapshot = {
      sessionFile: "session.jsonl",
      timestamp: "2026-05-16T20:21:13.666Z",
      planType: "plus",
      credits: null,
      lastTokenUsage: { total_tokens: 25000 },
      modelContextWindow: 250000,
      primary: { used_percent: 73, resets_at: 1778975888, window_minutes: 300 },
      secondary: { used_percent: 11, resets_at: 1779562688, window_minutes: 10080 },
    };

    const text = renderUsagePlain(snapshot);

    expect(text).toContain("5-hour limit: 73.0% used");
    expect(text).toContain("Weekly limit: 11.0% used");
    expect(text).toContain("Plan: plus");
    expect(text).toContain("Credits: not reported");
    expect(text).toMatch(/Context last turn: 25[,.]000 \/ 250[,.]000 tokens \(10\.0%\)/);
  });

  it("handles missing local usage data", () => {
    expect(renderUsagePlain(null)).toContain("Usage is not available yet");
  });
});
