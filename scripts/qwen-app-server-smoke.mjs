/**
 * Live proof that the app-server backend can drive a QwenCloud vendor model.
 *
 * Runs one real turn against token-plan.ap-southeast-1 through the same code the
 * bot uses (AppServerSessionService -> CodexAppServerClient -> codex app-server),
 * so a pass means /model qwen3.8-max works on Telegram too.
 *
 *   node scripts/qwen-app-server-smoke.mjs [model]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AppServerSessionService } from "../dist/app-server-session.js";
import { createDefaultLaunchProfile } from "../dist/codex-launch.js";

const workspace = process.env.TELECODE_WORKSPACE ?? process.cwd();
const model = process.argv[2] ?? "qwen3.8-max";

if (!process.env.DASHSCOPE_API_KEY) {
  const credentials = JSON.parse(readFileSync(join(workspace, "model_vendor_credentials.json"), "utf8"));
  process.env.DASHSCOPE_API_KEY = credentials.modelstudio;
}

const config = {
  telegramBotToken: "unused",
  telegramAllowedUserIds: [],
  telegramAllowedUserIdSet: new Set(),
  workspace,
  maxFileSize: 20 * 1024 * 1024,
  codexModel: model,
  codexBackend: "app-server",
  codexSandboxMode: "read-only",
  codexApprovalPolicy: "never",
  launchProfiles: [createDefaultLaunchProfile("read-only", "never")],
  defaultLaunchProfileId: "default",
  enableUnsafeLaunchProfiles: false,
  toolVerbosity: "summary",
  streamAssistantText: false,
  progressDelivery: "messages",
  showTurnTokenUsage: false,
  enableTelegramLogin: false,
  enableTelegramReactions: false,
};

const service = await AppServerSessionService.create(config, { model });
console.log("thread:", service.getInfo().threadId, "model:", service.getInfo().model);

let text = "";
try {
  await service.prompt(
    { text: "Reply with exactly: ok" },
    {
      onTextDelta: (delta) => {
        text += delta;
      },
      onToolStart: () => undefined,
      onToolUpdate: () => undefined,
      onToolEnd: () => undefined,
      onAgentEnd: (final) => {
        text = final ?? text;
      },
    },
  );
  console.log("PASS reply:", JSON.stringify(text.trim().slice(0, 200)));
} catch (error) {
  console.log("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  service.dispose();
}
