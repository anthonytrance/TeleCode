import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { WhatsAppMessage } from "./policy.js";
import type { WhatsAppAttachment } from "./media.js";

import type { AgentConversation } from "../routing/agent-selection.js";
export type { AgentBackend } from "../routing/agent-selection.js";
export type OwnerSession = AgentConversation;

export class WhatsAppStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        event_key TEXT PRIMARY KEY, message TEXT NOT NULL, owner_chat TEXT,
        status TEXT NOT NULL, received_at INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (chat TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (
        send_key TEXT PRIMARY KEY, chat TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, owner_chat TEXT NOT NULL, chat TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_at INTEGER, attachments TEXT NOT NULL DEFAULT '[]'
      );`);
    const draftColumns = this.db.prepare("PRAGMA table_info(drafts)").all();
    if (!draftColumns.some((row) => row.name === "reviewed_at")) this.db.exec("ALTER TABLE drafts ADD COLUMN reviewed_at INTEGER");
    if (!draftColumns.some((row) => row.name === "attachments")) this.db.exec("ALTER TABLE drafts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  }

  recover(): void {
    // Interrupted work may already have caused side effects. Never silently replay it.
    this.db.exec("UPDATE events SET status='interrupted' WHERE status='running'; UPDATE sends SET status='uncertain' WHERE status='sending'; UPDATE drafts SET status='uncertain' WHERE status='sending';");
  }

  record(message: WhatsAppMessage): boolean {
    const key = this.eventKey(message);
    return !!this.db.prepare("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, NULL)")
      .run(key, JSON.stringify(message), message.ownerChat ?? null, message.ownerChat ? "pending" : "inbox", Date.now()).changes;
  }

  eventKey(message: WhatsAppMessage): string { return `${message.chatId}:${message.id}`; }

  next(chat: string): WhatsAppMessage | undefined {
    const row = this.db.prepare("SELECT message FROM events WHERE owner_chat=? AND status='pending' ORDER BY received_at, rowid LIMIT 1").get(chat);
    return row ? JSON.parse(String(row.message)) as WhatsAppMessage : undefined;
  }

  pendingChats(): string[] {
    return this.db.prepare("SELECT DISTINCT owner_chat FROM events WHERE status='pending' AND owner_chat IS NOT NULL")
      .all().map((row) => String(row.owner_chat));
  }

  mark(message: WhatsAppMessage, status: string, error?: string): void {
    this.db.prepare("UPDATE events SET status=?, error=? WHERE event_key=?").run(status, error ?? null, this.eventKey(message));
  }

  session(chat: string): OwnerSession | undefined {
    const row = this.db.prepare("SELECT state FROM sessions WHERE chat=?").get(chat);
    return row ? JSON.parse(String(row.state)) as OwnerSession : undefined;
  }

  saveSession(chat: string, state: OwnerSession): void {
    this.db.prepare("INSERT INTO sessions VALUES (?, ?) ON CONFLICT(chat) DO UPDATE SET state=excluded.state").run(chat, JSON.stringify(state));
  }

  claimSend(key: string, chat: string, body: string, messageId?: string): boolean {
    return !!this.db.prepare("INSERT OR IGNORE INTO sends VALUES (?, ?, ?, 'sending', ?, ?)").run(key, chat, body, messageId ?? null, Date.now()).changes;
  }

  finishSend(key: string, messageId?: string): void {
    this.db.prepare("UPDATE sends SET status=?, message_id=COALESCE(?, message_id) WHERE send_key=?").run(messageId ? "sent" : "uncertain", messageId ?? null, key);
  }

  sent(key: string): { status: string; messageId?: string } | undefined {
    const row = this.db.prepare("SELECT status, message_id FROM sends WHERE send_key=?").get(key);
    return row ? { status: String(row.status), messageId: row.message_id ? String(row.message_id) : undefined } : undefined;
  }

  isEcho(message: WhatsAppMessage): boolean {
    if (!message.fromMe) return false;
    return !!this.db.prepare("SELECT 1 FROM sends WHERE message_id=? LIMIT 1").get(message.id);
  }

  draft(ownerChat: string, chat: string, body: string, attachments: WhatsAppAttachment[] = []): Record<string, unknown> {
    if ((!body.trim() && !attachments.length) || body.length > 3500 || attachments.length > 20) throw new Error("Drafts need text or attachments, with at most 3500 caption characters and 20 documents.");
    const id = randomUUID().slice(0, 12);
    this.db.prepare("INSERT INTO drafts (id, owner_chat, chat, body, status, created_at, attachments) VALUES (?, ?, ?, ?, 'draft', ?, ?)").run(id, ownerChat, chat, body, Date.now(), JSON.stringify(attachments));
    return this.getDraft(id)!;
  }

  getDraft(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id=?").get(id);
    return row ? { ...row, attachments: JSON.parse(String(row.attachments ?? "[]")) } : undefined;
  }

  markReviewed(id: string): void { this.db.prepare("UPDATE drafts SET reviewed_at=? WHERE id=? AND status='draft'").run(Date.now(), id); }

  singleReviewedDraft(owner: string): string {
    const rows = this.db.prepare("SELECT id FROM drafts WHERE owner_chat=? AND status='draft' AND reviewed_at>? ORDER BY reviewed_at DESC")
      .all(owner, Date.now() - 30 * 60_000);
    if (rows.length !== 1) throw new Error(rows.length ? "Several drafts are pending. Use /send DRAFT_ID to choose one." : "No recently displayed draft is waiting for approval. Ask me to prepare one first.");
    return String(rows[0].id);
  }

  claimDraft(id: string, owner: string): Record<string, unknown> {
    const row = this.getDraft(id);
    if (!row || row.owner_chat !== owner) throw new Error("No draft belongs to this owner conversation with that ID.");
    if (row.status !== "draft") throw new Error(`Draft is ${row.status}; it will not be sent again.`);
    if (Date.now() - Number(row.created_at) > 24 * 60 * 60_000) throw new Error("Draft expired. Prepare a fresh draft.");
    const claimed = this.db.prepare("UPDATE drafts SET status='sending' WHERE id=? AND status='draft'").run(id);
    if (!claimed.changes) throw new Error("Draft has already been claimed.");
    return row;
  }

  finishDraft(id: string, sent: boolean): void {
    this.db.prepare("UPDATE drafts SET status=? WHERE id=?").run(sent ? "sent" : "uncertain", id);
  }

  status(): Record<string, unknown> {
    return {
      events: this.db.prepare("SELECT status, COUNT(*) AS count FROM events GROUP BY status").all(),
      sends: this.db.prepare("SELECT status, COUNT(*) AS count FROM sends GROUP BY status").all(),
      drafts: this.db.prepare("SELECT status, COUNT(*) AS count FROM drafts GROUP BY status").all(),
    };
  }

  close(): void { this.db.close(); }
}
