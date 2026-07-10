import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodexMcpOverrideArgs,
  buildCodexMcpOverrideConfig,
  isCodexMcpEnabled,
  listConfiguredCodexMcpServers,
  setCodexMcpEnabled,
} from "../src/codex-mcp-toggle.js";

const SAMPLE_CONFIG = `
personality = "pragmatic"

[features]
goals = true

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.hermes-tools]
command = 'C:\\python.exe'
args = ["-m", "server"]

[mcp_servers.hermes-tools.env]
PYTHONPATH = 'C:\\hermes'

[mcp_servers."quoted.name"]
command = "whatever"
`;

describe("codex-mcp-toggle", () => {
  let tempDir: string;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "telecodex-mcp-toggle-"));
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
    setCodexMcpEnabled(false);
  });

  afterEach(() => {
    if (savedCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHome;
    }
    setCodexMcpEnabled(false);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists each configured server once, ignoring nested tables and handling quoted names", () => {
    writeFileSync(path.join(tempDir, "config.toml"), SAMPLE_CONFIG, "utf8");
    expect(listConfiguredCodexMcpServers().sort()).toEqual([
      "hermes-tools",
      "openaiDeveloperDocs",
      "quoted.name",
    ]);
  });

  it("returns no servers when config.toml is missing", () => {
    expect(listConfiguredCodexMcpServers()).toEqual([]);
    expect(buildCodexMcpOverrideArgs()).toEqual([]);
  });

  it("builds -c disable args for every server when the toggle is off", () => {
    writeFileSync(path.join(tempDir, "config.toml"), SAMPLE_CONFIG, "utf8");
    const args = buildCodexMcpOverrideArgs();
    expect(args).toContain("mcp_servers.hermes-tools.enabled=false");
    expect(args).toContain("mcp_servers.openaiDeveloperDocs.enabled=false");
    expect(args).toContain('mcp_servers."quoted.name".enabled=false');
    expect(args.filter((arg) => arg === "-c")).toHaveLength(3);
  });

  it("builds no overrides when the toggle is on", () => {
    writeFileSync(path.join(tempDir, "config.toml"), SAMPLE_CONFIG, "utf8");
    setCodexMcpEnabled(true);
    expect(isCodexMcpEnabled()).toBe(true);
    expect(buildCodexMcpOverrideArgs()).toEqual([]);
    expect(buildCodexMcpOverrideConfig()).toEqual({});
  });

  it("builds SDK config override entries when the toggle is off", () => {
    writeFileSync(path.join(tempDir, "config.toml"), SAMPLE_CONFIG, "utf8");
    expect(buildCodexMcpOverrideConfig()).toEqual({
      "mcp_servers.hermes-tools.enabled": false,
      "mcp_servers.openaiDeveloperDocs.enabled": false,
      'mcp_servers."quoted.name".enabled': false,
    });
  });

  it("survives a config directory that exists without config.toml", () => {
    mkdirSync(path.join(tempDir, "sub"), { recursive: true });
    expect(buildCodexMcpOverrideArgs()).toEqual([]);
  });
});
