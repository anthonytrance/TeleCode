import type { CodexThreadGoal, CodexThreadGoalStatus } from "./codex-session.js";

export type GoalModeCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "set"; objective: string; noAgents: boolean };

export function parseGoalModeArgument(raw: string): GoalModeCommand {
  const normalized = raw.trim();
  if (!normalized || /^(?:status|show)$/i.test(normalized)) {
    return { kind: "status" };
  }

  if (/^pause$/i.test(normalized)) {
    return { kind: "pause" };
  }
  if (/^resume$/i.test(normalized)) {
    return { kind: "resume" };
  }
  if (/^clear$/i.test(normalized)) {
    return { kind: "clear" };
  }

  const noAgentsMatch = normalized.match(/^(?:--no-agents|no-agents|noagents)(?:\s+(.+))?$/i);
  if (noAgentsMatch) {
    return { kind: "set", objective: (noAgentsMatch[1] ?? "").trim(), noAgents: true };
  }

  return { kind: "set", objective: normalized, noAgents: false };
}

export function applyGoalModeConstraints(objective: string, options: { noAgents?: boolean } = {}): string {
  const normalized = objective.trim();
  if (!options.noAgents) {
    return normalized;
  }

  return [
    normalized,
    "",
    "Constraint: do not spawn subagents or child sessions. Work only in the current thread unless the user explicitly changes this.",
  ].join("\n");
}

export function formatThreadGoal(goal: CodexThreadGoal | null): string {
  if (!goal) {
    return "No goal is currently set for this thread.";
  }

  const lines = [
    `Goal ${formatGoalStatus(goal.status)}.`,
    `Objective: ${goal.objective}`,
  ];
  if (goal.timeUsedSeconds > 0) {
    lines.push(`Time: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}.`);
  }
  if (goal.tokenBudget !== null) {
    lines.push(`Tokens: ${formatGoalTokens(goal.tokensUsed)}/${formatGoalTokens(goal.tokenBudget)}.`);
  } else if (goal.tokensUsed > 0) {
    lines.push(`Tokens: ${formatGoalTokens(goal.tokensUsed)}.`);
  }
  lines.push(goalCommandHint(goal.status));
  return lines.join("\n");
}

export function goalCommandHint(status: CodexThreadGoalStatus): string {
  if (status === "active") {
    return "Commands: /goal resume, /goal pause, /goal clear";
  }
  if (status === "complete") {
    return "Commands: /goal clear, /goal <new task>";
  }
  return "Commands: /goal resume, /goal clear";
}

export function formatGoalStatus(status: CodexThreadGoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage limited";
    case "budgetLimited":
      return "limited by budget";
    case "complete":
      return "complete";
    default:
      return String(status);
  }
}

function formatGoalElapsedSeconds(rawSeconds: number): string {
  const seconds = Math.max(0, Math.floor(rawSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  }
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatGoalTokens(tokens: number): string {
  const value = Math.max(0, Math.floor(tokens));
  if (value >= 1_000_000) {
    return `${trimTrailingZeroes(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${trimTrailingZeroes(value / 1_000)}K`;
  }
  return String(value);
}

function trimTrailingZeroes(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
