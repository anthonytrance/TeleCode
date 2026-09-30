import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillSyncPaths {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
}

/** Make local Claude skills available to Codex without copying their contents. */
export function syncClaudeSkillsIntoCodexHome(paths: SkillSyncPaths = {}): string[] {
  const claudeSkillsDir = paths.claudeSkillsDir ?? join(homedir(), ".claude", "skills");
  const codexSkillsDir = paths.codexSkillsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills");
  if (!existsSync(claudeSkillsDir)) return [];

  mkdirSync(codexSkillsDir, { recursive: true });
  const linked: string[] = [];
  for (const entry of readdirSync(claudeSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = join(claudeSkillsDir, entry.name);
    const manifest = join(source, "SKILL.md");
    if (!existsSync(manifest) || !statSync(manifest).isFile()) continue;

    const destination = join(codexSkillsDir, entry.name);
    if (existsSync(join(codexSkillsDir, ".system", entry.name))) continue;
    try {
      lstatSync(destination);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
      linked.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return linked;
}
