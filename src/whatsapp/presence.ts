/** Shows WhatsApp "typing..." while an agent works for an owner chat.
 *
 * TeleCode's turn loops ask for typing every few seconds. WhatsApp drops chat
 * presence from an account that is "unavailable", so the linked account goes
 * available for the duration of the work and back to unavailable afterwards,
 * keeping it from appearing permanently online. */
export interface PresenceTransport {
  presence(type: "available" | "unavailable"): Promise<void>;
  chatPresence(chat: string, action: "start" | "stop"): Promise<void>;
}

export class TypingPresence {
  private available = false;
  private readonly chats = new Map<string, { sentAt: number; stop: NodeJS.Timeout }>();
  private offline?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: PresenceTransport, private readonly options = { refreshMs: 8_000, idleMs: 9_000, offlineMs: 2_000 }) {}

  /** Called on every typing request; refreshes at most every refreshMs. */
  typing(chat: string): Promise<void> {
    const now = Date.now();
    const current = this.chats.get(chat);
    if (current) clearTimeout(current.stop);
    if (this.offline) { clearTimeout(this.offline); this.offline = undefined; }
    const due = !current || now - current.sentAt >= this.options.refreshMs;
    const stop = setTimeout(() => void this.stop(chat), this.options.idleMs);
    stop.unref?.();
    this.chats.set(chat, { sentAt: due ? now : current!.sentAt, stop });
    if (!due) return Promise.resolve();
    return this.run(async () => {
      if (!this.available) { await this.transport.presence("available"); this.available = true; }
      await this.transport.chatPresence(chat, "start");
    });
  }

  /** A delivered message already clears "typing..." on the recipient's phone.
   * Forget the chat so the next request from a still-running turn restarts it. */
  sent(chat: string): void {
    const current = this.chats.get(chat);
    if (!current) return;
    clearTimeout(current.stop);
    this.chats.delete(chat);
    this.scheduleOffline();
  }

  /** Clears typing in one chat, e.g. once no turn has asked for it recently. */
  stop(chat: string): Promise<void> {
    const current = this.chats.get(chat);
    if (!current) return Promise.resolve();
    clearTimeout(current.stop);
    this.chats.delete(chat);
    this.scheduleOffline();
    return this.run(() => this.transport.chatPresence(chat, "stop"));
  }

  private scheduleOffline(): void {
    if (this.chats.size || this.offline || !this.available) return;
    this.offline = setTimeout(() => {
      this.offline = undefined;
      if (!this.chats.size && this.available) void this.run(async () => { await this.transport.presence("unavailable"); this.available = false; }).catch(() => {});
    }, this.options.offlineMs);
    this.offline.unref?.();
  }

  async close(): Promise<void> {
    for (const chat of [...this.chats.keys()]) await this.stop(chat).catch(() => {});
    if (this.offline) clearTimeout(this.offline);
    this.offline = undefined;
    if (this.available) await this.run(async () => { await this.transport.presence("unavailable"); this.available = false; }).catch(() => {});
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
}
