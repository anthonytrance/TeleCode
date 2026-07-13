import {
  assertTelegramPollingSafety,
  findClaudeTelegramPluginCommandLines,
  fingerprintTelegramToken,
} from "../src/startup-safety.js";

describe("startup safety", () => {
  it("allows unlabeled current behavior while redacting the token to a fingerprint", () => {
    const result = assertTelegramPollingSafety({
      token: "123456:secret-token",
      env: {},
    });

    expect(result).toEqual({
      tokenRole: "unspecified",
      canaryMode: false,
      allowProductionPolling: false,
      tokenFingerprint: fingerprintTelegramToken("123456:secret-token"),
    });
    expect(result.tokenFingerprint).not.toContain("secret-token");
  });

  it("requires explicit acknowledgement for a production token", () => {
    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: { TELECODE_TOKEN_ROLE: "production" },
      }),
    ).toThrow("TELECODE_TOKEN_ROLE=production requires TELECODE_ALLOW_PRODUCTION_POLLING=true.");

    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: {
          TELECODE_TOKEN_ROLE: "production",
          TELECODE_ALLOW_PRODUCTION_POLLING: "true",
        },
      }),
    ).not.toThrow();
  });

  it("keeps canary and production modes separate", () => {
    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: { TELECODE_TOKEN_ROLE: "canary" },
      }),
    ).toThrow("TELECODE_TOKEN_ROLE=canary requires TELECODE_CANARY_MODE=true.");

    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: {
          TELECODE_TOKEN_ROLE: "production",
          TELECODE_CANARY_MODE: "true",
          TELECODE_ALLOW_PRODUCTION_POLLING: "true",
        },
      }),
    ).toThrow("TELECODE_TOKEN_ROLE=production cannot be used with TELECODE_CANARY_MODE=true.");
  });

  it("accepts legacy TELECODEX safety variables", () => {
    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: {
          TELECODEX_TOKEN_ROLE: "production",
          TELECODEX_ALLOW_PRODUCTION_POLLING: "true",
        },
      }),
    ).not.toThrow();
  });

  it("detects Claude processes that start the Telegram plugin", () => {
    expect(
      findClaudeTelegramPluginCommandLines([
        "123 node.exe C:\\Users\\Anthony\\codetest\\tools\\telecode\\dist\\index.js",
        "456 claude.exe --model sonnet --strict-mcp-config",
        "567 powershell.exe Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*plugin:telegram*' -and $_.CommandLine -like '*claude*' }",
        "678 cmd.exe /c \"C:\\Users\\Anthony\\.local\\bin\\claude.exe --channels plugin:telegram@claude-plugins-official & cmd /k\"",
        "789 claude.exe --channels plugin:telegram@claude-plugins-official --model opus",
      ]),
    ).toEqual(["789 claude.exe --channels plugin:telegram@claude-plugins-official --model opus"]);
  });
});
