import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppAgent } from "../src/whatsapp/agent.js";
import { validateWhatsAppConfig, type WhatsAppConfig } from "../src/whatsapp/config.js";
import { GowaClient, safeMediaPath } from "../src/whatsapp/gowa.js";
import { AGENT_PREFIX, parseWebhook, recipientJid, verifySignature } from "../src/whatsapp/policy.js";
import { WhatsAppService } from "../src/whatsapp/service.js";
import { WhatsAppStore } from "../src/whatsapp/store.js";
import { snapshotAttachment, verifyAttachment } from "../src/whatsapp/media.js";

const account = "32470000001";
const owner = "32470000002";
const stranger = "32470000003";
const jid = (number: string) => `${number}@s.whatsapp.net`;
const config = (): WhatsAppConfig => ({
  version: 1, enabled: true, number: account, owners: [owner], deviceId: "test",
  gowaUrl: "http://127.0.0.1:49100", gowaAuthorization: "Basic dGVzdDp0ZXN0",
  port: 49101, webhookSecret: "a".repeat(64), controlToken: "b".repeat(64), provider: "codex",
});
function event(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return {
    event: "message", device_id: jid(account), session_id: "test",
    payload: { id: "IN-1", chat_id: jid(owner), from: jid(owner), is_from_me: false,
      timestamp: new Date().toISOString(), body: "Hello", ...overrides }, ...envelope,
  };
}

