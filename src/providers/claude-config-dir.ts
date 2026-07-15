import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Ensure an isolated CLAUDE_CONFIG_DIR exists for TeleCode-spawned claude.exe.
 *
 * The child must still authenticate on the user's normal Claude subscription, so we
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
  ensureOnboardingComplete(configDir);
  ensureIsolatedSettings(configDir);
}

/**
 * A fresh CLAUDE_CONFIG_DIR makes claude.exe run its first-run wizard (theme picker,
 * etc.), which never reaches the interactive prompt the PTY waits for. The relocated
 * global state file lives at <configDir>/.claude.json; seeding hasCompletedOnboarding
 * there skips the wizard. We merge into any existing file so we never clobber the
 * machine/user IDs claude writes on boot. We deliberately do NOT copy the real
 * settings.json, because it carries enabledPlugins/channelsEnabled for the telegram
 * plugin — the exact thing this isolation exists to keep out of the child.
 */
function ensureOnboardingComplete(configDir: string): void {
  const file = path.join(configDir, ".claude.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  let changed = false;
  if (data.hasCompletedOnboarding !== true) {
    data.hasCompletedOnboarding = true;
    changed = true;
  }
  if (data.theme === undefined || data.theme === null) {
    data.theme = "dark-ansi";
    changed = true;
  }
  if (changed) {
    writeFileSync(file, JSON.stringify(data, null, 2));
  }
}

function ensureIsolatedSettings(configDir: string): void {
  const file = path.join(configDir, "settings.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }

  const permissions = isObject(data.permissions) ? data.permissions : {};
  data.theme = data.theme ?? "dark-ansi";
  data.channelsEnabled = false;
  data.enabledPlugins = {};
  data.skipDangerousModePermissionPrompt = true;
  data.skipAutoPermissionPrompt = true;
  data.permissions = {
    ...permissions,
    defaultMode: "bypassPermissions",
  };

  writeFileSync(file, JSON.stringify(data, null, 2));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
