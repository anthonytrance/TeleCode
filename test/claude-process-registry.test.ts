import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ClaudeProcessRegistry,
  claudeProcessRegistryPath,
  isRegisteredClaudeProcess,
} from "../src/providers/claude-process-registry.js";

describe("ClaudeProcessRegistry", () => {
  it("stores and removes TeleCodex Claude process records", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-claude-pids-"));
    try {
      const registry = new ClaudeProcessRegistry(claudeProcessRegistryPath(workspace));

      registry.upsert({
        pid: 123,
        sessionId: "claude-session",
        providerSessionId: "provider-session",
        startedAt: 1000,
      });

      expect(registry.list()).toEqual([
        {
          pid: 123,
          sessionId: "claude-session",
          providerSessionId: "provider-session",
          startedAt: 1000,
        },
      ]);
      expect(readFileSync(claudeProcessRegistryPath(workspace), "utf8")).toContain("provider-session");

      registry.removeSession("claude-session");

      expect(registry.list()).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("matches only Claude processes with the recorded provider session id", () => {
    const record = {
      pid: 123,
      sessionId: "claude-session",
      providerSessionId: "dabbbb80-1875-4d4f-aeca-32097e2111ff",
      startedAt: 1000,
    };

    expect(
      isRegisteredClaudeProcess(record, {
        name: "claude.exe",
        commandLine: "claude.exe --resume dabbbb80-1875-4d4f-aeca-32097e2111ff --model sonnet",
      }),
    ).toBe(true);
    expect(
      isRegisteredClaudeProcess(record, {
        name: "claude.exe",
        commandLine: "claude.exe --resume unrelated --model opus",
      }),
    ).toBe(false);
    expect(
      isRegisteredClaudeProcess(record, {
        name: "node.exe",
        commandLine: "node dist/index.js",
      }),
    ).toBe(false);
  });

  it("treats corrupt registry files as empty operational state", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-claude-pids-"));
    try {
      const registryPath = claudeProcessRegistryPath(workspace);
      mkdirSync(path.dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, "{not-json", "utf8");

      const registry = new ClaudeProcessRegistry(registryPath);

      expect(registry.list()).toEqual([]);
      expect(() => registry.removePid(123)).not.toThrow();
      registry.upsert({
        pid: 456,
        sessionId: "claude-session",
        providerSessionId: "provider-session",
        startedAt: 1000,
      });
      expect(registry.list()).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("ignores invalid registry entries", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "telecodex-claude-pids-"));
    try {
      const registryPath = claudeProcessRegistryPath(workspace);
      mkdirSync(path.dirname(registryPath), { recursive: true });
      writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          processes: [
            { pid: 0, sessionId: "bad", providerSessionId: "bad", startedAt: 1 },
            { pid: 123, sessionId: "ok", providerSessionId: "provider-session", startedAt: 1 },
            { pid: 456, sessionId: "", providerSessionId: "bad", startedAt: 1 },
          ],
        }),
        "utf8",
      );

      const registry = new ClaudeProcessRegistry(registryPath);

      expect(registry.list()).toEqual([
        { pid: 123, sessionId: "ok", providerSessionId: "provider-session", startedAt: 1 },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
