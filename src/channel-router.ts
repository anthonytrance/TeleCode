import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { InputFile, type Api, type Bot, type Context } from "grammy";
import type { Update } from "grammy/types";
import type { CodexPromptInput } from "./codex-session.js";

export interface ChannelPort {
  kind: string;
  account: string;
  chat: string;
  label: string;
  documentLimit: number;
  authorize(): boolean;
  instructions: string;
  sendText(text: string, key: string): Promise<string>;
  sendDocument(file: string, name: string, key: string): Promise<string>;
  reactionsEnabled?(): boolean;
  setReactions?(enabled: boolean): void;
  react?(messageId: string, emoji: string): Promise<void>;
  /** Show "typing..." briefly. Callers repeat it every few seconds while busy. */
  typing?(): Promise<void>;
  typingEnabled?(): boolean;
  setTyping?(enabled: boolean): void;
  /** Present only for guests: the agents they may use and their private folder. */
  grant?: ChannelGrant;
}
export interface ChannelGrant { agents: string[]; workspace: string; name?: string }
interface ChannelInput {
  port: ChannelPort;
  imagePaths?: string[];
  filePaths?: string[];
}
interface ChannelMenu { entries: Array<{ label: string; data: string }>; messageId: number; expires: number }

/** Adapter addresses occupy a range outside Telegram's 52-bit chat-id space.
 * They are internal dispatcher addresses, never Telegram users or credentials. */
export function channelAddress(kind: string, account: string, chat: string): number {
  const hash = createHash("sha256").update(JSON.stringify([kind, account, chat])).digest("hex");
  return -8_000_000_000_000_000 - Number.parseInt(hash.slice(0, 12), 16);
}
const isChannelAddress = (id: unknown) => typeof id === "number" && id <= -8_000_000_000_000_000;

export class ChannelRouter {
  private readonly ports = new Map<number, ChannelPort>();
  private readonly inputs = new WeakMap<object, ChannelInput>();
  private readonly payloadKeys = new WeakMap<object, string>();
  private readonly nativeIds = new Map<string, string>();
  private readonly menus = new Map<number, ChannelMenu>();
  private nextMessage = 1;
  private nextUpdate = 1;

