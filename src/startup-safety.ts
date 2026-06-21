import { createHash } from "node:crypto";

export type TelegramTokenRole = "unspecified" | "development" | "canary" | "production";

export interface PollingSafetyOptions {
  token: string;
  env?: NodeJS.ProcessEnv;
}

export interface PollingSafetyResult {
  tokenRole: TelegramTokenRole;
  canaryMode: boolean;
  allowProductionPolling: boolean;
  tokenFingerprint: string;
}

export function assertTelegramPollingSafety(options: PollingSafetyOptions): PollingSafetyResult {
  const env = options.env ?? process.env;
  const tokenRole = parseTokenRole(env.TELECODEX_TOKEN_ROLE);
  const canaryMode = parseBoolean(env.TELECODEX_CANARY_MODE, false);
  const allowProductionPolling = parseBoolean(env.TELECODEX_ALLOW_PRODUCTION_POLLING, false);
  const tokenFingerprint = fingerprintTelegramToken(options.token);

  if (tokenRole === "canary" && !canaryMode) {
    throw new Error("TELECODEX_TOKEN_ROLE=canary requires TELECODEX_CANARY_MODE=true.");
  }

  if (tokenRole === "production" && canaryMode) {
    throw new Error("TELECODEX_TOKEN_ROLE=production cannot be used with TELECODEX_CANARY_MODE=true.");
  }

  if (tokenRole === "production" && !allowProductionPolling) {
    throw new Error("TELECODEX_TOKEN_ROLE=production requires TELECODEX_ALLOW_PRODUCTION_POLLING=true.");
  }

  return {
    tokenRole,
    canaryMode,
    allowProductionPolling,
    tokenFingerprint,
  };
}

export function fingerprintTelegramToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function parseTokenRole(raw: string | undefined): TelegramTokenRole {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return "unspecified";
  }

  switch (value) {
    case "development":
    case "canary":
    case "production":
      return value;
    default:
      throw new Error(
        `Invalid TELECODEX_TOKEN_ROLE: ${raw}. Expected development, canary, or production.`,
      );
  }
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`Invalid boolean env value: ${raw}`);
}
