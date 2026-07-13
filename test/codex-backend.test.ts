import { vi } from "vitest";

import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { TeleCodeConfig } from "../src/config.js";

const mockState = vi.hoisted(() => ({
  sdkCreate: vi.fn(),
  appServerCreate: vi.fn(),
}));

vi.mock("../src/codex-session.js", () => ({
  CodexSessionService: {
    create: mockState.sdkCreate,
  },
}));

vi.mock("../src/app-server-session.js", () => ({
  AppServerSessionService: {
    create: mockState.appServerCreate,
  },
}));

import { createCodexSession } from "../src/codex-backend.js";

describe("createCodexSession", () => {
  beforeEach(() => {
    mockState.sdkCreate.mockReset();
    mockState.appServerCreate.mockReset();
  });

  it("delegates sdk backend creation to CodexSessionService", async () => {
    const session = { getInfo: vi.fn() };
    mockState.sdkCreate.mockResolvedValue(session);
    const options = { deferThreadStart: true };

    await expect(createCodexSession(createConfig(), options)).resolves.toBe(session);
    expect(mockState.sdkCreate).toHaveBeenCalledWith(createConfig(), options);
  });

  it("delegates app-server backend creation to AppServerSessionService", async () => {
    const session = { getInfo: vi.fn() };
    mockState.appServerCreate.mockResolvedValue(session);
    const config = createConfig({ codexBackend: "app-server" });
    const options = { deferThreadStart: true };

    await expect(createCodexSession(config, options)).resolves.toBe(session);
    expect(mockState.appServerCreate).toHaveBeenCalledWith(config, options);
    expect(mockState.sdkCreate).not.toHaveBeenCalled();
  });
});

function createConfig(overrides: Partial<TeleCodeConfig> = {}): TeleCodeConfig {
  return {
    telegramBotToken: "bot-token",
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "gpt-5.5",
    codexBackend: "sdk",
    codexAppServerPath: undefined,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    streamAssistantText: false,
    progressDelivery: "messages",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    ...overrides,
  };
}
