import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  migrateLegacyClaudeConfigDirectory,
  migrateLegacyStateDirectory,
  teleCodeStateDirectory,
} from "../src/state-paths.js";

describe("TeleCode state paths", () => {
  it("migrates a legacy workspace state directory", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecode-state-"));
    const legacy = path.join(workspace, ".telecodex");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "contexts.json"), "{}", "utf8");

    expect(migrateLegacyStateDirectory(workspace)).toBe("migrated");
    expect(teleCodeStateDirectory(workspace)).toBe(path.join(workspace, ".telecode"));
    expect(readFileSync(path.join(workspace, ".telecode", "contexts.json"), "utf8")).toBe("{}");
  });

  it("does not overwrite a canonical state directory", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecode-state-"));
    mkdirSync(path.join(workspace, ".telecodex"));
    mkdirSync(path.join(workspace, ".telecode"));

    expect(migrateLegacyStateDirectory(workspace)).toBe("legacy-left-because-new-exists");
  });

  it("migrates the isolated Claude config without moving unrelated legacy files", () => {
    const home = mkdtempSync(path.join(tmpdir(), "telecode-home-"));
    const legacyRoot = path.join(home, ".telecodex");
    mkdirSync(path.join(legacyRoot, "claude-config"), { recursive: true });
    writeFileSync(path.join(legacyRoot, "keep.json"), "{}", "utf8");
    writeFileSync(path.join(legacyRoot, "claude-config", "settings.json"), "{}", "utf8");

    expect(migrateLegacyClaudeConfigDirectory(home)).toBe("migrated");
    expect(readFileSync(path.join(home, ".telecode", "claude-config", "settings.json"), "utf8")).toBe("{}");
    expect(readFileSync(path.join(legacyRoot, "keep.json"), "utf8")).toBe("{}");
  });
});
