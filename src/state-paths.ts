import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";

export const TELECODE_STATE_DIRECTORY = ".telecode";
export const LEGACY_TELECODE_STATE_DIRECTORY = ".telecodex";

export type StateMigrationResult =
  | "not-needed"
  | "migrated"
  | "legacy-alias"
  | "legacy-left-because-new-exists";

export function teleCodeStateDirectory(workspace: string): string {
  return path.join(workspace, TELECODE_STATE_DIRECTORY);
}

export function migrateLegacyStateDirectory(workspace: string): StateMigrationResult {
  const legacyPath = path.join(workspace, LEGACY_TELECODE_STATE_DIRECTORY);
  const currentPath = teleCodeStateDirectory(workspace);
  if (!existsSync(legacyPath)) {
    return "not-needed";
  }
  if (existsSync(currentPath)) {
    if (realpathSync(legacyPath) === realpathSync(currentPath)) {
      return "legacy-alias";
    }
    return "legacy-left-because-new-exists";
  }
  renameSync(legacyPath, currentPath);
  return "migrated";
}

export function migrateLegacyClaudeConfigDirectory(homeDirectory: string): StateMigrationResult {
  const legacyPath = path.join(homeDirectory, LEGACY_TELECODE_STATE_DIRECTORY, "claude-config");
  const currentParent = path.join(homeDirectory, TELECODE_STATE_DIRECTORY);
  const currentPath = path.join(currentParent, "claude-config");
  if (!existsSync(legacyPath)) {
    return "not-needed";
  }
  if (existsSync(currentPath)) {
    return "legacy-left-because-new-exists";
  }
  mkdirSync(currentParent, { recursive: true });
  renameSync(legacyPath, currentPath);
  return "migrated";
}
