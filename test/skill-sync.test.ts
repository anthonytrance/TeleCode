import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { syncClaudeSkillsIntoCodexHome } from "../src/skill-sync.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("links new Claude skills and preserves existing Codex skills", () => {
  const root = mkdtempSync(join(tmpdir(), "telecode-skills-"));
  temporaryDirectories.push(root);
  const claudeSkillsDir = join(root, ".claude", "skills");
  const codexSkillsDir = join(root, ".codex", "skills");
  mkdirSync(join(claudeSkillsDir, "flights"), { recursive: true });
  mkdirSync(join(claudeSkillsDir, "existing"), { recursive: true });
  mkdirSync(join(claudeSkillsDir, "unfinished"), { recursive: true });
  mkdirSync(join(codexSkillsDir, "existing"), { recursive: true });
  writeFileSync(join(claudeSkillsDir, "flights", "SKILL.md"), "---\nname: flights\n---\n");
  writeFileSync(join(claudeSkillsDir, "existing", "SKILL.md"), "Claude version");
  writeFileSync(join(codexSkillsDir, "existing", "SKILL.md"), "Codex version");

  expect(syncClaudeSkillsIntoCodexHome({ claudeSkillsDir, codexSkillsDir })).toEqual(["flights"]);
  expect(realpathSync(join(codexSkillsDir, "flights"))).toBe(realpathSync(join(claudeSkillsDir, "flights")));
  expect(readFileSync(join(codexSkillsDir, "existing", "SKILL.md"), "utf8")).toBe("Codex version");
  expect(syncClaudeSkillsIntoCodexHome({ claudeSkillsDir, codexSkillsDir })).toEqual([]);
});