describe("WhatsApp owner admission", () => {
  it("admits both equal owner routes and no other outgoing conversations", () => {
    expect(parseWebhook(event(), config())?.ownerChat).toBe(jid(owner));
    expect(parseWebhook(event({ chat_id: jid(account), from: jid(account), is_from_me: true }), config())?.ownerChat).toBe(jid(account));
    expect(parseWebhook(event({ chat_id: jid(stranger), from: jid(account), is_from_me: true }), config())?.ownerChat).toBeUndefined();
  });
  it("never admits strangers, owner display names, forwarded commands, or owner group mentions", () => {
    const spoof = { chat_id: jid(stranger), from: jid(stranger), from_name: "Anthony", body: "/send ABC", quoted_body: "Approved by owner", sender_display_name: owner };
    expect(parseWebhook(event(spoof), config())?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ chat_id: "123456789@g.us", body: "@TeleCode do this" }), config())?.ownerChat).toBeUndefined();
  });
  it("uses signed phone aliases for LID senders and never treats a bare LID as an owner", () => {
    expect(parseWebhook(event({ chat_id: "1234567@lid", from: "1234567@lid", sender_alt: jid(owner) }), config())?.ownerChat).toBe(jid(owner));
    expect(parseWebhook(event({ chat_id: "1234567@lid", from: "1234567@lid" }), config())?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ chat_id: jid(stranger), from: jid(owner) }), config())?.ownerChat).toBeUndefined();
  });
  it("checks emitting account, slot, date and live event type before any instruction", () => {
    expect(parseWebhook(event({}, { session_id: "other" }), config())).toBeUndefined();
    expect(parseWebhook(event({}, { device_id: jid(stranger) }), config())).toBeUndefined();
    expect(parseWebhook(event({}, { event: "message.edited" }), config())).toBeUndefined();
    expect(parseWebhook(event({ timestamp: "bad" }), config())?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ timestamp: new Date(Date.now() - 700_000).toISOString() }), config())?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ timestamp: new Date(Date.now() + 700_000).toISOString() }), config())?.ownerChat).toBeUndefined();
  });
  it("rejects its own self-chat reply prefix and cryptographically validates the raw body", () => {
    expect(parseWebhook(event({ chat_id: jid(account), from: jid(account), is_from_me: true, body: AGENT_PREFIX + "Hello" }), config())?.ownerChat).toBe(jid(account));
    const bytes = Buffer.from(JSON.stringify(event()));
    const signature = "sha256=" + createHmac("sha256", config().webhookSecret).update(bytes).digest("hex");
    expect(verifySignature(bytes, signature, config().webhookSecret)).toBe(true);
    expect(verifySignature(Buffer.from("different"), signature, config().webhookSecret)).toBe(false);
    expect(verifySignature(bytes, "sha256=x", config().webhookSecret)).toBe(false);
  });
  it("rejects remote services, conflicting ports, public recipient surfaces, and owner/account confusion", () => {
    expect(() => validateWhatsAppConfig({ ...config(), gowaUrl: "http://example.com" })).toThrow(/loopback/);
    expect(() => validateWhatsAppConfig({ ...config(), owners: [account] })).toThrow(/self-chat/);
    expect(() => validateWhatsAppConfig({ ...config(), port: 49100 })).toThrow(/port/);
    expect(() => recipientJid("John")).toThrow(/exact/);
    expect(() => recipientJid("status@broadcast")).toThrow();
    expect(recipientJid("+" + stranger)).toBe(jid(stranger));
  });
  it("limits attachment paths to real files inside the private media directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecode-whatsapp-media-"));
    try {
      writeFileSync(path.join(root, "voice.ogg"), "audio fixture");
      expect(safeMediaPath(root, "voice.ogg")).toBe(path.join(root, "voice.ogg"));
      expect(() => safeMediaPath(root, "..")).toThrow(/outside/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("handles the real native API's null unpaired device list without trying to send", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "SUCCESS", results: null }), { status: 200 }));
    const gowa = new GowaClient(config(), fetcher as typeof fetch);
    await expect(gowa.send(jid(owner), "Do not send")).rejects.toThrow(/test number/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "telecode-whatsapp-"));
  const store = new WhatsAppStore(path.join(directory, "state.db"));
  const sent: Array<{ phone: string; message: string }> = [];
  const sentIds: string[] = [];
  const documents: Array<{ phone: string; local_file: string; local_sha256: string; caption: string; bytes: Buffer }> = [];
  let wrongAccount = false;
  let failSend = false;
  const backend = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== config().gowaAuthorization || req.headers["x-device-id"] !== "test") {
      res.writeHead(401); res.end("{}"); return;
    }
    let result: unknown;
    if (req.url === "/devices") result = [{ id: "test", jid: jid(wrongAccount ? stranger : account) }];
    else if (req.url === "/devices/test/status") result = { is_connected: true, is_logged_in: true };
    else if (req.url === "/send/message") {
      let body = ""; for await (const chunk of req) body += chunk;
      sent.push(JSON.parse(body));
      if (failSend) { res.writeHead(503); res.end("{}"); return; }
      const id = String(req.headers["x-telecode-message-id"] ?? `OUT-${sent.length}`); sentIds.push(id);
      result = { message_id: id };
    } else if (req.url === "/app/info") result = { version: "v9.9.0-telecode.3" };
    else if (req.url === "/send/file") {
      let body = ""; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const bytes = readFileSync(input.local_file);
      if (createHash("sha256").update(bytes).digest("hex") !== input.local_sha256) { res.writeHead(400); res.end("{}"); return; }
      documents.push({ ...input, bytes });
      result = { message_id: req.headers["x-telecode-message-id"] ?? `DOCUMENT-${documents.length}` };
    } else if (req.url?.startsWith("/chats?")) result = { data: [{ jid: jid(stranger), name: "Other person" }] };
    else if (req.url?.startsWith("/chat/")) result = { data: [{ content: "Ordinary contact text" }] };
    else { res.writeHead(404); res.end("{}"); return; }
    res.end(JSON.stringify({ code: "SUCCESS", results: result }));
  });
  const backendPort = await listen(backend);
  const cfg = { ...config(), gowaUrl: `http://127.0.0.1:${backendPort}` };
  const turns: Array<{ chat: string; text: string }> = [];
  const agent: WhatsAppAgent = {
    run: vi.fn(async (chat, text, emit) => { turns.push({ chat, text }); await emit("Agent reply"); }),
    abort: vi.fn(async () => {}), reset: vi.fn(async () => "Reset"), dispose: vi.fn(async () => {}),
  };
  mkdirSync(path.join(directory, "gowa"));
  const gowa = new GowaClient(cfg, fetch, path.join(directory, "gowa"));
  const transcribe = vi.fn(async () => ({ text: "Owner voice instruction", backend: "faster-whisper" as const, durationMs: 10 }));
  const service = new WhatsAppService(cfg, store, gowa, agent, transcribe, path.join(directory, "outgoing"));
  const port = await service.listen(0);
  const call = async (route: string, body?: unknown, authenticated = true) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? "POST" : "GET", headers: authenticated ? { Authorization: `Bearer ${cfg.controlToken}`, "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const webhook = async (value: unknown, valid = true) => {
    const body = JSON.stringify(value);
    const signature = "sha256=" + createHmac("sha256", valid ? cfg.webhookSecret : "wrong").update(body).digest("hex");
    return fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", headers: { "X-Hub-Signature-256": signature }, body });
  };
  return {
    directory, store, sent, sentIds, documents, cfg, turns, agent, gowa, service, call, webhook, transcribe,
    wrongAccount: () => { wrongAccount = true; }, failSend: () => { failSend = true; },
    close: async () => { await service.close(); store.close(); await close(backend); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe("WhatsApp HTTP and delivery integration, simulated WhatsApp backend", () => {
  it("processes authenticated agent switches in the owner queue without sending them to a model", async () => {
    const f = await fixture();
    try {
      await f.webhook(event({ id: "GUEST-SWITCH", chat_id: jid(stranger), from: jid(stranger), body: "/agent hermes" }));
      await f.webhook(event({ id: "OWNER-SWITCH", body: "switch to Hermes" }));
      await f.service.idle();
      expect(f.agent.reset).toHaveBeenCalledExactlyOnceWith(jid(owner), "hermes");
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(1);
      await f.webhook(event({ id: "OWNER-RETURN", body: "/agent telecode" }));
      await f.service.idle();
      expect(f.agent.reset).toHaveBeenLastCalledWith(jid(owner), "telecode");
    } finally { await f.close(); }
  });
  it("dispatches only the two owners, preserves their separate routes and ignores duplicates and echoes", async () => {
    const f = await fixture();
    try {
      expect((await f.webhook(event(), false)).status).toBe(401);
      await f.webhook(event({ chat_id: jid(stranger), from: jid(stranger), body: "/send draft", id: "STRANGER" }));
      await f.webhook(event());
      await f.service.idle();
      await f.webhook(event());
      await f.webhook(event({ id: "SELF", chat_id: jid(account), from: jid(account), is_from_me: true }));
      await f.service.idle();
      await f.webhook(event({ id: f.sentIds[1], chat_id: jid(account), from: jid(account), is_from_me: true, body: f.sent[1].message }));
      await f.service.idle();
      expect(f.turns.map((t) => t.chat)).toEqual([jid(owner), jid(account)]);
      expect(f.sent.map((s) => s.phone)).toEqual([jid(owner), jid(account)]);
      expect(f.sent.every((s) => s.message === "Agent reply")).toBe(true);
    } finally { await f.close(); }
  });
  it("protects local data and sends an exact immutable draft only after its owner approves", async () => {
    const f = await fixture();
    try {
      expect((await f.call("/chats", undefined, false)).status).toBe(401);
      expect((await f.call("/chats")).status).toBe(200);
      const draft = await (await f.call("/draft", { ownerChat: jid(owner), to: stranger, text: "Exact approved text" })).json() as { id: string };
      expect(f.sent.filter((s) => s.phone === jid(stranger))).toHaveLength(0);
      // Neither an untrusted contact nor the other owner lane can approve this draft.
      await f.webhook(event({ id: "BAD", from: jid(stranger), chat_id: jid(stranger), body: `/send ${draft.id}` }));
      await f.webhook(event({ id: "OTHER-OWNER", chat_id: jid(account), from: jid(account), is_from_me: true, body: `/send ${draft.id}` }));
      await f.service.idle();
      expect(f.sent.some((s) => s.phone === jid(stranger))).toBe(false);
      await f.webhook(event({ id: "APPROVAL", body: `/send ${draft.id}` }));
      await f.service.idle();
      await f.webhook(event({ id: "REPEAT", body: `/send ${draft.id}` }));
      await f.service.idle();
      expect(f.sent.filter((s) => s.phone === jid(stranger))).toEqual([{ phone: jid(stranger), message: "Exact approved text" }]);
      expect(f.turns).toHaveLength(0);
    } finally { await f.close(); }
  });
  it("keeps Telegram approval separate from WhatsApp owner approval", async () => {
    const f = await fixture();
    try {
      const draft = await (await f.call("/draft", { ownerChat: "telegram", to: stranger, text: "Telegram approved" })).json() as { id: string };
      expect((await f.call("/confirm", { id: draft.id })).status).toBe(400);
      expect((await f.call("/confirm", { id: draft.id, approved: true })).status).toBe(200);
      expect((await f.call("/confirm", { id: draft.id, approved: true })).status).toBe(400);
      expect(f.sent).toEqual([{ phone: jid(stranger), message: "Telegram approved" }]);
    } finally { await f.close(); }
  });
  it("accepts plain-language approval only for one displayed draft in the same owner route", async () => {
    const f = await fixture();
    try {
      await f.webhook(event({ id: "NO-DRAFT", body: "send it" }));
      await f.service.idle();
      expect(f.sent.some((s) => s.phone === jid(stranger))).toBe(false);
      const draft = await (await f.call("/draft", { ownerChat: jid(owner), to: stranger, text: "Reviewed exact text" })).json() as { id: string; reviewDelivered: boolean };
      expect(draft.reviewDelivered).toBe(true);
      expect(f.sent.some((s) => s.phone === jid(owner) && s.message.includes("Reviewed exact text"))).toBe(true);
      await f.webhook(event({ id: "NATURAL-APPROVAL", body: "send it" }));
      await f.service.idle();
      expect(f.sent.filter((s) => s.phone === jid(stranger))).toEqual([{ phone: jid(stranger), message: "Reviewed exact text" }]);
      expect(f.turns).toHaveLength(0);
    } finally { await f.close(); }
  });
  it("transcribes only authorized owner voice notes and passes owner images to the provider", async () => {
    const f = await fixture();
    try {
      const download = vi.spyOn(f.gowa, "download").mockResolvedValue({ path: "private-fixture.ogg", mediaType: "audio" });
      await f.webhook(event({ id: "CONTACT-AUDIO", chat_id: jid(stranger), from: jid(stranger), body: "", audio: "media" }));
      await f.service.idle();
      expect(download).not.toHaveBeenCalled();
      expect(f.transcribe).not.toHaveBeenCalled();
      await f.webhook(event({ id: "OWNER-AUDIO", body: "", audio: "media" }));
      await f.service.idle();
      expect(f.turns[0].text).toBe("Owner voice instruction");
      expect(f.transcribe).toHaveBeenCalledTimes(1);
      download.mockResolvedValue({ path: "private-fixture.png", mediaType: "image" });
      await f.webhook(event({ id: "OWNER-IMAGE", body: "Describe this", image: "media" }));
      await f.service.idle();
      expect(f.agent.run).toHaveBeenLastCalledWith(jid(owner), "Describe this", expect.any(Function), { imagePaths: ["private-fixture.png"] }, expect.any(String));
    } finally { await f.close(); }
  });
  it("refuses ambiguous natural approvals and permits an explicit spoken approval for one reviewed draft", async () => {
    const f = await fixture();
    try {
      const first = f.store.draft(jid(owner), jid(stranger), "First draft");
      const second = f.store.draft(jid(owner), jid(stranger), "Second draft");
      f.store.markReviewed(String(first.id)); f.store.markReviewed(String(second.id));
      await f.webhook(event({ id: "AMBIGUOUS", body: "send it" }));
      await f.service.idle();
      expect(f.sent.some((s) => s.phone === jid(stranger))).toBe(false);
      expect(f.sent.some((s) => s.message.includes("Several drafts"))).toBe(true);
      // Resolve the ambiguity by sending one exact draft, then approve the remaining one by voice.
      await f.service.sendDraft(String(first.id), jid(owner));
      vi.spyOn(f.gowa, "download").mockResolvedValue({ path: "private-approval.ogg", mediaType: "audio" });
      f.transcribe.mockResolvedValue({ text: "Send it.", backend: "faster-whisper", durationMs: 10 });
      await f.webhook(event({ id: "VOICE-APPROVAL", body: "", audio: "media" }));
      await f.service.idle();
      expect(f.sent.filter((s) => s.phone === jid(stranger)).map((s) => s.message)).toEqual(["First draft", "Second draft"]);
      expect(f.turns).toHaveLength(0);
    } finally { await f.close(); }
  });
  it("can abort while an owner's voice note is still being transcribed", async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.gowa, "download").mockResolvedValue({ path: "private-voice.ogg", mediaType: "audio" });
      let finish!: (value: { text: string; backend: "faster-whisper"; durationMs: number }) => void;
      f.transcribe.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      await f.webhook(event({ id: "SLOW-AUDIO", body: "", audio: "media" }));
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await f.webhook(event({ id: "ABORT-AUDIO", body: "/abort" }));
      finish({ text: "Do not execute this after abort", backend: "faster-whisper", durationMs: 10 });
      await f.service.idle();
      expect(f.agent.abort).toHaveBeenCalledWith(jid(owner));
      expect(f.turns).toHaveLength(0);
    } finally { await f.close(); }
  });
  it("blocks reading and sending if the paired account is wrong", async () => {
    const f = await fixture();
    try {
      f.wrongAccount();
      await expect(f.gowa.chats()).rejects.toThrow(/test number/);
      await expect(f.gowa.send(jid(owner), "Never send")).rejects.toThrow(/test number/);
      expect(f.sent).toHaveLength(0);
    } finally { await f.close(); }
  });
  it("does not resend uncertain deliveries, including after crash recovery", async () => {
    const f = await fixture();
    try {
      const draft = f.store.draft(jid(owner), jid(stranger), "Possibly accepted before timeout");
      f.failSend();
      await expect(f.service.sendDraft(String(draft.id), jid(owner))).rejects.toThrow(/503/);
      f.store.recover();
      await expect(f.service.sendDraft(String(draft.id), jid(owner))).rejects.toThrow(/uncertain/);
      expect(f.sent).toHaveLength(1);
      expect(f.store.getDraft(String(draft.id))?.status).toBe("uncertain");
    } finally { await f.close(); }
  });
  it("sends photos and videos as byte-identical documents from immutable reviewed snapshots", async () => {
    const f = await fixture();
    try {
      const originals = [path.join(f.directory, "photo.png"), path.join(f.directory, "video.mp4")];
      const bytes = [Buffer.from("original png fixture"), Buffer.from("original mp4 fixture")];
      originals.forEach((file, index) => writeFileSync(file, bytes[index]));
      const response = await f.call("/draft", { ownerChat: "telegram", to: stranger, text: "Approved caption", files: originals });
      const draft = await response.json() as { id: string; attachments: Array<{ path: string; delivery: string }> };
      expect(response.status).toBe(200);
      expect(draft.attachments.every((file) => file.delivery === "document")).toBe(true);
      writeFileSync(originals[1], "Original source changed after approval preview");
      expect(f.documents).toHaveLength(0);
      expect((await f.call("/confirm", { id: draft.id, approved: true })).status).toBe(200);
      expect(f.documents.map((file) => file.bytes)).toEqual(bytes);
      expect(f.documents.map((file) => path.basename(file.local_file))).toEqual(["photo.png", "video.mp4"]);
      expect(f.documents.map((file) => file.caption)).toEqual(["Approved caption", ""]);
    } finally { await f.close(); }
  });
  it("refuses modified snapshots and restricts direct attachment delivery to explicitly requesting owners", async () => {
    const f = await fixture();
    try {
      const source = path.join(f.directory, "original.mp4"); writeFileSync(source, "original bytes");
      const draft = await (await f.call("/draft", { ownerChat: "telegram", to: stranger, files: [source] })).json() as { id: string; attachments: Array<{ path: string }> };
      chmodSync(draft.attachments[0].path, 0o600); writeFileSync(draft.attachments[0].path, "changed bytes");
      expect((await f.call("/confirm", { id: draft.id, approved: true })).status).toBe(400);
      expect(f.documents).toHaveLength(0);
      expect((await f.call("/deliver", { ownerChat: jid(stranger), requested: true, files: [source] })).status).toBe(400);
      expect((await f.call("/deliver", { ownerChat: jid(owner), files: [source] })).status).toBe(400);
      expect((await f.call("/deliver", { ownerChat: jid(owner), requested: true, files: [source] })).status).toBe(200);
      expect(f.documents[0].phone).toBe(jid(owner));
      expect(f.documents[0].caption).toBe("");
    } finally { await f.close(); }
  });
  it("stages and verifies documents larger than both previous bridge limits without a whole-file buffer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecode-large-document-"));
    try {
      const source = path.join(root, "large-video.mp4");
      const fd = openSync(source, "wx"); ftruncateSync(fd, 64 * 1024 * 1024); closeSync(fd);
      const attachment = await snapshotAttachment(source, path.join(root, "outgoing"));
      expect(attachment.size).toBe(64 * 1024 * 1024);
      const hash = createHash("sha256"); for (let i = 0; i < 64; i++) hash.update(Buffer.alloc(1024 * 1024));
      expect(attachment.sha256).toBe(hash.digest("hex"));
      await expect(verifyAttachment(attachment, path.join(root, "outgoing"))).resolves.toBeUndefined();
      expect(attachment.delivery).toBe("document");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("recovers pending owner work, but never replays an interrupted turn", async () => {
    const f = await fixture();
    try {
      const message = parseWebhook(event({ id: "CRASHED" }), f.cfg)!;
      f.store.record(message); f.store.mark(message, "running");
      f.store.claimSend("pending-send", jid(owner), "A reply");
      f.store.recover();
      expect(f.store.next(jid(owner))).toBeUndefined();
      expect(f.store.status()).toMatchObject({ events: [{ status: "interrupted", count: 1 }], sends: [{ status: "uncertain", count: 1 }] });
    } finally { await f.close(); }
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
}
