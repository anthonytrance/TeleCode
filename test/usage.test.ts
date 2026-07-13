import { describe, expect, it } from "vitest";

import { mergeLiveAppServerRateLimits, renderUsagePlain, type CodexUsageSnapshot } from "../src/usage.js";

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
    expect(text).toContain("Purchased credits: not reported");
    expect(text).toMatch(/Context last turn: 25[,.]000 \/ 250[,.]000 tokens \(10\.0%\)/);
  });

  it("handles missing local usage data", () => {
    expect(renderUsagePlain(null)).toContain("Usage is not available yet");
  });

  it("prefers complete live app-server limits and reports reset credits", () => {
    const snapshot = mergeLiveAppServerRateLimits(null, {
      rateLimits: {
        primary: { usedPercent: 54, windowDurationMins: 300, resetsAt: 1783726110 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1784312910 },
        planType: "plus",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [{ status: "available", expiresAt: 1784335617, title: "Full reset" }],
      },
    });

    const text = renderUsagePlain(snapshot);
    expect(text).toContain("5-hour limit: 54.0% used");
    expect(text).toContain("Weekly limit: 8.0% used");
    expect(text).toContain("Purchased credits: none");
    expect(text).toContain("Full limit resets available: 3");
    expect(text).toContain("live app-server");
    expect(text).toContain("fresh OpenAI account/rateLimits/read request");
  });

  it("flags a live response that drops a recently observed five-hour window", () => {
    const snapshot = mergeLiveAppServerRateLimits({
      sessionFile: "session.jsonl",
      lastKnownFiveHour: {
        used_percent: 100,
        window_minutes: 300,
        resets_at: 1783884960,
        observed_at: "2026-07-12T16:13:04.215Z",
      },
    }, {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1784490848 },
        secondary: null,
        planType: "plus",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1784490848 },
          secondary: null,
        },
      },
      rateLimitResetCredits: { availableCount: 3, credits: [] },
    });

    const text = renderUsagePlain(snapshot);
    expect(text).toContain("5-hour limit: unavailable, OpenAI omitted this window");
    expect(text).toContain("Last 5-hour report (stale): 100.0% used");
    expect(text).toContain("Weekly limit: 19.0% used");
    expect(text).toContain("live response is incomplete");
  });

  it("classifies both provided windows by their reported duration", () => {
    const snapshot: CodexUsageSnapshot = {
      sessionFile: "session.jsonl",
      primary: { used_percent: 12, window_minutes: 10080 },
      secondary: { used_percent: 34, window_minutes: 300 },
    };

    const text = renderUsagePlain(snapshot);
    expect(text).toContain("Weekly limit: 12.0% used");
    expect(text).toContain("5-hour limit: 34.0% used");
  });
});
