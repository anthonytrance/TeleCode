export type ClaudeCommandClass =
  | "dispatch"
  | "dispatch_arg"
  | "emulate"
  | "surface"
  | "na"
  | "block";

export interface ClaudeCommandSpec {
  name: string;
  aliases?: string[];
  class: ClaudeCommandClass;
  description: string;
  requiresArgument?: boolean;
  notes?: string;
}

const CLAUDE_COMMAND_SPECS = [
  spec("compact", "dispatch", "Ask Claude Code to compact the current session."),
  spec("context", "surface", "Show context usage known to TeleCode."),
  spec("memory", "dispatch", "Open Claude Code memory workflow."),
  spec("init", "dispatch", "Ask Claude Code to initialize project guidance."),
  spec("add-dir", "dispatch", "Add a working directory to Claude Code."),
  spec("cd", "dispatch_arg", "Change Claude Code working directory.", { requiresArgument: true }),
  spec("diff", "dispatch", "Ask Claude Code for the current diff."),
  spec("pr-comments", "dispatch", "Ask Claude Code to review PR comments."),
  spec("recap", "dispatch", "Ask Claude Code for a recap."),
  spec("btw", "dispatch", "Pass the command to Claude Code."),
  spec("goal", "dispatch", "Use Claude Code goal workflow."),
  spec("plan", "dispatch", "Use Claude Code planning workflow."),
  spec("sandbox", "dispatch", "Use Claude Code sandbox workflow."),
  spec("hooks", "dispatch", "Use Claude Code hooks workflow."),
  spec("code-review", "dispatch", "Run Claude Code review workflow."),
  spec("review", "dispatch", "Run Claude Code review workflow."),
  spec("security-review", "dispatch", "Run Claude Code security review workflow."),
  spec("simplify", "dispatch", "Run Claude Code simplification workflow."),
  spec("batch", "dispatch", "Run Claude Code batch workflow."),
  spec("loop", "dispatch", "Run Claude Code loop workflow."),
  spec("run", "dispatch", "Run Claude Code workflow."),
  spec("verify", "dispatch", "Run Claude Code verification workflow."),
  spec("run-skill-generator", "dispatch", "Run Claude Code skill generator."),
  spec("deep-research", "dispatch", "Run Claude Code deep research workflow."),
  spec("claude-api", "dispatch", "Run Claude Code Claude API workflow."),
  spec("ultraplan", "dispatch", "Run Claude Code ultraplan workflow."),
  spec("ultrareview", "dispatch", "Run Claude Code ultrareview workflow."),
  spec("workflows", "dispatch", "List or run Claude Code workflows."),
  spec("powerup", "dispatch", "Run Claude Code powerup workflow."),
  spec("team-onboarding", "dispatch", "Run Claude Code team onboarding workflow."),
  spec("fewer-permission-prompts", "dispatch", "Run Claude Code permissions workflow."),
  spec("release-notes", "dispatch", "Run Claude Code release notes workflow."),
  spec("tasks", "dispatch", "Run Claude Code tasks workflow."),
  spec("stop", "emulate", "Abort the active Claude turn.", { aliases: ["abort"] }),
  spec("passes", "dispatch", "Run Claude Code passes workflow."),
  spec("insights", "dispatch", "Run Claude Code insights workflow."),
  spec("focus", "dispatch", "Run Claude Code focus workflow."),

  spec("model", "dispatch_arg", "Set Claude Code model when an argument is provided."),
  spec("effort", "dispatch_arg", "Set Claude Code effort when an argument is provided."),
  spec("advisor", "dispatch_arg", "Set Claude Code advisor when an argument is provided."),
  spec("permissions", "dispatch_arg", "Set Claude Code permissions when an argument is provided."),
  spec("config", "dispatch_arg", "Set Claude Code config when an argument is provided."),
  spec("agents", "dispatch_arg", "Use Claude Code agents command when an argument is provided."),
  spec("mcp", "dispatch_arg", "Use Claude Code MCP command when an argument is provided."),
  spec("plugin", "dispatch_arg", "Use Claude Code plugin command when an argument is provided."),
  spec("keybindings", "dispatch_arg", "Set Claude Code keybindings when an argument is provided.", {
    requiresArgument: true,
  }),
  spec("statusline", "dispatch_arg", "Set Claude Code statusline when an argument is provided.", {
    requiresArgument: true,
  }),
  spec("theme", "dispatch_arg", "Set Claude Code theme when an argument is provided.", { requiresArgument: true }),

  spec("clear", "emulate", "Forget the current TeleCode Claude session."),
  spec("resume", "emulate", "Resume or switch Claude sessions through TeleCode."),
  spec("branch", "emulate", "Branch a Claude session through TeleCode."),
  spec("fork", "emulate", "Fork a Claude session through TeleCode."),
  spec("rename", "emulate", "Rename a Claude session through TeleCode."),
  spec("export", "emulate", "Export Claude session information through TeleCode."),
  spec("copy", "emulate", "Re-send the last assistant message."),
  spec("rewind", "emulate", "Rewind through TeleCode when supported."),
  spec("background", "emulate", "Move a session to the background.", { aliases: ["bg"] }),
  spec("exit", "emulate", "Dispose the current Claude process."),

  spec("cost", "surface", "Show Claude usage known to TeleCode."),
  spec("status", "surface", "Show current Claude session status."),
  spec("stats", "surface", "Show Claude usage known to TeleCode."),
  spec("session", "surface", "Show current Claude session status."),
  spec("doctor", "surface", "Show local Claude provider diagnostics."),
  spec("debug", "surface", "Show local Claude provider diagnostics."),
  spec("heapdump", "surface", "Report that heapdump is not available over Telegram."),
  spec("usage", "surface", "Show Claude usage known to TeleCode."),

  spec("color", "na", "Terminal color settings do not apply over Telegram."),
  spec("vim", "na", "Terminal editor mode does not apply over Telegram."),
  spec("scroll-speed", "na", "Terminal scroll speed does not apply over Telegram."),
  spec("ide", "na", "IDE integration does not apply over Telegram."),
  spec("terminal-setup", "na", "Terminal setup does not apply over Telegram."),
  spec("tui", "na", "Terminal UI controls do not apply over Telegram."),
  spec("desktop", "na", "Desktop app setup does not apply over Telegram."),
  spec("mobile", "na", "Mobile app setup does not apply over Telegram."),
  spec("chrome", "na", "Chrome setup does not apply over Telegram."),
  spec("voice", "na", "Claude Code voice controls do not apply over Telegram."),
  spec("radio", "na", "Claude Code radio controls do not apply over Telegram."),
  spec("stickers", "na", "Sticker controls do not apply over Telegram."),
  spec("remote-control", "na", "Remote control setup does not apply over Telegram."),
  spec("remote-env", "na", "Remote environment setup does not apply over Telegram."),
  spec("teleport", "na", "Teleport setup does not apply over Telegram."),
  spec("web-setup", "na", "Web setup does not apply over Telegram."),
  spec("setup-bedrock", "na", "Bedrock setup is not managed from Telegram."),
  spec("setup-vertex", "na", "Vertex setup is not managed from Telegram."),
  spec("reload-plugins", "na", "Reloading host plugins is not managed from Telegram."),
  spec("reload-skills", "na", "Reloading host skills is not managed from Telegram."),
  spec("reload-*", "na", "Reloading host resources is not managed from Telegram."),
  spec("fast", "na", "Host speed toggles do not apply over Telegram."),

  spec("login", "block", "Claude authentication changes are blocked from Telegram."),
  spec("logout", "block", "Claude authentication changes are blocked from Telegram."),
  spec("upgrade", "block", "Subscription changes are blocked from Telegram."),
  spec("usage-credits", "block", "Usage credit changes are blocked from Telegram."),
  spec("feedback", "block", "Feedback would send data externally and needs a dedicated confirmation flow."),
  spec("autofix-pr", "block", "Autofix PR can spawn external cloud work and needs a dedicated confirmation flow."),
  spec("install-github-app", "block", "Installing external apps is blocked from Telegram."),
  spec("install-slack-app", "block", "Installing external apps is blocked from Telegram."),
  spec("privacy-settings", "block", "Privacy settings are blocked from Telegram."),
] as const satisfies readonly ClaudeCommandSpec[];

