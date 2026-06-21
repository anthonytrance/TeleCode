import { assertTelegramPollingSafety, fingerprintTelegramToken } from "../src/startup-safety.js";

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
        env: { TELECODEX_TOKEN_ROLE: "production" },
      }),
    ).toThrow("TELECODEX_TOKEN_ROLE=production requires TELECODEX_ALLOW_PRODUCTION_POLLING=true.");

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

  it("keeps canary and production modes separate", () => {
    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: { TELECODEX_TOKEN_ROLE: "canary" },
      }),
    ).toThrow("TELECODEX_TOKEN_ROLE=canary requires TELECODEX_CANARY_MODE=true.");

    expect(() =>
      assertTelegramPollingSafety({
        token: "123456:secret-token",
        env: {
          TELECODEX_TOKEN_ROLE: "production",
          TELECODEX_CANARY_MODE: "true",
          TELECODEX_ALLOW_PRODUCTION_POLLING: "true",
        },
      }),
    ).toThrow("TELECODEX_TOKEN_ROLE=production cannot be used with TELECODEX_CANARY_MODE=true.");
  });
});
