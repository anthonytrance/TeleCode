// Live smoke for the Claude Agent SDK backend (phase plan C3).
// Proves, through the full bot pipeline:
//   1. pty turn → /backend sdk → next turn RESUMES THE SAME CONVERSATION (memory recall)
//   2. on sdk, every interim narration block reaches Telegram as its own message, in order
//      (the D3 fix — the PTY smoke cannot pass this)
//   3. /backend pty rollback drill: a further turn still works and still recalls
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBot } from "../dist/bot.js";
import { createDefaultLaunchProfile } from "../dist/codex-launch.js";
import { loadConfig } from "../dist/config.js";
import { SessionRegistry } from "../dist/session-registry.js";
import { acquireClaudeLiveLock } from "./claude-live-lock.mjs";

process.env.ENABLE_CLAUDE_PROVIDER = "true";

const baseConfig = loadConfig();
const tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecode-sdk-smoke-"));
const memoryWord = "ZEBRAFISH";
let registry;
let bot;
let config;
let releaseLock;

try {
  releaseLock = await acquireClaudeLiveLock(baseConfig.workspace, "claude-sdk-bot-flow-smoke");
  config = createSmokeConfig(baseConfig, tempWorkspace);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  const sent = installMockTelegramApi(bot, config);
  installBotInfo(bot);

  console.log("[claude-sdk-smoke] state workspace:", tempWorkspace);
  console.log("[claude-sdk-smoke] default engine:", config.claudeBackend);

  // 1. First turn on the PTY engine, planting a memory.
  await bot.handleUpdate(textUpdate(1, `/claude Remember the secret word ${memoryWord}. Reply with exactly PTY_TURN_OK and nothing else.`, config));
  await waitForCapturedText(sent, "PTY_TURN_OK", 240000);
  console.log("[claude-sdk-smoke] pty turn: PASS");

  // 2. Switch the engine live.
  await bot.handleUpdate(textUpdate(2, "/backend sdk", config));
  await waitForCapturedText(sent, "Claude engine for this Telegram context is now sdk", 30000);
  console.log("[claude-sdk-smoke] live switch to sdk: PASS");

  // 3. Same conversation must continue on the SDK engine.
  await bot.handleUpdate(textUpdate(3, "What is the secret word I asked you to remember? Reply with just that word.", config));
  await waitForCapturedText(sent, memoryWord, 240000);
  console.log("[claude-sdk-smoke] cross-engine session continuity: PASS");

  // 4. Interim narration: all three texts must arrive as separate messages, in order.
  const narrationStart = sent.length;
  await bot.handleUpdate(textUpdate(4, [
    "Reply with exactly INTERIM_ONE.",
    'Then run the shell command "echo ok" using Bash.',
    "Then reply with exactly INTERIM_TWO.",
    'Then run "echo ok2" using Bash.',
    "Then finish by replying with exactly FINAL_MARK.",
  ].join(" "), config));
  await waitForCapturedText(sent, "FINAL_MARK", 240000);
  const markers = ["INTERIM_ONE", "INTERIM_TWO", "FINAL_MARK"];
  const indexes = markers.map((marker) => sent.findIndex(
    (entry, index) => index >= narrationStart && entry.method === "sendMessage" && entry.text?.includes(marker),
  ));
  for (const [order, marker] of markers.entries()) {
    if (indexes[order] === -1) {
      throw new Error(`Narration marker ${marker} never arrived as its own message`);
    }
  }
  if (!(indexes[0] < indexes[1] && indexes[1] < indexes[2])) {
    throw new Error(`Narration markers out of order: ${JSON.stringify(indexes)}`);
  }
  console.log("[claude-sdk-smoke] interim narration delivery (D3 fix): PASS");

  // 5. Rollback drill: back to pty, same conversation, still recalls.
  await bot.handleUpdate(textUpdate(5, "/backend pty", config));
  await waitForCapturedText(sent, "Claude engine for this Telegram context is now pty", 30000);
  const recallStart = sent.length;
  await bot.handleUpdate(textUpdate(6, "One more time: what was the secret word? Reply with just that word.", config));
  await waitFor(() => sent.some(
    (entry, index) => index >= recallStart && entry.text?.includes(memoryWord),
  ), 240000);
  console.log("[claude-sdk-smoke] rollback to pty + continuity: PASS");

  console.log("[claude-sdk-smoke] messages sent:", sent.filter((entry) => entry.method === "sendMessage").length);
  console.log("[claude-sdk-smoke] RESULT: PASS");
} catch (error) {
  console.error("[claude-sdk-smoke] RESULT: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await bot?.disposeProviders();
    if (config) {
      assertPidRegistryEmpty(config.workspace, "after disposeProviders");
    }
  } catch (error) {
    console.error("[claude-sdk-smoke] dispose failed:", error);
    process.exitCode = 1;
  }
  releaseLock?.();
  try {
    registry?.disposeAll();
  } catch {
    // Best effort cleanup for smoke-test state.
  }
  rmSync(tempWorkspace, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);

function createSmokeConfig(base, workspace) {
  const launchProfile = createDefaultLaunchProfile("danger-full-access", "never");
  return {
    ...base,
    telegramAllowedUserIds: [base.telegramAllowedUserIds[0]],
    telegramAllowedUserIdSet: new Set([base.telegramAllowedUserIds[0]]),
    workspace,
    codexBackend: "app-server",
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    launchProfiles: [launchProfile],
    defaultLaunchProfileId: launchProfile.id,
    enableUnsafeLaunchProfiles: true,
    streamAssistantText: false,
    progressDelivery: "messages",
    showTurnTokenUsage: false,
    enableTelegramLogin: false,
    enableTelegramReactions: false,
    enableClaudeProvider: true,
    claudeWorkspace: base.claudeWorkspace,
    claudePermissionMode: "bypassPermissions",
    claudeBackend: "pty",
  };
}

function installMockTelegramApi(bot, config) {
  const sent = [];
  let messageId = 1000;
  bot.api.config.use(async (_prev, method, payload = {}) => {
    if (method === "sendMessage") {
      sent.push({ method, text: payload.text, payload });
      return { ok: true, result: textMessage(messageId++, payload.text ?? "", config) };
    }
    if (method === "editMessageText") {
      sent.push({ method, text: payload.text, payload });
      return { ok: true, result: true };
    }
    if (
      method === "sendChatAction" ||
      method === "answerCallbackQuery" ||
      method === "setMessageReaction"
    ) {
      sent.push({ method, payload });
      return { ok: true, result: true };
    }
    throw new Error(`Unhandled Telegram API method in smoke test: ${method}`);
  });
  return sent;
}

function installBotInfo(bot) {
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "TeleCode",
    username: "TeleCodeBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
}

function textUpdate(updateId, text, config) {
  return {
    update_id: updateId,
    message: textMessage(updateId, text, config),
  };
}

function textMessage(messageId, text, config) {
  const commandMatch = text.match(/^\/\S+/u);
  const userId = config.telegramAllowedUserIds[0];
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Anthony" },
    text,
    entities: commandMatch
      ? [{ type: "bot_command", offset: 0, length: commandMatch[0].length }]
      : undefined,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Claude SDK smoke condition");
}

async function waitForCapturedText(sent, expected, timeoutMs) {
  await waitFor(() => sent.some((entry) => entry.text?.toUpperCase().includes(expected.toUpperCase())), timeoutMs);
  return sent
    .map((entry) => entry.text ?? "")
    .find((text) => text.toUpperCase().includes(expected.toUpperCase()));
}

function assertPidRegistryEmpty(workspace, label) {
  const registryPath = path.join(workspace, ".telecode", "provider-state", "claude-pids.json");
  if (!existsSync(registryPath)) {
    return;
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (Array.isArray(parsed.processes) && parsed.processes.length === 0) {
    return;
  }
  throw new Error(`Claude PID registry not empty ${label}: ${readFileSync(registryPath, "utf8")}`);
}