export const CLAUDE_COMMANDS: readonly ClaudeCommandSpec[] = CLAUDE_COMMAND_SPECS;

export const CLAUDE_COMMAND_BY_NAME: ReadonlyMap<string, ClaudeCommandSpec> = new Map(
  CLAUDE_COMMANDS.flatMap((command) => [
    [normalizeClaudeCommandName(command.name), command] as const,
    ...(command.aliases ?? []).map((alias) => [normalizeClaudeCommandName(alias), command] as const),
  ]),
);

export function parseClaudeSlashCommand(text: string): { name: string; argument: string } | undefined {
  const match = text.trim().match(/^\/([a-zA-Z0-9_*.-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return undefined;
  }

  return {
    name: normalizeClaudeCommandName(match[1] ?? ""),
    argument: (match[2] ?? "").trim(),
  };
}

export function getClaudeCommandSpec(name: string): ClaudeCommandSpec | undefined {
  return CLAUDE_COMMAND_BY_NAME.get(normalizeClaudeCommandName(name));
}

export function classifyClaudeSlashCommand(text: string): {
  parsed: { name: string; argument: string };
  spec?: ClaudeCommandSpec;
} | undefined {
  const parsed = parseClaudeSlashCommand(text);
  if (!parsed) {
    return undefined;
  }

  return {
    parsed,
    spec: getClaudeCommandSpec(parsed.name),
  };
}

function normalizeClaudeCommandName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

function spec(
  name: string,
  commandClass: ClaudeCommandClass,
  description: string,
  options: Omit<ClaudeCommandSpec, "name" | "class" | "description"> = {},
): ClaudeCommandSpec {
  return {
    name,
    class: commandClass,
    description,
    ...options,
  };
}
