import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

type RateLimitWindow = {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
  observed_at?: string;
};

type CreditsInfo = unknown;

type RateLimitResetCredit = {
  status?: string;
  expiresAt?: number;
  title?: string;
};

export type CodexUsageSnapshot = {
  sessionFile: string;
  timestamp?: string;
  totalTokenUsage?: TokenUsage;
  lastTokenUsage?: TokenUsage;
  modelContextWindow?: number;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  lastKnownFiveHour?: RateLimitWindow;
  planType?: string;
  credits?: CreditsInfo;
  availableResetCredits?: number;
  resetCredits?: RateLimitResetCredit[];
  rateLimitsSource?: "live-app-server" | "cached-session";
};

export function mergeLiveAppServerRateLimits(
  snapshot: CodexUsageSnapshot | null,
  response: unknown,
): CodexUsageSnapshot | null {
  const root = asRecord(response);
  const limits = asRecord(root?.rateLimits);
  if (!limits) {
    return snapshot;
  }

  const resetCredits = asRecord(root?.rateLimitResetCredits);
  const credits = Array.isArray(resetCredits?.credits)
    ? resetCredits.credits.map((credit) => asRecord(credit) ?? {})
    : [];
  const availableCount = asNumber(resetCredits?.availableCount)
    ?? credits.filter((credit) => credit.status === "available").length;

  return {
    sessionFile: snapshot?.sessionFile ?? "app-server",
    timestamp: new Date().toISOString(),
    totalTokenUsage: snapshot?.totalTokenUsage,
    lastTokenUsage: snapshot?.lastTokenUsage,
    modelContextWindow: snapshot?.modelContextWindow,
    primary: normalizeLiveWindow(limits.primary),
    secondary: normalizeLiveWindow(limits.secondary),
    lastKnownFiveHour: snapshot?.lastKnownFiveHour,
    planType: asString(limits.planType),
    credits: limits.credits,
    availableResetCredits: availableCount,
    resetCredits: credits.map((credit) => ({
      status: asString(credit.status),
      expiresAt: asNumber(credit.expiresAt),
      title: asString(credit.title),
    })),
    rateLimitsSource: "live-app-server",
  };
}

export async function readLatestCodexUsage(): Promise<CodexUsageSnapshot | null> {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await listJsonlFiles(sessionsDir);

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files) {
    const snapshot = await readLatestUsageFromFile(file.path);
    if (snapshot) {
      snapshot.lastKnownFiveHour = await findLatestWindowByDuration(files, 300);
      return snapshot;
    }
  }

  return null;
}

export function renderUsagePlain(snapshot: CodexUsageSnapshot | null): string {
  if (!snapshot) {
    return "Usage is not available yet. Run one Codex prompt first, then try /usage again.";
  }

  const lines = ["Codex usage:"];
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow => Boolean(window));
  const fiveHour = windows.find((window) => window.window_minutes === 300);
  const weekly = windows.find((window) => window.window_minutes === 7 * 24 * 60);
  if (fiveHour) {
    lines.push(formatLimitLine("5-hour limit", fiveHour));
  } else if (snapshot.rateLimitsSource === "live-app-server") {
    lines.push("5-hour limit: unavailable, OpenAI omitted this window from the live response");
    if (snapshot.lastKnownFiveHour) {
      lines.push(formatLimitLine("Last 5-hour report (stale)", snapshot.lastKnownFiveHour, true));
    }
  } else {
    lines.push("5-hour limit: not reported");
  }
  lines.push(weekly
    ? formatLimitLine("Weekly limit", weekly)
    : "Weekly limit: not reported");
  for (const window of windows) {
    if (window !== fiveHour && window !== weekly) {
      lines.push(formatLimitLine(formatWindowLabel(window.window_minutes), window));
    }
  }

  if (snapshot.planType) {
    lines.push(`Plan: ${snapshot.planType}`);
  }

  lines.push(`Purchased credits: ${formatCredits(snapshot.credits)}`);
  if (typeof snapshot.availableResetCredits === "number") {
    lines.push(`Full limit resets available: ${snapshot.availableResetCredits}`);
  }
  if (snapshot.rateLimitsSource === "live-app-server") {
    lines.push("Source: a fresh OpenAI account/rateLimits/read request.");
    if (!fiveHour && snapshot.lastKnownFiveHour) {
      lines.push("Warning: OpenAI's live response is incomplete. This account reported and enforced a 5-hour window recently, but that window is currently missing.");
    }
  }

  const contextLine = formatContextLine(snapshot.lastTokenUsage, snapshot.modelContextWindow);
  if (contextLine) {
    lines.push("");
    lines.push(contextLine);
  }

  if (snapshot.timestamp) {
    const source = snapshot.rateLimitsSource === "live-app-server" ? "live app-server" : "cached session log";
    lines.push(`Updated: ${formatTimestamp(snapshot.timestamp)} (${source})`);
  }

  return lines.join("\n");
}

