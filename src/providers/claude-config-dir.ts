import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Ensure an isolated CLAUDE_CONFIG_DIR exists for TeleCodex-spawned claude.exe.
 *
 * The child must still authenticate on Anthony's normal Claude subscription, so we
 * seed the isolated dir with a copy of the live OAuth credentials. We deliberately do
 * NOT copy plugins/ or installed_plugins.json, so the user-scoped telegram plugin is
 * absent in the child and cannot start a competing getUpdates poller — that poller is
 * what 409s the live Telegram bridge offline when two claude.exe instances share the
 * real ~/.claude config dir.
 */
export function ensureClaudeConfigDir(
  configDir: string,
  sourceConfigDir: string = path.join(homedir(), ".claude"),
): void {
  mkdirSync(configDir, { recursive: true });
  syncCredentials(configDir, sourceConfigDir);
}

function syncCredentials(configDir: string, sourceConfigDir: string): void {
  const source = path.join(sourceConfigDir, ".credentials.json");
  if (!existsSync(source)) {
    return;
  }
  const dest = path.join(configDir, ".credentials.json");
  // Copy when the isolated dir has no creds yet, or when the canonical creds are
  // fresher than the copy (the live session refreshes its OAuth token periodically).
  if (destIsAtLeastAsFresh(source, dest)) {
    return;
  }
  copyFileSync(source, dest);
}

function destIsAtLeastAsFresh(source: string, dest: string): boolean {
  if (!existsSync(dest)) {
    return false;
  }
  try {
    return statSync(dest).mtimeMs >= statSync(source).mtimeMs;
  } catch {
    return false;
  }
}
