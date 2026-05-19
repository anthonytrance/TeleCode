import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start in current workspace"],
        ["/new default", "Start in configured workspace"],
        ["/new <workspace>", "Start in another workspace"],
        ["/workspaces", "Choose workspace for new thread"],
        ["/fork", "Start in current workspace"],
        ["/newsummary", "New thread from summary"],
        ["/newsummary default", "Summarize into configured workspace"],
        ["/forkthread [n]", "Fork app-server thread, optionally roll back fork"],
        ["/renamethread <name>", "Rename active app-server thread"],
        ["/rollbackthread <n>", "Roll back app-server thread history"],
        ["/session", "Current thread details"],
        ["/status", "Alias for /session"],
        ["/usage", "Codex limits & reset times"],
        ["/backend", "Show or switch backend"],
        ["/backend appserver", "Switch to app-server backend"],
        ["/backend sdk", "Switch back to SDK backend"],
        ["/verbosity <mode>", "Set progress delivery"],
        ["/appserver", "Probe Codex app-server"],
        ["/appserverturn <prompt>", "Run isolated app-server turn"],
        ["/appserversteer a || b", "Steer isolated app-server turn"],
        ["/appbackendtest", "Smoke-test app-server backend"],
        ["/artifacttest", "Send a generated test file"],
        ["/sessions", "Browse & switch threads"],
        ["/use <number>", "Switch after /sessions"],
        ["/use previous", "Switch to previous thread"],
        ["/use latest", "Switch to latest thread"],
        ["/history", "Show recent local thread history"],
        ["/attach", "Bind a Codex thread to this topic"],
        ["/handback", "Hand thread back to Codex CLI"],
        ["/abort", "Cancel current operation"],
        ["/stop", "Alias for /abort"],
        ["/steer <text>", "Steer active app-server turn"],
        ["/retry", "Resend the last prompt"],
        ["/clear", "Forget this Telegram context"],
        ["/copy", "Re-send last assistant reply"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/launch_profiles", "Select launch profile"],
        ["/launch_profiles <id>", "Set launch profile"],
        ["/model", "View & change model"],
        ["/model <slug>", "Set model, e.g. 5.5"],
        ["/effort", "Set reasoning effort"],
        ["/effort <level>", "Set effort"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/help", "This reference"],
        ["/voice", "Voice transcription status"],
      ],
    },
    {
      title: "Codex CLI",
      commands: [
        ["/compact", "Compact the active Codex thread"],
        ["/agents", "Forward to Codex"],
        ["/diff", "Forward to Codex"],
        ["/doctor", "Forward to Codex"],
        ["/prompts", "Forward to Codex"],
        ["/memory", "Forward to Codex"],
        ["/mentions", "Forward to Codex"],
        ["/init", "Forward to Codex"],
        ["/bug", "Forward to Codex"],
        ["/config", "Forward to Codex"],
        ["/limits", "Forward to Codex"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCodex is ready.</b>",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];
  const plainLines = [
    "👋 TeleCodex is ready.",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex (topic session)" : "TeleCodex";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(unknown)";
  const title = trimLabel(cleanSessionTitle(options.title) || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

export function cleanSessionTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  const outputFilesPrefix =
    /^Output files:\s*write any files the user should receive to\s+.*?[\\/]out\b\s*/i;
  return normalized.replace(outputFilesPrefix, "").trim();
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
