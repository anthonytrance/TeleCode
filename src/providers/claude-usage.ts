import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonFileText } from "../json.js";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
  };
}

interface ClaudeUsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: {
    model?: {
      display_name?: string | null;
    } | null;
  } | null;
  is_active?: boolean;
}

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string | null;
}

export interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    currency?: string | null;
  } | null;
  limits?: ClaudeUsageLimit[];
}

export async function fetchClaudeUsageReport(options: {
  configDir: string;
  fetchFn?: typeof fetch;
  now?: Date;
}): Promise<string> {
  const credentialsPath = path.join(options.configDir, ".credentials.json");
  let credentials: ClaudeCredentials;
  try {
    credentials = parseJsonFileText<ClaudeCredentials>(await readFile(credentialsPath, "utf8"));
  } catch {
    throw new Error("Claude credentials could not be read. Run /claude_login and try again.");
  }
  const accessToken = credentials.claudeAiOauth?.accessToken?.trim();
  if (!accessToken) {
    throw new Error("Claude OAuth credentials are missing. Run /claude_login and try again.");
  }

  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Claude usage request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Claude usage authentication expired. Run /claude_login and try again.");
    }
    throw new Error(`Claude usage request failed with HTTP ${response.status}.`);
  }

  const usage = await response.json() as ClaudeUsageResponse;
  return formatClaudeUsageReport(usage, options.now);
}

export function formatClaudeUsageReport(usage: ClaudeUsageResponse, now = new Date()): string {
  const limits = usage.limits ?? [];
  const lines: string[] = [];
  const session = limits.find((limit) => limit.kind === "session") ??
    windowAsLimit("session", usage.five_hour);
  const weekly = limits.find((limit) => limit.kind === "weekly_all") ??
    windowAsLimit("weekly_all", usage.seven_day);
  if (session) {
    lines.push(formatLimit("Current session", session, now));
  }
  if (weekly) {
    lines.push(formatLimit("Current week, all models", weekly, now));
  }

  for (const limit of limits.filter((entry) => entry.kind === "weekly_scoped")) {
    const model = limit.scope?.model?.display_name?.trim() || "Model-specific";
    const active = limit.is_active ? ", active" : "";
    lines.push(formatLimit(`Current week, ${model}${active}`, limit, now));
  }

  const extraUsage = usage.extra_usage;
  if (!extraUsage?.is_enabled) {
    lines.push("Extra usage credits: off.");
  } else {
    const used = formatMoney(extraUsage.used_credits, extraUsage.currency);
    const limit = formatMoney(extraUsage.monthly_limit, extraUsage.currency);
    lines.push(used && limit
      ? `Extra usage credits: ${used} used of ${limit}.`
      : "Extra usage credits: on.");
  }

  return lines.length > 0 ? lines.join("\n") : "Claude returned no usage limits for this account.";
}

function windowAsLimit(kind: string, window: ClaudeUsageWindow | null | undefined): ClaudeUsageLimit | undefined {
  if (!window || typeof window.utilization !== "number") {
    return undefined;
  }
  return { kind, percent: window.utilization, resets_at: window.resets_at };
}

function formatLimit(label: string, limit: ClaudeUsageLimit, now: Date): string {
  const percent = clampPercent(limit.percent);
  const reset = formatReset(limit.resets_at, now);
  return `${label}: ${percent}% used${reset ? `, resets ${reset}` : ""}.`;
}

function clampPercent(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(100, value)));
}

function formatReset(value: string | null | undefined, now: Date): string | undefined {
  if (!value) {
    return undefined;
  }
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) {
    return undefined;
  }
  const sameDate = reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = reset.getFullYear() === tomorrow.getFullYear() &&
    reset.getMonth() === tomorrow.getMonth() &&
    reset.getDate() === tomorrow.getDate();
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(reset);
  if (sameDate) {
    return `today at ${time}`;
  }
  if (isTomorrow) {
    return `tomorrow at ${time}`;
  }
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(reset);
  return date;
}

function formatMoney(value: number | null | undefined, currency: string | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !currency) {
    return undefined;
  }
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value);
}