  install(bot: Bot<Context>): void {
    bot.api.config.use(async (previous, method, payload, signal) => {
      const data = payload as unknown as Record<string, any>;
      if (method === "answerCallbackQuery" && String(data.callback_query_id).startsWith("telecode-channel:")) return { ok: true, result: true } as any;
      const chatId = Number(data.chat_id);
      if (!isChannelAddress(chatId)) return previous(method, payload, signal);
      const port = this.ports.get(chatId);
      if (!port || !port.authorize()) throw new Error("Channel destination is not authorized. No Telegram fallback.");
      let key = this.payloadKeys.get(data);
      if (!key) { key = randomUUID(); this.payloadKeys.set(data, key); }
      if (method === "setMessageReaction") {
        const nativeId = this.nativeIds.get(`${chatId}:${data.message_id}`);
        if (nativeId && port.reactionsEnabled?.()) await port.react?.(nativeId, data.reaction?.[0]?.emoji ?? "");
        return { ok: true, result: true } as any;
      }
      if (method === "sendChatAction") {
        if (data.action === "typing" || data.action === "upload_document") void port.typing?.().catch(() => {});
        return { ok: true, result: true } as any;
      }
      if (method === "deleteMessage") return { ok: true, result: true } as any;
      if (method !== "sendMessage" && method !== "editMessageText" && method !== "editMessageReplyMarkup") throw new Error(`The ${port.label} transport does not support ${method}.`);
      if (method === "editMessageReplyMarkup") return { ok: true, result: true } as any;
      let text = plainChannelText(String(data.text ?? ""), data.parse_mode);
      const buttons = (data.reply_markup?.inline_keyboard ?? []).flat().filter((b: any) => typeof b.callback_data === "string" && b.callback_data !== "noop_page");
      const messageId = this.nextMessage++;
      if (buttons.length) {
        this.menus.set(chatId, { entries: buttons.map((b: any) => ({ label: b.text, data: b.callback_data })), messageId, expires: Date.now() + 10 * 60_000 });
        text += "\n\n" + buttons.map((b: any, i: number) => `${i + 1}. ${b.text}`).join("\n") + "\nReply with a button number to choose.";
      } else if (method === "sendMessage") this.menus.delete(chatId);
      const nativeId = await port.sendText(text, key);
      this.nativeIds.set(`${chatId}:${messageId}`, nativeId);
      return { ok: true, result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, text } } as any;
    });
  }

  bind(port: ChannelPort): number {
    const id = channelAddress(port.kind, port.account, port.chat);
    const previous = this.ports.get(id);
    if (previous && (previous.kind !== port.kind || previous.account !== port.account || previous.chat !== port.chat)) throw new Error("Channel address collision.");
    this.ports.set(id, port);
    return id;
  }

  async dispatch(bot: Bot<Context>, port: ChannelPort, text: string, attachments: { imagePaths?: string[]; filePaths?: string[] } = {}, nativeMessageId?: string): Promise<void> {
    if (!port.authorize()) throw new Error("Unauthorized channel author.");
    const chatId = this.bind(port), messageId = this.nextMessage++;
    if (nativeMessageId) this.nativeIds.set(`${chatId}:${messageId}`, nativeMessageId);
    const from = { id: chatId, is_bot: false, first_name: port.grant ? port.grant.name ?? port.label + " guest" : port.label + " owner" };
    const message = { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" as const, first_name: port.label }, from, text };
    const menu = this.menus.get(chatId);
    const hasFiles = !!(attachments.imagePaths?.length || attachments.filePaths?.length);
    let update: Update;
    if (!hasFiles && /^\d+$/.test(text.trim()) && menu && menu.expires > Date.now() && menu.entries[Number(text.trim()) - 1]) {
      this.menus.delete(chatId);
      update = { update_id: this.nextUpdate++, callback_query: { id: "telecode-channel:" + randomUUID(), from, chat_instance: String(chatId), data: menu.entries[Number(text.trim()) - 1].data, message: { ...message, message_id: menu.messageId } } };
    } else {
      const command = !hasFiles && /^\/[a-zA-Z0-9_]+(?:@\w+)?(?=\s|$)/.exec(text);
      update = { update_id: this.nextUpdate++, message: { ...message, ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}) } };
    }
    this.inputs.set(update, { port, ...attachments });
    await bot.handleUpdate(update);
  }

  authorized(ctx: Context): boolean { return this.inputs.get(ctx.update)?.port.authorize() === true; }
  label(ctx: Context): string { return this.inputs.get(ctx.update)?.port.label ?? "Telegram"; }
  isChannel(ctx: Context): boolean { return this.inputs.has(ctx.update); }
  grant(ctx: Context): ChannelGrant | undefined { return this.inputs.get(ctx.update)?.port.grant; }
  reactionsEnabled(ctx: Context): boolean { return this.inputs.get(ctx.update)?.port.reactionsEnabled?.() === true; }
  reactionSetting(ctx: Context, enabled?: boolean): boolean {
    const port = this.inputs.get(ctx.update)?.port;
    if (!port?.setReactions) throw new Error("This channel has no reaction setting.");
    if (enabled !== undefined) port.setReactions(enabled);
    return port.reactionsEnabled?.() === true;
  }
  typingSetting(ctx: Context, enabled?: boolean): boolean {
    const port = this.inputs.get(ctx.update)?.port;
    if (!port?.setTyping) throw new Error("This channel has no typing setting.");
    if (enabled !== undefined) port.setTyping(enabled);
    return port.typingEnabled?.() !== false;
  }
  /** "WhatsApp", "Telegram", ...: the chat a lane belongs to, for user-facing messages. */
  labelOf(chatId: string | number): string { return this.ports.get(Number(chatId))?.label ?? "Telegram"; }
  limit(chatId: string | number): number | undefined { return this.ports.get(Number(chatId))?.documentLimit; }

  prompt(ctx: Context, text: string): CodexPromptInput {
    const input = this.inputs.get(ctx.update);
    if (!input) return text;
    const files = [...input.imagePaths ?? [], ...input.filePaths ?? []];
    const who = input.port.grant ? "Guest" : "Owner";
    return { text: input.port.instructions + `\n\n${who} message:\n` + text,
      imagePaths: input.imagePaths,
      stagedFileInstructions: files.length ? `Original ${who.toLowerCase()} attachments on this computer:\n` + files.map((file) => JSON.stringify(file)).join("\n") : undefined };
  }

  async sendDocument(api: Api, chatId: string | number, file: string, name = path.basename(file), options: Record<string, any> = {}): Promise<unknown> {
    const port = this.ports.get(Number(chatId));
    if (!port) {
      if (isChannelAddress(Number(chatId))) throw new Error("Channel destination is unavailable.");
      return api.sendDocument(chatId, new InputFile(file, name), options);
    }
    if (!port.authorize()) throw new Error("Channel delivery is no longer authorized.");
    return port.sendDocument(file, name, randomUUID());
  }
}

export function plainChannelText(text: string, mode?: string): string {
  if (mode !== "HTML") return text;
  return text.replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gs, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
