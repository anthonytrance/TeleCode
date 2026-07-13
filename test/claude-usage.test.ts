import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchClaudeUsageReport, formatClaudeUsageReport } from "../src/providers/claude-usage.js";

describe("Claude OAuth usage", () => {
  it("formats session, weekly, scoped-model, reset, and credit statistics", () => {
    const report = formatClaudeUsageReport({
      limits: [
        { kind: "session", percent: 0, resets_at: null },
        { kind: "weekly_all", percent: 17, resets_at: "2026-07-14T01:00:00Z" },
        {
          kind: "weekly_scoped",
          percent: 30,
          resets_at: "2026-07-14T01:00:00Z",
          scope: { model: { display_name: "Fable" } },
          is_active: true,
        },
      ],
      extra_usage: { is_enabled: false },
    }, new Date("2026-07-13T18:00:00Z"));

    expect(report).toContain("Current session: 0% used.");
    expect(report).toContain("Current week, all models: 17% used");
    expect(report).toContain("Current week, Fable, active: 30% used");
    expect(report).toContain("Extra usage credits: off.");
  });

  it("reads credentials and returns the authenticated endpoint response without exposing the token", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "telecode-claude-usage-"));
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "secret-token" },
    }), "utf8");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
      return new Response(JSON.stringify({
        five_hour: { utilization: 12, resets_at: null },
        seven_day: { utilization: 34, resets_at: null },
        extra_usage: { is_enabled: false },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    try {
      const report = await fetchClaudeUsageReport({ configDir, fetchFn });
      expect(report).toContain("Current session: 12% used.");
      expect(report).toContain("Current week, all models: 34% used.");
      expect(report).not.toContain("secret-token");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
