import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { loadConfig } from "./config.js";
import { cleanupRegisteredClaudeProcesses } from "./providers/claude-process-registry.js";
import { SessionRegistry } from "./session-registry.js";
import { assertTelegramPollingSafety, findRunningClaudeTelegramPluginProcesses } from "./startup-safety.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;

try {
  const config = loadConfig();
  if (config.enableClaudeProvider) {
    const cleanedClaudeProcesses = await cleanupRegisteredClaudeProcesses(config.workspace);
    if (cleanedClaudeProcesses > 0) {
      console.warn(`Cleaned up ${cleanedClaudeProcesses} stale TeleCode Claude process(es).`);
    }
  }
  const pollingSafety = assertTelegramPollingSafety({ token: config.telegramBotToken });
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  await registerCommands(bot);

  console.log("TeleCode running");
  console.log(
    `Telegram polling profile: role=${pollingSafety.tokenRole}, canary=${pollingSafety.canaryMode}, token=${pollingSafety.tokenFingerprint}`,
  );
  console.log(`Codex backend: ${config.codexBackend}`);
  const authStatus = await checkAuthStatus(config.codexApiKey);
  console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
  if (!authStatus.authenticated) {
    console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
  }
  console.log(`Workspace: ${config.workspace}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
  const competingClaudeProcesses = await findRunningClaudeTelegramPluginProcesses();
  if (competingClaudeProcesses.length > 0) {
    console.warn(
      `Notice: found ${competingClaudeProcesses.length} Claude Telegram plugin process(es). ` +
        "This is fine if they use a different bot token than TeleCode; sharing a token would cause polling conflicts.",
    );
    console.warn("Use /doctor for Claude plugin process details.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TeleCode: ${message}`);
  await bot?.disposeProviders().catch((disposeError) => {
    console.warn("Failed to dispose provider sessions during startup failure", disposeError);
  });
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TeleCode...`);
  if (bot) bot.stop();

  setTimeout(() => {
    void (async () => {
      try {
        await bot?.disposeProviders();
      } catch (error) {
        console.warn("Failed to dispose provider sessions during shutdown", error);
      }
      registry?.disposeAll();
      console.log("TeleCode stopped.");
      process.exit(0);
    })();
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: false,
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    await bot?.disposeProviders().catch((disposeError) => {
      console.warn("Failed to dispose provider sessions after fatal polling error", disposeError);
    });
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
