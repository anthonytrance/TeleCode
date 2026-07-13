import { describe, expect, it } from "vitest";

import {
  cleanSessionTitle,
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains all command groups", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Session");
      expect(html).toContain("Model");
      expect(html).toContain("Auth");
      expect(html).toContain("Utility");
      expect(plain).toContain("/new");
      expect(plain).toContain("/help");
      expect(plain).toContain("/retry");
      expect(plain).toContain("/goal");
      expect(plain).toContain("/goal <task>");
      expect(plain).toContain("/goal pause");
      expect(plain).toContain("/goal resume");
      expect(plain).toContain("/goal clear");
      expect(plain).toContain("/goal no-agents <task>");
      expect(plain).toContain("/children");
      expect(plain).toContain("/follow latest");
      expect(plain).toContain("/parent");
      expect(plain).toContain("/launch_profiles");
    });

    it("lists the expanded command surface", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/\/\w+/g) ?? [];
      expect(commandMatches.length).toBeGreaterThanOrEqual(30);
      expect(plain).toContain("/compact");
      expect(plain).toContain("/history");
      expect(plain).toContain("/clear");
      expect(plain).toContain("/last");
      expect(plain).toContain("/copy");
      expect(plain).toContain("/repeat");
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("TeleCode is ready");
      expect(plain).toContain("/help");
      expect(html).not.toContain("⚠️");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("⚠️");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>Thread:</b> abc123",
        "Thread: abc123",
        false,
      );
      expect(html).toContain("TeleCode");
      expect(html).toContain("abc123");
      expect(plain).toContain("abc123");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("topic session");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("⚠️");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("strips TeleCode output-file preamble from session labels", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title:
          "Output files: write any files the user should receive to C:\\Users\\Anthony\\.telecode\\turns\\abc\\out\n\nI would like you to help me install Hermes agent",
        relativeTime: "1m ago",
        isActive: false,
      });
      expect(label).toContain("I would like you");
      expect(label).not.toContain("Output files");
    });

    it("formats basic session label", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("📁");
      expect(label).toContain("my-project");
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
    });

    it("shows checkmark for active session", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("✅");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("appends short thread id when available", () => {
      const label = formatSessionLabel({
        id: "019e4123456789",
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        isActive: false,
      });
      expect(label).toContain("#019e4123");
    });

    it("truncates long workspace names to 12 chars", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("my-very-lon…");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(untitled)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label).toContain("very-long…");
    });
  });

  describe("cleanSessionTitle", () => {
    it("keeps ordinary titles unchanged", () => {
      expect(cleanSessionTitle("Install Hermes agent")).toBe("Install Hermes agent");
    });

    it("removes output-file preamble", () => {
      expect(
        cleanSessionTitle(
          "Output files: write any files the user should receive to C:\\Users\\Anthony\\.telecode\\turns\\x\\out\n\nInstall Hermes agent",
        ),
      ).toBe("Install Hermes agent");
    });

    it("removes new-summary seed text and keeps the actual goal", () => {
      expect(
        cleanSessionTitle(
          [
            "You are continuing from a previous Codex session.",
            "Treat the following handoff summary as the starting context for this new thread.",
            "Do not redo work unless asked. Reply only: Summary loaded.",
            "",
            "Current goal:",
            "Continue TeleCode app-server progress cleanup.",
          ].join("\n"),
        ),
      ).toBe("Continue TeleCode app-server progress cleanup.");
    });
  });
});
