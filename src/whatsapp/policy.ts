import { createHmac, timingSafeEqual } from "node:crypto";
import type { WhatsAppConfig } from "./config.js";

export const AGENT_PREFIX = "TeleCode:\n";

export function isSendApproval(text: string): boolean {
  return /^(?:send it|send that|send the message|send the draft|go ahead and send it|stuur maar|verstuur het)[.!]?$/iu.test(text.trim());
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  sender: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  /** Private chat of an authorized principal: an owner, or a guest when `guest` is set. */
  ownerChat?: string;
  guest?: boolean;
  mediaType?: string;
}

export function jidNumber(jid: unknown): string | undefined {
  if (typeof jid !== "string") return undefined;
  const match = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match?.[1];
}

export function recipientJid(value: string): string {
  const clean = value.trim();
  if (/^\d{7,15}@s\.whatsapp\.net$/.test(clean) || /^\d+(?:-\d+)?@g\.us$/.test(clean)) return clean;
  if (/^\+?[1-9]\d{6,14}$/.test(clean)) return clean.replace(/^\+/, "") + "@s.whatsapp.net";
  throw new Error("Use an exact international number or a chat JID from the chat list. Names are not send targets.");
}

export function isOwnerChat(jid: string, config: WhatsAppConfig): boolean {
  const number = jidNumber(jid);
  return !!number && (number === config.number || config.owners.includes(number));
}

export function guestFor(jid: string, config: WhatsAppConfig) {
  const number = jidNumber(jid);
  return number ? config.guests?.find((guest) => guest.number === number) : undefined;
}

/** Owners and granted guests may receive agent replies in their own private chat. */
export function isPrincipalChat(jid: string, config: WhatsAppConfig): boolean {
  return isOwnerChat(jid, config) || !!guestFor(jid, config);
}

export function verifySignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(actual, expected);
}

/** Only signed transport identity, never a name, quote, forwarded text or mention, grants owner access. */
export function parseWebhook(value: unknown, config: WhatsAppConfig, now = Date.now()): WhatsAppMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (event.event !== "message" || event.session_id !== config.deviceId || jidNumber(event.device_id) !== config.number) return undefined;
  if (!event.payload || typeof event.payload !== "object") return undefined;
  const p = event.payload as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id || p.id.length > 256 || typeof p.chat_id !== "string" ||
      typeof p.from !== "string" || typeof p.is_from_me !== "boolean") return undefined;
  if (!/^(?:\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(p.chat_id)) return undefined;
  const timestamp = typeof p.timestamp === "string" ? Date.parse(p.timestamp) : NaN;
  const message: WhatsAppMessage = {
    id: p.id, chatId: p.chat_id, sender: p.from, fromMe: p.is_from_me,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    body: typeof p.body === "string" ? p.body.slice(0, 100_000) : typeof p.caption === "string" ? p.caption.slice(0, 100_000) : "",
    mediaType: ["audio", "image", "video", "document"].find((key) => !!p[key]),
  };
  // History sync, groups, invalid dates, and future timestamps never become instructions.
  if (p.chat_id.endsWith("@g.us") || !Number.isFinite(timestamp) || now - timestamp > 10 * 60_000 || timestamp - now > 120_000) return message;
  const sender = jidNumber(p.from) ?? jidNumber(p.sender_alt);
  const chat = jidNumber(p.chat_id) ?? jidNumber(p.recipient_alt);
  if (message.fromMe) {
    if (sender === config.number && chat === config.number) {
      message.ownerChat = config.number + "@s.whatsapp.net";
    }
  } else if (sender && config.owners.includes(sender) && (chat === sender || (p.chat_id.endsWith("@lid") && !chat))) {
    message.ownerChat = sender + "@s.whatsapp.net";
  } else if (sender && config.guests?.some((guest) => guest.number === sender) && (chat === sender || (p.chat_id.endsWith("@lid") && !chat))) {
    message.ownerChat = sender + "@s.whatsapp.net";
    message.guest = true;
  }
  return message;
}

export function splitWhatsAppText(text: string, limit = 3500): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(""));
  return chunks;
}
