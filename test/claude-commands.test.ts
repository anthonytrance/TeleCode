import {
  CLAUDE_COMMANDS,
  classifyClaudeSlashCommand,
  getClaudeCommandSpec,
  parseClaudeSlashCommand,
} from "../src/providers/claude-commands.js";

describe("Claude command registry", () => {
  it("classifies the command groups used by the design", () => {
    expect(getClaudeCommandSpec("compact")).toMatchObject({ class: "dispatch" });
    expect(getClaudeCommandSpec("model")).toMatchObject({ class: "dispatch_arg" });
    expect(getClaudeCommandSpec("clear")).toMatchObject({ class: "emulate" });
    expect(getClaudeCommandSpec("usage")).toMatchObject({ class: "surface" });
    expect(getClaudeCommandSpec("theme")).toMatchObject({ class: "dispatch_arg" });
    expect(getClaudeCommandSpec("terminal-setup")).toMatchObject({ class: "na" });
    expect(getClaudeCommandSpec("usage-credits")).toMatchObject({ class: "block" });
  });

  it("normalizes aliases and underscore variants", () => {
    expect(getClaudeCommandSpec("abort")).toMatchObject({ name: "stop", class: "emulate" });
    expect(getClaudeCommandSpec("bg")).toMatchObject({ name: "background", class: "emulate" });
    expect(getClaudeCommandSpec("terminal_setup")).toMatchObject({ name: "terminal-setup", class: "na" });
  });

  it("parses slash command names and arguments", () => {
    expect(parseClaudeSlashCommand("/model sonnet")).toEqual({
      name: "model",
      argument: "sonnet",
    });
    expect(parseClaudeSlashCommand("/add-dir@TeleCodeBot C:\\Users\\Anthony\\codetest")).toEqual({
      name: "add-dir",
      argument: "C:\\Users\\Anthony\\codetest",
    });
  });

  it("returns unknown commands without pretending they are classified", () => {
    expect(classifyClaudeSlashCommand("/unknown thing")).toEqual({
      parsed: { name: "unknown", argument: "thing" },
      spec: undefined,
    });
  });

  it("keeps command and alias names unique", () => {
    const names = new Set<string>();
    for (const command of CLAUDE_COMMANDS) {
      const keys = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase().replace(/_/g, "-"));
      for (const key of keys) {
        expect(names.has(key)).toBe(false);
        names.add(key);
      }
    }
  });

  it("tracks broad Claude Code command coverage", () => {
    expect(CLAUDE_COMMANDS.length).toBeGreaterThanOrEqual(90);
  });
});
