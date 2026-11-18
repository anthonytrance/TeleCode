import { timingSafeEqual, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";
import type { WhatsAppAgent } from "./agent.js";
import type { WhatsAppConfig } from "./config.js";
import { GowaClient } from "./gowa.js";
import { AGENT_PREFIX, isOwnerChat, isPrincipalChat, isSendApproval, parseWebhook, recipientJid, splitWhatsAppText, verifySignature, type WhatsAppMessage } from "./policy.js";
import { WhatsAppStore } from "./store.js";
import { transcribeAudio } from "../voice.js";
import { statSync } from "node:fs";
import { snapshotAttachment, verifyAttachment, removeSnapshot, attachmentReview, VOICE_TRANSCRIPTION_LIMIT, type WhatsAppAttachment } from "./media.js";
import { requestedAgent } from "../routing/agent-selection.js";
import { TypingPresence } from "./presence.js";

const HELP = "WhatsApp agent. Say 'switch to Hermes' or 'switch to TeleCode', or use /agent hermes|telecode. Each keeps its own history. Commands: /status, /new, /provider codex|claude, /model NAME (TeleCode), /abort, /send DRAFT_ID. Other contacts cannot issue commands. Replies to other people require your draft approval.";

export class WhatsAppService {
  private server?: Server;
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Set<Promise<void>>();
  private readonly abortGeneration = new Map<string, number>();
  readonly typing: TypingPresence;

  constructor(readonly config: WhatsAppConfig, readonly store: WhatsAppStore, readonly gowa: GowaClient, readonly agent: WhatsAppAgent,
    private readonly transcribe: typeof transcribeAudio = transcribeAudio, private readonly outgoingRoot?: string) {
    this.typing = new TypingPresence(gowa);
  }

  async listen(port = this.config.port): Promise<number> {
    this.store.recover();
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) this.json(res, 500, { error: "WhatsApp request failed. Check local status." });
        else res.end();
      });
    });
    this.server.requestTimeout = 35_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => { this.server!.off("error", reject); resolve(); });
    });
    for (const chat of this.store.pendingChats()) this.wake(chat);
    return (this.server.address() as AddressInfo).port;
  }

  accept(value: unknown): boolean {
    const message = parseWebhook(value, this.config);
    if (!message || this.store.isEcho(message)) return false;
    if (!this.store.record(message)) return false;
    if (message.guest) {
      // Guests only reach their pinned agent through the TeleCode core. They never
      // reach drafts, sends or the legacy owner command path.
      if (!this.agent.commandsOwnedByCore) { this.store.mark(message, "failed", "Guest access needs the TeleCode core."); return true; }
      this.store.mark(message, "running");
      if (/^\/(?:abort|stop)(?:\s|$)/.test(message.body)) this.abortGeneration.set(message.ownerChat!, (this.abortGeneration.get(message.ownerChat!) ?? 0) + 1);
      const job = this.dispatchCore(message).finally(() => this.jobs.delete(job));
      this.jobs.add(job);
      return true;
    }
    if (message.ownerChat) {
      if (this.agent.commandsOwnedByCore && !/^\/send(?:\s|$)/.test(message.body) && (message.mediaType || !isSendApproval(message.body))) {
        this.store.mark(message, "running");
        if (/^\/(?:abort|stop)(?:\s|$)/.test(message.body)) this.abortGeneration.set(message.ownerChat, (this.abortGeneration.get(message.ownerChat) ?? 0) + 1);
        const job = this.dispatchCore(message).finally(() => this.jobs.delete(job));
        this.jobs.add(job);
        return true;
      }
      if (/^\/(?:abort|send|status|help)(?:\s|$)/.test(message.body) || (!message.mediaType && isSendApproval(message.body))) {
        this.store.mark(message, "running");
        const task = this.handleImmediate(message).catch(() => {
          this.store.mark(message, "failed", "Command or delivery failed; inspect status before retrying.");
        }).finally(() => this.jobs.delete(task));
        this.jobs.add(task);
      } else this.wake(message.ownerChat);
    }
    return true;
  }

  private async dispatchCore(message: WhatsAppMessage): Promise<void> {
    try {
      if (Date.now() - message.timestamp > 10 * 60_000) { this.store.mark(message, "expired"); return; }
      const generation = this.abortGeneration.get(message.ownerChat!) ?? 0;
      let text = message.body;
      let attachments: { imagePaths?: string[]; filePaths?: string[] } | undefined;
      if (message.mediaType) {
        const media = await this.gowa.download(message.id, message.chatId);
        const size = statSync(media.path).size;
        if (message.mediaType === "audio" && size <= VOICE_TRANSCRIPTION_LIMIT) text = (await this.transcribe(media.path)).text;
        else {
          attachments = message.mediaType === "image" && size < 20 * 1024 * 1024 ? { imagePaths: [media.path] } : { filePaths: [media.path] };
          if (!text.trim()) text = "Please describe the attached file.";
          if (text.startsWith("/")) text = "Owner attachment caption:\n" + text;
        }
      }
      if (this.stopping || generation !== (this.abortGeneration.get(message.ownerChat!) ?? 0)) throw new Error("Input preparation was aborted.");
      if (!message.guest && isSendApproval(text) && !attachments) await this.handleImmediate({ ...message, body: text });
      else await this.agent.run(message.ownerChat!, text, async (reply) => this.reply(message, "core-error", reply), attachments, this.store.eventKey(message));
      this.store.mark(message, "completed");
    } catch (error) {
      this.store.mark(message, "failed", "TeleCode dispatch failed; no automatic replay.");
      console.error("WhatsApp core dispatch failed:", error instanceof Error ? error.message : "unknown error");
      await this.reply(message, "core-failed", "TeleCode could not process this message. It was not retried automatically.").catch(() => {});
    }
  }

  async sendOwnerText(chat: string, text: string, key: string): Promise<string> {
    if (this.stopping || !isPrincipalChat(chat, this.config)) throw new Error("Channel delivery is not authorized.");
    const message: WhatsAppMessage = { id: `core:${key}`, chatId: chat, ownerChat: chat, sender: this.config.number + "@s.whatsapp.net", body: "", fromMe: true, timestamp: Date.now() };
    await this.reply(message, "text", text);
    this.typing.sent(chat);
    const sent = this.store.sent(`${this.store.eventKey(message)}:text:0`);
    if (sent?.status !== "sent" || !sent.messageId) throw new Error("WhatsApp delivery is uncertain. Do not automatically repeat it.");
    return sent.messageId;
  }

  async sendOwnerFile(chat: string, file: string, name: string, key: string): Promise<string> {
    if (this.stopping || !isPrincipalChat(chat, this.config)) throw new Error("Document delivery is not authorized.");
    const receiptKey = `core-document:${key}`;
    const previous = this.store.sent(receiptKey);
    if (previous?.status === "sent" && previous.messageId) return previous.messageId;
    if (previous || !this.store.claimSend(receiptKey, chat, JSON.stringify({ file, name }))) throw new Error("Document submission is uncertain; inspect it before repeating.");
    try {
      const files = await this.snapshotInput([file]);
      const draft = this.store.draft(chat, chat, "", files);
      const id = await this.sendDraft(String(draft.id), chat);
      this.store.finishSend(receiptKey, id);
      return id;
    } catch (error) { this.store.finishSend(receiptKey); throw error; }
  }

  private wake(chat: string): void {
    if (this.active.has(chat) || this.stopping || !isOwnerChat(chat, this.config)) return;
    const task = this.drain(chat).catch((error) => console.error("WhatsApp owner queue failed:", error instanceof Error ? error.message : "unknown error"))
      .finally(() => {
        this.active.delete(chat);
        if (!this.stopping && this.store.next(chat)) this.wake(chat);
      });
    this.active.set(chat, task);
  }

  private async drain(chat: string): Promise<void> {
    while (!this.stopping) {
      const message = this.store.next(chat);
      if (!message) return;
      this.store.mark(message, "running");
      if (this.agent.commandsOwnedByCore) { await this.dispatchCore(message); continue; }
      const generation = this.abortGeneration.get(chat) ?? 0;
      if (Date.now() - message.timestamp > 10 * 60_000) { this.store.mark(message, "expired"); continue; }
      let part = 0;
      const emit = (text: string) => this.reply(message, `reply:${part++}`, text);
      try {
        let input = message.body;
        let attachments: { imagePaths?: string[]; filePaths?: string[] } | undefined;
        if (message.mediaType) {
          const media = await this.gowa.download(message.id, message.chatId);
          if (message.mediaType === "audio" && (statSync(media.path, { throwIfNoEntry: false })?.size ?? 0) > VOICE_TRANSCRIPTION_LIMIT) {
            input = `${input}\nOwner audio attachment is too large for automatic transcription. Its original bytes are available at: ${media.path}`;
            attachments = { filePaths: [media.path] };
          } else if (message.mediaType === "audio") input = (await this.transcribe(media.path)).text;
          else if (message.mediaType === "image" && (statSync(media.path, { throwIfNoEntry: false })?.size ?? 0) < 20 * 1024 * 1024) attachments = { imagePaths: [media.path] };
          else attachments = { filePaths: [media.path] };
          if (!input.trim() && attachments) input = "Please describe the attached file.";
        }
        if (this.stopping || generation !== (this.abortGeneration.get(chat) ?? 0)) throw new Error("WhatsApp turn aborted while preparing input.");
        if (message.mediaType === "audio" && isSendApproval(input)) {
          await this.handleImmediate({ ...message, body: input });
          continue;
        }
        const switchTo = requestedAgent(input);
        const match = /^\/(new|provider|model|agent)(?:\s+(.*))?$/s.exec(input.trim());
        if (switchTo) {
          await emit(await this.agent.reset(chat, switchTo));
        } else
        if (match) {
          const [, command, argument] = match;
          if (command === "new") await emit(await this.agent.reset(chat));
          else if (command === "agent") {
            if (argument !== "hermes" && argument !== "telecode") throw new Error("Use /agent hermes or /agent telecode.");
            await emit(await this.agent.reset(chat, argument));
          } else if (command === "provider") {
            if (argument !== "codex" && argument !== "claude") throw new Error("Use /provider codex or /provider claude.");
            await emit(await this.agent.reset(chat, argument));
          } else {
            if (!argument?.trim() || argument.length > 200) throw new Error("Use /model MODEL_NAME.");
            await emit(await this.agent.reset(chat, undefined, argument.trim()));
          }
        } else if (!input.trim()) {
          await emit("I could not find text or a supported attachment in that message. Please send it again.");
        } else await this.agent.run(chat, input, emit, attachments, this.store.eventKey(message));
        this.store.mark(message, "completed");
      } catch (error) {
        this.store.mark(message, "failed", "Owner turn failed. No automatic replay.");
        console.error("WhatsApp owner turn failed:", error instanceof Error ? error.message : "unknown error");
        await this.reply(message, "error", "The turn failed. I have not retried it or switched agents automatically. Use /status to check for interrupted work or uncertain deliveries.").catch(() => {});
      }
    }
  }

  private async handleImmediate(message: WhatsAppMessage): Promise<void> {
    try {
      const [command, ...args] = message.body.trim().split(/\s+/);
      let response: string;
      if (command === "/abort") {
        const chat = message.ownerChat!;
        this.abortGeneration.set(chat, (this.abortGeneration.get(chat) ?? 0) + 1);
        await this.agent.abort(chat); response = "Abort requested for this owner conversation.";
      }
      else if (command === "/send" || isSendApproval(message.body)) {
        if (command === "/send" && args.length !== 1) throw new Error("Use /send DRAFT_ID after reviewing the draft.");
        const draftId = command === "/send" ? args[0] : this.store.singleReviewedDraft(message.ownerChat!);
        const id = await this.sendDraft(draftId, message.ownerChat!);
        response = `WhatsApp accepted the message. Message ID: ${id}.`;
      } else if (command === "/status") {
        response = JSON.stringify({ provider: this.store.session(message.ownerChat!)?.provider ?? this.config.provider, ...this.store.status() });
      } else response = HELP;
      await this.reply(message, "command", response);
      this.store.mark(message, "completed");
    } catch (error) {
      this.store.mark(message, "failed", "Command refused or delivery uncertain.");
      await this.reply(message, "command-error", error instanceof Error ? error.message : "Command failed.");
    }
  }

  private reply(message: WhatsAppMessage, key: string, text: string): Promise<void> {
    const chat = message.ownerChat!;
    const send = async () => {
      let chunk = 0;
      for (const body of splitWhatsAppText(text)) {
        const sendKey = `${this.store.eventKey(message)}:${key}:${chunk++}`;
        const nativeId = "3EB0" + randomBytes(14).toString("hex").toUpperCase();
        if (!this.store.claimSend(sendKey, chat, body, nativeId)) continue;
        try {
          const id = await this.gowa.send(chat, body, nativeId);
          this.store.finishSend(sendKey, id);
        } catch (error) { this.store.finishSend(sendKey); throw error; }
      }
    };
    const promise = this.sendQueue.then(send);
    this.sendQueue = promise.catch(() => {});
    return promise;
  }

  async sendDraft(id: string, owner: string): Promise<string> {
    const preview = this.store.getDraft(id);
    if (Array.isArray(preview?.attachments)) {
      for (const file of preview.attachments as WhatsAppAttachment[]) {
        if (!this.outgoingRoot) throw new Error("Document delivery storage is not configured.");
        await verifyAttachment(file, this.outgoingRoot);
      }
    }
    const draft = this.store.claimDraft(id, owner);
    const key = `draft:${id}`;
    if (!this.store.claimSend(key, String(draft.chat), String(draft.body))) throw new Error("This draft has already been submitted.");
    const send = async () => {
      try {
        const files = (Array.isArray(draft.attachments) ? draft.attachments : []) as WhatsAppAttachment[];
        const ids: string[] = [];
        if (files.length) {
          for (let index = 0; index < files.length; index++) {
            const partKey = `${key}:document:${index}`;
            const nativeId = "3EB0" + randomBytes(14).toString("hex").toUpperCase();
            if (!this.store.claimSend(partKey, String(draft.chat), JSON.stringify(files[index]), nativeId)) throw new Error("This document has already been submitted; inspect delivery before retrying.");
            try {
              const messageId = await this.gowa.sendDocument(String(draft.chat), files[index], index === 0 ? String(draft.body) : "", nativeId);
              this.store.finishSend(partKey, messageId); ids.push(messageId);
            } catch (error) { this.store.finishSend(partKey); throw error; }
          }
        } else {
          const nativeId = "3EB0" + randomBytes(14).toString("hex").toUpperCase();
          const partKey = `${key}:text`;
          if (!this.store.claimSend(partKey, String(draft.chat), String(draft.body), nativeId)) throw new Error("This message was already submitted.");
          try { const id = await this.gowa.send(String(draft.chat), String(draft.body), nativeId); this.store.finishSend(partKey, id); ids.push(id); }
          catch (error) { this.store.finishSend(partKey); throw error; }
        }
        const messageId = ids.join(", ");
        this.store.finishSend(key, messageId);
        this.store.finishDraft(id, true);
        for (const file of files) await removeSnapshot(file, this.outgoingRoot!).catch(() => console.warn("A sent WhatsApp snapshot could not be cleaned; its receipt remains recorded."));
        return messageId;
      } catch (error) {
        this.store.finishSend(key);
        this.store.finishDraft(id, false);
        throw error;
      }
    };
    const promise = this.sendQueue.then(send);
    this.sendQueue = promise.catch(() => {});
    return promise;
  }

  async idle(): Promise<void> { await Promise.all([...this.active.values(), ...this.jobs]); await this.sendQueue; }

  async close(): Promise<void> {
    this.stopping = true;
    const serverClosed = this.server ? new Promise<void>((resolve) => {
      this.server!.close(() => resolve()); this.server!.closeIdleConnections();
    }) : Promise.resolve();
    for (const chat of this.active.keys()) await this.agent.abort(chat).catch(() => {});
    await this.idle();
    await this.typing.close().catch(() => {});
    await this.agent.dispose();
    await serverClosed;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) { this.json(res, 503, { error: "WhatsApp is stopping." }); return; }
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? "")) { this.json(res, 400, { error: "Invalid host." }); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" && req.method === "GET") { this.json(res, 200, { service: "telecode-whatsapp", version: 1 }); return; }
    if (url.pathname === "/webhook" && req.method === "POST") {
      const bytes = await readBody(req);
      const signature = req.headers["x-hub-signature-256"];
      if (!verifySignature(bytes, typeof signature === "string" ? signature : undefined, this.config.webhookSecret)) {
        this.json(res, 401, { error: "Invalid signature." }); return;
      }
      const accepted = this.accept(JSON.parse(bytes.toString("utf8")));
      this.json(res, 202, { accepted }); return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.config.controlToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      this.json(res, 401, { error: "Local authentication required." }); return;
    }
    try {
      let result: unknown;
      if (req.method === "GET" && url.pathname === "/status") {
        let connected = false;
        try { await this.gowa.assertAccount(); connected = true; } catch {}
        result = { connected, agents: this.config.hermes ? ["telecode", "hermes"] : ["telecode"], defaultProvider: this.config.provider, documentLimit: 2_000_000_000, ...this.store.status() };
      } else if (req.method === "GET" && url.pathname === "/chats") {
        result = await this.gowa.chats(url.searchParams.get("search") ?? "", offset(url));
      } else if (req.method === "GET" && url.pathname === "/messages") {
        result = await this.gowa.messages(recipientJid(url.searchParams.get("chat") ?? ""), url.searchParams.get("search") ?? "", offset(url));
      } else if (req.method === "POST" && url.pathname === "/download") {
        const input = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        if (typeof input.messageId !== "string" || !input.messageId || input.messageId.length > 256) throw new Error("An exact message ID is required.");
        result = await this.gowa.download(input.messageId, recipientJid(String(input.chat ?? "")));
      } else if (req.method === "POST" && url.pathname === "/draft") {
        const input = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        const owner = input.ownerChat === "telegram" ? "telegram" : recipientJid(String(input.ownerChat ?? ""));
        if (owner !== "telegram" && !isOwnerChat(owner, this.config)) throw new Error("Draft owner must be a configured owner conversation.");
        const files = await this.snapshotInput(input.files);
        const draft = this.store.draft(owner, recipientJid(String(input.to ?? "")), String(input.text ?? ""), files);
        if (owner !== "telegram") {
          const review: WhatsAppMessage = { id: `draft-review-${draft.id}`, chatId: owner, sender: this.config.number + "@s.whatsapp.net", ownerChat: owner, body: "", fromMe: true, timestamp: Date.now() };
          await this.reply(review, "review", `Draft to ${draft.chat}:\n\n${draft.body}${files.length ? "\n\nDocuments:\n" + attachmentReview(files) : ""}\n\nReply "send it" to approve this draft, or use /send ${draft.id}.`);
          this.store.markReviewed(String(draft.id));
        }
        result = { ...this.store.getDraft(String(draft.id)), reviewDelivered: owner !== "telegram" };
      } else if (req.method === "POST" && url.pathname === "/deliver") {
        const input = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        const owner = recipientJid(String(input.ownerChat ?? ""));
        if (!isOwnerChat(owner, this.config) || input.requested !== true) throw new Error("Direct delivery is restricted to an owner's explicitly requested attachments.");
        const files = await this.snapshotInput(input.files);
        if (!files.length) throw new Error("At least one document is required.");
        const caption = String(input.caption ?? "");
        if (caption.length > 3500) throw new Error("Document caption is too long.");
        const draft = this.store.draft(owner, owner, caption, files);
        result = { messageId: await this.sendDraft(String(draft.id), owner), files };
      } else if (req.method === "POST" && url.pathname === "/confirm") {
        const input = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        // WhatsApp approvals only enter through an actual, signed owner /send message.
        // This local endpoint is for the existing trusted Telegram agent workflow.
        if (input.approved !== true) throw new Error("Explicit approval of the final draft is required.");
        result = { messageId: await this.sendDraft(String(input.id ?? ""), "telegram") };
      } else { this.json(res, 404, { error: "Unknown WhatsApp route." }); return; }
      this.json(res, 200, result);
    } catch (error) { this.json(res, 400, { error: error instanceof Error ? error.message : "Request refused." }); }
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }

  private async snapshotInput(value: unknown): Promise<WhatsAppAttachment[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string")) throw new Error("Provide at most 20 local document paths.");
    if (!value.length) return [];
    if (!this.outgoingRoot) throw new Error("Document delivery storage is not configured.");
    const files: WhatsAppAttachment[] = [];
    try {
      for (const file of value as string[]) files.push(await snapshotAttachment(file, this.outgoingRoot));
    } catch (error) {
      for (const file of files) await removeSnapshot(file, this.outgoingRoot).catch(() => {});
      throw error;
    }
    return files;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large.");
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function offset(url: URL): number {
  const value = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid offset.");
  return value;
}

export function acquireWhatsAppLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "listener.lock");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid WhatsApp listener lock; inspect it before clearing it.");
    let alive = true;
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("A WhatsApp listener already owns this state directory.");
    unlinkSync(file);
  }
  const fd = openSync(file, "wx", 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { if (existsSync(file) && readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file); };
}
