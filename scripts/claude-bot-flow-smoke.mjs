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
const tempWorkspace = mkdtempSync(path.join(tmpdir(), "telecode-bot-claude-smoke-"));
const expectedFirst = "CANARY_BOT_FLOW";
const expectedSecond = "CANARY_BOT_SECOND";
const expectedAfterExit = "CANARY_AFTER_EXIT";
const expectedModelSwitch = "CANARY_MODEL_SWITCH";
const expectedNewModel = "CANARY_NEW_MODEL";
let registry;
let bot;
let config;
let releaseLock;

try {
  releaseLock = await acquireClaudeLiveLock(baseConfig.workspace, "claude-bot-flow-smoke");
  config = createSmokeConfig(baseConfig, tempWorkspace);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  const sent = installMockTelegramApi(bot, config);
  installBotInfo(bot);

  console.log("[claude-bot-smoke] state workspace:", tempWorkspace);
  console.log("[claude-bot-smoke] claude workspace:", config.claudeWorkspace);
  console.log("[claude-bot-smoke] model:", config.claudeDefaultModel);
  console.log("[claude-bot-smoke] strictMcp:", config.claudeStrictMcpConfig);

  await bot.handleUpdate(textUpdate(1, `/claude Reply with exactly ${expectedFirst} and nothing else.`, config));
  const firstText = await waitForCapturedText(sent, expectedFirst, 240000);
  console.log("[claude-bot-smoke] first reply:", firstText.trim());

  await bot.handleUpdate(textUpdate(2, `Reply with exactly ${expectedSecond} and nothing else.`, config));
  const secondText = await waitForCapturedText(sent, expectedSecond, 240000);
  console.log("[claude-bot-smoke] second reply:", secondText.trim());

  await bot.handleUpdate(textUpdate(3, "/sessions", config));
  const sessionsPayload = JSON.stringify(sent.map((entry) => entry.payload));
  if (!sessionsPayload.includes(expectedFirst)) {
    throw new Error(`/sessions did not expose a useful Claude title. Payload: ${sessionsPayload}`);
  }
  if (/provider-session-\d|claude-provider-\d/i.test(sessionsPayload)) {
    throw new Error(`/sessions exposed mock-style provider IDs instead of titles. Payload: ${sessionsPayload}`);
  }
  console.log("[claude-bot-smoke] sessions title check: PASS");

  await bot.handleUpdate(textUpdate(4, "/exit", config));
  await waitForCapturedText(sent, "Claude process disposed", 30000);
  assertPidRegistryEmpty(config.workspace, "after /exit");
  console.log("[claude-bot-smoke] exit cleanup check: PASS");

  await bot.handleUpdate(textUpdate(5, `/claude Reply with exactly ${expectedAfterExit} and nothing else.`, config));
  const afterExitText = await waitForCapturedText(sent, expectedAfterExit, 240000);
  console.log("[claude-bot-smoke] after-exit reply:", afterExitText.trim());

  const beforeModelCommandMessages = sent.length;
  await bot.handleUpdate(textUpdate(6, "/model opus", config));
  await waitFor(() => Boolean(findModelCommandResult(sent, beforeModelCommandMessages)), 240000);
  const modelCommandResult = findModelCommandResult(sent, beforeModelCommandMessages);
  if (/Claude (?:failed|error):/i.test(modelCommandResult)) {
    throw new Error(`Model command failed: ${modelCommandResult}`);
  }
  await bot.handleUpdate(textUpdate(7, `Reply with exactly ${expectedModelSwitch} and nothing else.`, config));
  const modelSwitchText = await waitForCapturedText(sent, expectedModelSwitch, 240000);
  console.log("[claude-bot-smoke] model-switch reply:", modelSwitchText.trim());

  await bot.handleUpdate(textUpdate(8, "/new claude opus", config));
  await waitForCapturedText(sent, "New Claude session selected with model opus", 30000);
  await bot.handleUpdate(textUpdate(9, `Reply with exactly ${expectedNewModel} and nothing else.`, config));
  const newModelText = await waitForCapturedText(sent, expectedNewModel, 240000);
  console.log("[claude-bot-smoke] new-model reply:", newModelText.trim());

  console.log("[claude-bot-smoke] messages sent:", sent.filter((entry) => entry.method === "sendMessage").length);
  console.log("[claude-bot-smoke] RESULT: PASS");
} catch (error) {
  console.error("[claude-bot-smoke] RESULT: FAIL");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await bot?.disposeProviders();
    if (config) {
      assertPidRegistryEmpty(config.workspace, "after disposeProviders");
    }
  } catch (error) {
    console.error("[claude-bot-smoke] dispose failed:", error);
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
    from: { id: userId, is_bot: false, first_name: "Tester" },
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
  throw new Error("Timed out waiting for Claude bot-flow canary reply");
}

async function waitForCapturedText(sent, expected, timeoutMs) {
  await waitFor(() => sent.some((entry) => entry.text?.toUpperCase().includes(expected.toUpperCase())), timeoutMs);
  return sent
    .map((entry) => entry.text ?? "")
    .find((text) => text.toUpperCase().includes(expected.toUpperCase()));
}

function findModelCommandResult(sent, startIndex) {
  return sent
    .slice(startIndex)
    .map((entry) => entry.text ?? "")
    .find((text) =>
      text.includes("Claude model command accepted: opus") ||
      text.includes("Claude model command sent: opus") ||
      text.includes("Claude failed:") ||
      text.includes("Claude error:"));
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
