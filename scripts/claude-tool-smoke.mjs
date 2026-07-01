import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { ClaudeProviderAdapter } from "../dist/providers/claude-adapter.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";

process.env.ENABLE_CLAUDE_PROVIDER = "true";

const baseConfig = loadConfig();
const tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecodex-claude-tool-smoke-"));
const config = {
  ...baseConfig,
  workspace: tempWorkspace,
  claudeWorkspace: baseConfig.claudeWorkspace,
  claudeTurnIdleTimeoutSeconds: 75,
};
const adapter = new ClaudeProviderAdapter(config);
let sessionId;
let releaseLock;

function assertPidRegistryEmpty(label) {
  const registryPath = path.join(config.workspace, ".telecodex", "provider-state", "claude-pids.json");
  if (!existsSync(registryPath)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (Array.isArray(parsed.processes) && parsed.processes.length === 0) {
    return;
  }
  throw new Error(`Claude PID registry not empty ${label}: ${readFileSync(registryPath, "utf8")}`);
}

try {
  releaseLock = await acquireClaudeLiveLock(baseConfig.workspace, "claude-tool-smoke");
  console.log("[claude-tool-smoke] state workspace:", tempWorkspace);
  console.log("[claude-tool-smoke] claude workspace:", config.claudeWorkspace);
  console.log("[claude-tool-smoke] model:", config.claudeDefaultModel);

  const descriptor = await adapter.createSession({
    displayName: "TeleCodex Claude tool smoke",
    workspace: config.claudeWorkspace,
    metadata: {
      model: config.claudeDefaultModel,
      permissionMode: config.claudePermissionMode,
    },
  });
  sessionId = descriptor.id;

  const prompt = [
    "Use PowerShell to run this exact command: Write-Output TELECODEX_TOOL_OK",
    "After the command succeeds, reply with exactly TELECODEX_TOOL_OK and nothing else.",
  ].join("\n");

  let assistantText = "";
  const seen = {};
  for await (const event of adapter.sendPrompt({
    sessionId,
    input: { text: prompt },
    jobId: `tool-smoke-${Date.now()}`,
  })) {
    seen[event.type] = (seen[event.type] ?? 0) + 1;
    if (event.type === "assistant_text_delta" && event.text) {
      assistantText += event.text;
    }
    if (event.type === "assistant_message_complete" && event.text) {
      assistantText = event.text;
    }
  }

  if (!assistantText.toUpperCase().includes("TELECODEX_TOOL_OK")) {
    throw new Error(`Expected TELECODEX_TOOL_OK, got ${JSON.stringify(assistantText.trim())}`);
  }
  if (!seen.tool_started || !seen.tool_completed) {
    throw new Error(`Expected tool_started and tool_completed events, saw ${JSON.stringify(seen)}`);
  }

  console.log("[claude-tool-smoke] reply:", assistantText.trim());
  console.log("[claude-tool-smoke] events:", JSON.stringify(seen));
  console.log("[claude-tool-smoke] RESULT: PASS");
} catch (error) {
  console.error("[claude-tool-smoke] RESULT: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (sessionId) {
      await adapter.dispose(sessionId);
    }
    assertPidRegistryEmpty("after tool smoke dispose");
  } catch (error) {
    console.error("[claude-tool-smoke] dispose failed:", error);
    process.exitCode = 1;
  }
  releaseLock?.();
  rmSync(tempWorkspace, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
