import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** A non-owner number allowed to use only the listed agents: "codex", "claude",
 * "hermes" (default Hermes agent) or "hermes:PROFILE" (a named Hermes agent with
 * its own gateway, config and tool permissions). The first entry is the agent a
 * guest starts with. Guests never get WhatsApp tools, drafts, third-party sends,
 * workspace switching or TeleCode settings. */
export interface WhatsAppGuest {
  number: string;
  name?: string;
  agents: string[];
  /** Working folder for the guest's agent. Defaults to a private per-guest folder. */
  workspace?: string;
}

export const GUEST_AGENT = /^(?:codex|claude|hermes(?::[a-z0-9][a-z0-9_-]{0,63})?)$/;

export interface WhatsAppConfig {
  version: 1;
  enabled: boolean;
  number: string;
  owners: string[];
  deviceId: string;
  gowaUrl: string;
  gowaAuthorization: string;
  port: number;
  webhookSecret: string;
  controlToken: string;
  provider: "codex" | "claude";
  reactionsEnabled?: boolean;
  /** WhatsApp "typing..." while an agent works. On unless explicitly false. */
  typingEnabled?: boolean;
  hermes?: { url: string; apiKey: string };
  guests?: WhatsAppGuest[];
}

export function phoneNumber(value: string): string {
  const number = value.replace(/^\+/, "").replace(/[ ()-]/g, "");
  if (!/^[1-9]\d{6,14}$/.test(number)) throw new Error("Use an international phone number with country code.");
  return number;
}

export function whatsappDirectory(workspace: string): string {
  return path.resolve(process.env.TELECODE_WHATSAPP_DIR || path.join(workspace, ".telecode", "whatsapp"));
}

export function localUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The WhatsApp service must use an http://127.0.0.1:PORT loopback URL.");
  }
  return url;
}

export function validateWhatsAppConfig(value: WhatsAppConfig): WhatsAppConfig {
  if (value.version !== 1 || typeof value.enabled !== "boolean") throw new Error("Invalid WhatsApp config version or enabled flag.");
  const number = phoneNumber(value.number);
  if (!Array.isArray(value.owners) || !value.owners.length) throw new Error("At least one external owner number is required.");
  const owners = [...new Set(value.owners.map(phoneNumber))];
  if (owners.includes(number)) throw new Error("The linked number has its own self-chat route; put your other number in owners.");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value.deviceId)) throw new Error("Invalid WhatsApp device slot.");
  localUrl(value.gowaUrl);
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      Number(new URL(value.gowaUrl).port || 80) === value.port) throw new Error("Invalid or conflicting WhatsApp listener port.");
  if (!/^Basic [a-zA-Z0-9+/]+=*$/.test(value.gowaAuthorization)) throw new Error("GOWA Basic authentication is required.");
  for (const secret of [value.webhookSecret, value.controlToken]) {
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid WhatsApp local secret.");
  }
  if (!["codex", "claude"].includes(value.provider)) throw new Error("Invalid WhatsApp provider.");
  if (value.typingEnabled !== undefined && typeof value.typingEnabled !== "boolean") throw new Error("Invalid WhatsApp typing setting.");
  if (value.reactionsEnabled !== undefined && typeof value.reactionsEnabled !== "boolean") throw new Error("Invalid WhatsApp reaction setting.");
  const guests: WhatsAppGuest[] = [];
  if (value.guests !== undefined) {
    if (!Array.isArray(value.guests)) throw new Error("WhatsApp guests must be a list.");
    for (const guest of value.guests) {
      const guestNumber = phoneNumber(String(guest?.number ?? ""));
      if (guestNumber === number || owners.includes(guestNumber)) throw new Error(`Guest ${guestNumber} is already an owner or the linked number.`);
      if (guests.some((g) => g.number === guestNumber)) throw new Error(`Guest ${guestNumber} is listed twice.`);
      if (!Array.isArray(guest.agents) || !guest.agents.length || guest.agents.some((a) => typeof a !== "string" || !GUEST_AGENT.test(a))) {
        throw new Error(`Guest ${guestNumber} needs a list of agents: codex, claude, hermes or hermes:PROFILE (lowercase).`);
      }
      if (guest.name !== undefined && (typeof guest.name !== "string" || guest.name.length > 80)) throw new Error(`Invalid name for guest ${guestNumber}.`);
      if (guest.workspace !== undefined && (typeof guest.workspace !== "string" || !path.isAbsolute(guest.workspace))) throw new Error(`Guest ${guestNumber} workspace must be an absolute folder path.`);
      guests.push({ number: guestNumber, agents: [...new Set(guest.agents)], ...(guest.name ? { name: guest.name } : {}), ...(guest.workspace ? { workspace: guest.workspace } : {}) });
    }
  }
  if (value.hermes) {
    localUrl(value.hermes.url);
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(value.hermes.apiKey)) throw new Error("A strong Hermes API key is required.");
    if ([value.port, Number(new URL(value.gowaUrl).port || 80)].includes(Number(new URL(value.hermes.url).port || 80))) throw new Error("Hermes must use a separate local port.");
  }
  return { ...value, number, owners, ...(value.guests !== undefined ? { guests } : {}) };
}

export function readWhatsAppConfig(directory: string): WhatsAppConfig | undefined {
  const file = path.join(directory, "config.json");
  if (!existsSync(file)) return undefined;
  return validateWhatsAppConfig(JSON.parse(readFileSync(file, "utf8")) as WhatsAppConfig);
}

export function initializeWhatsApp(directory: string, number: string, owner: string, gowaPort: number, port: number): WhatsAppConfig {
  if (existsSync(path.join(directory, "config.json"))) throw new Error("WhatsApp is already configured. Existing credentials were preserved.");
  const password = randomBytes(32).toString("hex");
  const config = validateWhatsAppConfig({
    version: 1, enabled: true, number, owners: [owner], deviceId: "telecode-test",
    gowaUrl: `http://127.0.0.1:${gowaPort}`, port,
    gowaAuthorization: `Basic ${Buffer.from(`telecode:${password}`).toString("base64")}`,
    webhookSecret: randomBytes(32).toString("hex"), controlToken: randomBytes(32).toString("hex"), provider: "codex",
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = /S-1-\d+(?:-\d+)+/.exec(identity)?.[0];
    if (!sid) throw new Error("Cannot establish the current Windows identity for private WhatsApp storage.");
    execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/T", "/Q"], { windowsHide: true, stdio: "pipe" });
  }
  writeFileSync(path.join(directory, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return config;
}