async function listJsonlFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const info = await stat(entryPath);
      files.push({ path: entryPath, mtimeMs: info.mtimeMs });
    }
  }

  return files;
}

async function readLatestUsageFromFile(filePath: string): Promise<CodexUsageSnapshot | null> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.trimEnd().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.includes('"token_count"')) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const payload = event?.payload;
      if (payload?.type !== "token_count") {
        continue;
      }

      return {
        sessionFile: filePath,
        timestamp: event.timestamp,
        totalTokenUsage: payload.info?.total_token_usage,
        lastTokenUsage: payload.info?.last_token_usage,
        modelContextWindow: payload.info?.model_context_window,
        primary: payload.rate_limits?.primary,
        secondary: payload.rate_limits?.secondary,
        planType: payload.rate_limits?.plan_type,
        credits: payload.rate_limits?.credits,
        rateLimitsSource: "cached-session",
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function findLatestWindowByDuration(
  files: Array<{ path: string }>,
  windowMinutes: number,
): Promise<RateLimitWindow | undefined> {
  for (const file of files) {
    let contents: string;
    try {
      contents = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    const lines = contents.trimEnd().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.includes('"token_count"')) {
        continue;
      }
      try {
        const event = JSON.parse(line);
        const payload = event?.payload;
        if (payload?.type !== "token_count") {
          continue;
        }
        for (const window of [payload.rate_limits?.primary, payload.rate_limits?.secondary]) {
          if (window?.window_minutes === windowMinutes) {
            return { ...window, observed_at: event.timestamp };
          }
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function formatLimitLine(label: string, window: RateLimitWindow, includeObservedAt = false): string {
  const percent = typeof window.used_percent === "number"
    ? `${window.used_percent.toFixed(1)}% used`
    : "percentage not reported";
  const reset = typeof window.resets_at === "number"
    ? `resets ${formatEpochSeconds(window.resets_at)}`
    : "reset time not reported";
  const observed = includeObservedAt && window.observed_at
    ? `, observed ${formatTimestamp(window.observed_at)}`
    : "";
  return `${label}: ${percent}, ${reset}${observed}`;
}

function formatContextLine(lastUsage?: TokenUsage, contextWindow?: number): string | null {
  if (!lastUsage?.total_tokens || !contextWindow) {
    return null;
  }

  const percent = (lastUsage.total_tokens / contextWindow) * 100;
  return `Context last turn: ${formatNumber(lastUsage.total_tokens)} / ${formatNumber(contextWindow)} tokens (${percent.toFixed(1)}%)`;
}

function formatCredits(credits: CreditsInfo): string {
  if (credits === null || credits === undefined) {
    return "not reported";
  }

  if (typeof credits === "string" || typeof credits === "number" || typeof credits === "boolean") {
    return String(credits);
  }

  const record = asRecord(credits);
  if (record) {
    if (record.unlimited === true) {
      return "unlimited";
    }
    const balance = asString(record.balance);
    if (balance !== undefined) {
      return balance === "0" ? "none" : balance;
    }
    if (record.hasCredits === false || record.has_credits === false) {
      return "none";
    }
  }

  try {
    return JSON.stringify(credits);
  } catch {
    return "reported, but could not format";
  }
}

function formatEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatWindowLabel(minutes?: number): string {
  return minutes === undefined
    ? "Unspecified window"
    : `${formatWindowDuration(minutes)} window`;
}

function formatWindowDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function normalizeLiveWindow(value: unknown): RateLimitWindow | undefined {
  const window = asRecord(value);
  if (!window) {
    return undefined;
  }
  return {
    used_percent: asNumber(window.usedPercent),
    window_minutes: asNumber(window.windowDurationMins),
    resets_at: asNumber(window.resetsAt),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
