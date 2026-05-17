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
};

type CreditsInfo = unknown;

export type CodexUsageSnapshot = {
  sessionFile: string;
  timestamp?: string;
  totalTokenUsage?: TokenUsage;
  lastTokenUsage?: TokenUsage;
  modelContextWindow?: number;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  planType?: string;
  credits?: CreditsInfo;
};

export async function readLatestCodexUsage(): Promise<CodexUsageSnapshot | null> {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await listJsonlFiles(sessionsDir);

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files) {
    const snapshot = await readLatestUsageFromFile(file.path);
    if (snapshot) {
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
  lines.push(formatLimitLine("5-hour limit", snapshot.primary));
  lines.push(formatLimitLine("Weekly limit", snapshot.secondary));

  if (snapshot.planType) {
    lines.push(`Plan: ${snapshot.planType}`);
  }

  lines.push(`Credits: ${formatCredits(snapshot.credits)}`);

  const contextLine = formatContextLine(snapshot.lastTokenUsage, snapshot.modelContextWindow);
  if (contextLine) {
    lines.push("");
    lines.push(contextLine);
  }

  if (snapshot.timestamp) {
    lines.push(`Updated: ${formatTimestamp(snapshot.timestamp)}`);
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
      };
    } catch {
      continue;
    }
  }

  return null;
}

function formatLimitLine(label: string, window?: RateLimitWindow): string {
  if (!window) {
    return `${label}: not reported`;
  }

  const percent = typeof window.used_percent === "number" ? `${window.used_percent.toFixed(1)}% used` : "not reported";
  const reset = typeof window.resets_at === "number" ? `resets ${formatEpochSeconds(window.resets_at)}` : "reset unknown";
  return `${label}: ${percent}, ${reset}`;
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
