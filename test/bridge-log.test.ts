import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bridgeLog, initBridgeLog } from "../src/bridge-log.js";

describe("bridge log", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "telecode-bridge-log-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("appends ISO | area | message lines to the daily file", () => {
    initBridgeLog(workspace);
    bridgeLog("intake", "message received lane=123 chars=42");
    bridgeLog("turn", "end lane=123 ok=true\nwith newline");

    const logDir = path.join(workspace, ".telecode", "logs");
    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^bridge-\d{8}\.log$/);

    const lines = readFileSync(path.join(logDir, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z \| intake \| message received lane=123 chars=42$/);
    expect(lines[1]).toContain("\\nwith newline");
  });

  it("prunes log files older than the retention window on init", () => {
    const logDir = path.join(workspace, ".telecode", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "bridge-20200101.log"), "old\n", "utf8");
    writeFileSync(path.join(logDir, "unrelated.txt"), "keep\n", "utf8");

    initBridgeLog(workspace);
    bridgeLog("startup", "hello");

    const files = readdirSync(logDir).sort();
    expect(files).not.toContain("bridge-20200101.log");
    expect(files).toContain("unrelated.txt");
  });
});
