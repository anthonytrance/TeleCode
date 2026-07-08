import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

const RETENTION_DAYS = 7;

let logDir: string | undefined;

/**
 * Append-only operational log for the bridge (D6: kills, queueing, dispatch, and echo
 * events previously left no trace). One file per day under
 * `<workspace>/.telecodex/logs/bridge-YYYYMMDD.log`, plain `ISO | area | message` lines.
 * Never throws: logging must not take the bridge down.
 */
export function initBridgeLog(workspace: string): void {
  try {
    logDir = path.join(workspace, ".telecodex", "logs");
    mkdirSync(logDir, { recursive: true });
    pruneOldLogs(logDir);
  } catch {
    logDir = undefined;
  }
}

export function bridgeLog(area: string, message: string): void {
  if (!logDir) {
    return;
  }
  try {
    const now = new Date();
    const file = path.join(logDir, `bridge-${dayStamp(now)}.log`);
    const line = `${now.toISOString()} | ${area} | ${message.replace(/\r?\n/g, "\\n")}\n`;
    appendFileSync(file, line, "utf8");
  } catch {
    // Logging must never break message handling.
  }
}

function dayStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function pruneOldLogs(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStamp = dayStamp(cutoff);
  for (const name of readdirSync(dir)) {
    const match = name.match(/^bridge-(\d{8})\.log$/);
    if (match && match[1] < cutoffStamp) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // Best effort; a locked file will be retried next boot.
      }
    }
  }
}
