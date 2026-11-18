import { createHash } from "node:crypto";
import type { WhatsAppConfig } from "./config.js";

/** Calls the existing full Hermes gateway, never a second WhatsApp listener. */
export class HermesGateway {
  constructor(private readonly config: NonNullable<WhatsAppConfig["hermes"]>) {}

  async createSession(signal: AbortSignal): Promise<string> {
    const response = await fetch(new URL("/api/sessions", this.config.url), {
      method: "POST", headers: this.headers(), signal,
      body: JSON.stringify({ source: "api_server", title: `WhatsApp ${new Date().toISOString()}` }),
    });
    if (!response.ok) throw new Error(`Hermes session creation failed (${response.status}).`);
    const data = await response.json() as { session?: { id?: string } };
    if (!data.session?.id || /[\r\n\x00]/.test(data.session.id)) throw new Error("Hermes returned no valid session ID.");
    return data.session.id;
  }

  async run(input: { sessionId: string; scope: string; requestId: string; prompt: string; signal: AbortSignal }, emit: (text: string) => Promise<void>): Promise<void> {
    const response = await fetch(new URL("/v1/chat/completions", this.config.url), {
      method: "POST", signal: input.signal,
      headers: { ...this.headers(), "X-Hermes-Session-Id": input.sessionId,
        "X-Hermes-Session-Key": input.scope,
        "Idempotency-Key": createHash("sha256").update(input.scope + "\0" + input.requestId).digest("hex") },
      body: JSON.stringify({ model: "hermes-agent", stream: true, messages: [{ role: "user", content: input.prompt }] }),
    });
    if (!response.ok || !response.body) throw new Error(`Hermes gateway refused the turn (${response.status}).`);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Hermes returned an unexpected stream format.");
    let buffer = "", finish: string | undefined, done = false;
    const flush = async () => { const text = buffer.trim(); buffer = ""; if (text) await emit(text); };
    for await (const frame of sseFrames(response.body)) {
      if (frame.data === "[DONE]") { done = true; break; }
      if (frame.event === "hermes.tool.progress") { await flush(); continue; }
      if (frame.event && frame.event !== "message") continue;
      const value = JSON.parse(frame.data) as { error?: unknown; choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> };
      if (value.error) throw new Error("Hermes reported an agent error. The turn was not retried.");
      for (const choice of value.choices ?? []) {
        // Never relay reasoning_content or tool arguments as assistant narration.
        if (typeof choice.delta?.content === "string") buffer += choice.delta.content;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    if (!done || !finish || !["stop", "length"].includes(finish)) throw new Error("Hermes stopped without a successful terminal result. No automatic retry.");
    await flush();
    if (finish === "length") await emit("Hermes reached its turn limit. Its answer may be incomplete.");
  }

  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" }; }
}

/** UTF-8 and SSE records can cross arbitrary network chunk boundaries. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = "", event = "", lines: string[] = [], recordSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
        if (!line) {
          if (lines.length) yield { event, data: lines.join("\n") };
          event = ""; lines = []; recordSize = 0;
        } else if (!line.startsWith(":")) {
          recordSize += line.length;
          if (recordSize > 4 * 1024 * 1024) throw new Error("Hermes stream record is too large.");
          const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") lines.push(value);
        }
      }
      if (pending.length > 4 * 1024 * 1024) throw new Error("Hermes stream line is too large.");
      if (chunk.done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
