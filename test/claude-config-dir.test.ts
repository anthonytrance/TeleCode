import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureClaudeConfigDir } from "../src/providers/claude-config-dir.js";

describe("ensureClaudeConfigDir", () => {
  let root: string;
  let source: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "telecodex-cfgdir-"));
    source = path.join(root, "real-claude");
    target = path.join(root, "isolated", "claude-config");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, ".credentials.json"), JSON.stringify({ token: "live" }));
    // The real config dir also has the telegram plugin; it must NOT be carried over.
    mkdirSync(path.join(source, "plugins", "data", "telegram-claude-plugins-official"), { recursive: true });
    writeFileSync(path.join(source, "installed_plugins.json"), "{}");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the isolated dir and seeds credentials", () => {
    ensureClaudeConfigDir(target, source);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(path.join(target, ".credentials.json"), "utf8")).toContain("live");
  });

  it("does not copy the telegram plugin into the isolated dir", () => {
    ensureClaudeConfigDir(target, source);
    expect(existsSync(path.join(target, "plugins"))).toBe(false);
    expect(existsSync(path.join(target, "installed_plugins.json"))).toBe(false);
  });

  it("refreshes the copy when the canonical credentials are newer", () => {
    ensureClaudeConfigDir(target, source);
    const dest = path.join(target, ".credentials.json");
    // Make the canonical creds newer than the copy, then re-sync.
    const future = new Date(Date.now() + 60_000);
    writeFileSync(path.join(source, ".credentials.json"), JSON.stringify({ token: "rotated" }));
    utimesSync(path.join(source, ".credentials.json"), future, future);
    ensureClaudeConfigDir(target, source);
    expect(readFileSync(dest, "utf8")).toContain("rotated");
  });

  it("is a no-op without a source credentials file", () => {
    rmSync(path.join(source, ".credentials.json"));
    ensureClaudeConfigDir(target, source);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(path.join(target, ".credentials.json"))).toBe(false);
  });
});
