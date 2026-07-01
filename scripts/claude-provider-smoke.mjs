import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { ClaudeProviderAdapter } from "../dist/providers/claude-adapter.js";
import { findTranscript } from "../dist/providers/claude-transcript.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";

process.env.ENABLE_CLAUDE_PROVIDER = "true";

const baseConfig = loadConfig();
const tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecodex-provider-claude-smoke-"));
const config = {
  ...baseConfig,
  workspace: tempWorkspace,
  claudeWorkspace: baseConfig.claudeWorkspace,
};
const adapter = new ClaudeProviderAdapter(config);
let sessionId;
let releaseLock;

function transcriptConfigDir() {
  return config.claudeStrictMcpConfig ? undefined : config.claudeConfigDir;
}

function fileSize(filePath) {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}

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

async function sendAndExpect(text, expected) {
  let assistantText = "";
  const seen = {};
  for await (const event of adapter.sendPrompt({
    sessionId,
    input: { text },
    jobId: `smoke-${Date.now()}`,
  })) {
    seen[event.type] = (seen[event.type] ?? 0) + 1;
    if (event.type === "assistant_text_delta" && event.text) {
      assistantText += event.text;
    }
    if (event.type === "assistant_message_complete" && event.text) {
      assistantText = event.text;
    }
  }

  const normalized = assistantText.trim().toUpperCase();
  if (!normalized.includes(expected)) {
    throw new Error(`Expected ${expected}, got ${JSON.stringify(assistantText.trim())}`);
  }
  if (!seen.usage_updated) {
    throw new Error(`No usage_updated event for ${expected}`);
  }
  return { assistantText: assistantText.trim(), seen };
}

try {
  releaseLock = await acquireClaudeLiveLock(baseConfig.workspace, "claude-provider-smoke");
  console.log("[claude-smoke] state workspace:", tempWorkspace);
  console.log("[claude-smoke] bin:", config.claudeBin);
  console.log("[claude-smoke] model:", config.claudeDefaultModel);
  console.log("[claude-smoke] workspace:", config.claudeWorkspace);
  console.log("[claude-smoke] strictMcp:", config.claudeStrictMcpConfig);

  const descriptor = await adapter.createSession({
    displayName: "TeleCodex provider smoke",
    workspace: config.claudeWorkspace,
    metadata: {
      model: config.claudeDefaultModel,
      permissionMode: config.claudePermissionMode,
    },
  });
  sessionId = descriptor.id;
  console.log("[claude-smoke] session:", descriptor.id, "uuid:", descriptor.providerSessionId);

  const first = await sendAndExpect("Reply with exactly CANARY_ONE and nothing else.", "CANARY_ONE");
  console.log("[claude-smoke] first:", JSON.stringify(first));

  const refreshed = await adapter.getSessionInfo(sessionId);
  const transcriptPath = await findTranscript(refreshed.providerSessionId, 5000, transcriptConfigDir());
  if (!transcriptPath) {
    throw new Error(`Transcript not found for ${refreshed.providerSessionId}`);
  }
  const firstSize = fileSize(transcriptPath);
  if (firstSize <= 0) {
    throw new Error(`Transcript is empty: ${transcriptPath}`);
  }
  console.log("[claude-smoke] transcript:", transcriptPath);
  console.log("[claude-smoke] transcript size after first:", firstSize);

  const second = await sendAndExpect("Reply with exactly CANARY_TWO and nothing else.", "CANARY_TWO");
  console.log("[claude-smoke] second:", JSON.stringify(second));

  const secondSize = fileSize(transcriptPath);
  if (secondSize <= firstSize) {
    throw new Error(`Transcript did not grow. Before ${firstSize}, after ${secondSize}`);
  }
  console.log("[claude-smoke] transcript size after second:", secondSize);

  const usage = await adapter.getUsage(sessionId);
  const context = await adapter.getContext(sessionId);
  if (!usage.contextTokens || !context.usedTokens) {
    throw new Error(`Usage/context missing: ${JSON.stringify({ usage, context })}`);
  }
  console.log("[claude-smoke] usage:", JSON.stringify(usage));
  console.log("[claude-smoke] context:", JSON.stringify(context));
  console.log("[claude-smoke] RESULT: PASS");
} catch (error) {
  console.error("[claude-smoke] RESULT: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (sessionId) {
      await adapter.dispose(sessionId);
    }
    assertPidRegistryEmpty("after provider smoke dispose");
  } catch (error) {
    console.error("[claude-smoke] dispose failed:", error);
    process.exitCode = 1;
  }
  releaseLock?.();
  rmSync(tempWorkspace, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
