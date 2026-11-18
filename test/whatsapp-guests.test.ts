import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppAgent } from "../src/whatsapp/agent.js";
import { GowaClient } from "../src/whatsapp/gowa.js";
import { WhatsAppService } from "../src/whatsapp/service.js";
import { WhatsAppStore } from "../src/whatsapp/store.js";
import { validateWhatsAppConfig, type WhatsAppConfig } from "../src/whatsapp/config.js";
import { isOwnerChat, isPrincipalChat, parseWebhook } from "../src/whatsapp/policy.js";

const account = "32470000001", owner = "32470000002", guest = "32470000009", stranger = "32470000003";
const jid = (number: string) => `${number}@s.whatsapp.net`;
const config = (guests: WhatsAppConfig["guests"] = [{ number: guest, name: "Social team", agents: ["hermes:social", "claude"] }]): WhatsAppConfig => ({
  version: 1, enabled: true, number: account, owners: [owner], deviceId: "test",
  gowaUrl: "http://127.0.0.1:49100", gowaAuthorization: "Basic dGVzdDp0ZXN0",
  port: 49101, webhookSecret: "a".repeat(64), controlToken: "b".repeat(64), provider: "codex", guests,
});
const event = (payload: Record<string, unknown>) => ({
  event: "message", device_id: jid(account), session_id: "test",
  payload: { id: "IN-1", chat_id: jid(guest), from: jid(guest), is_from_me: false, timestamp: new Date().toISOString(), body: "Hello", ...payload },
});

describe("WhatsApp guests", () => {
  it("accepts any provider list and rejects owners, duplicates and unknown agents", () => {
    expect(validateWhatsAppConfig(config()).guests).toEqual([{ number: guest, name: "Social team", agents: ["hermes:social", "claude"] }]);
    expect(validateWhatsAppConfig(config([{ number: "+32 470 00 00 09", agents: ["codex", "hermes"] }])).guests?.[0].number).toBe(guest);
    expect(() => validateWhatsAppConfig(config([{ number: owner, agents: ["hermes"] }]))).toThrow(/owner/);
    expect(() => validateWhatsAppConfig(config([{ number: account, agents: ["hermes"] }]))).toThrow(/owner/);
    expect(() => validateWhatsAppConfig(config([{ number: guest, agents: ["hermes"] }, { number: guest, agents: ["claude"] }]))).toThrow(/twice/);
    expect(() => validateWhatsAppConfig(config([{ number: guest, agents: [] }]))).toThrow(/agents/);
    expect(() => validateWhatsAppConfig(config([{ number: guest, agents: ["gpt"] }]))).toThrow(/agents/);
    expect(() => validateWhatsAppConfig(config([{ number: guest, agents: ["hermes:../x"] }]))).toThrow(/agents/);
    expect(() => validateWhatsAppConfig(config([{ number: guest, agents: ["hermes"], workspace: "relative" }]))).toThrow(/absolute/);
  });

  it("marks only a guest's own private chat as a guest principal", () => {
    const c = config();
    const message = parseWebhook(event({}), c);
    expect(message?.ownerChat).toBe(jid(guest));
    expect(message?.guest).toBe(true);
    expect(parseWebhook(event({ chat_id: jid(owner), from: jid(owner) }), c)?.guest).toBeUndefined();
    expect(parseWebhook(event({ chat_id: jid(stranger) }), c)?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ chat_id: "123456789@g.us" }), c)?.ownerChat).toBeUndefined();
    expect(parseWebhook(event({ from: jid(stranger), chat_id: jid(stranger) }), c)?.ownerChat).toBeUndefined();
    // The linked phone itself writing into the guest chat is not the guest speaking.
    expect(parseWebhook(event({ from: jid(account), is_from_me: true }), c)?.ownerChat).toBeUndefined();
    expect(isPrincipalChat(jid(guest), c)).toBe(true);
    expect(isOwnerChat(jid(guest), c)).toBe(false);
    expect(isPrincipalChat(jid(stranger), c)).toBe(false);
  });

  it("sends guest messages, including send approvals, only to the core agent", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telecode-guest-"));
    const store = new WhatsAppStore(path.join(directory, "state.db"));
    const runs: Array<{ chat: string; text: string }> = [];
    const make = (core: boolean): WhatsAppAgent => ({
      ...(core ? { commandsOwnedByCore: true } : {}),
      run: vi.fn(async (chat: string, text: string) => { runs.push({ chat, text }); }),
      abort: vi.fn(async () => {}), reset: vi.fn(async () => "Reset"), dispose: vi.fn(async () => {}),
    }) as WhatsAppAgent;
    const c = config();
    const gowa = new GowaClient(c, vi.fn(async () => { throw new Error("no network in this test"); }) as any, directory);
    const service = new WhatsAppService(c, store, gowa, make(true));
    try {
      for (const [index, body] of ["send it", "/send 1", "hello"].entries()) {
        expect(service.accept(event({ id: `G-${index}`, body }))).toBe(true);
      }
      await vi.waitFor(() => expect(runs.map((run) => run.text).sort()).toEqual(["/send 1", "hello", "send it"]));
      expect(runs.every((run) => run.chat === jid(guest))).toBe(true);
      await expect(service.sendOwnerText(jid(stranger), "x", "k")).rejects.toThrow(/not authorized/);
      const legacy = new WhatsAppService(c, store, gowa, make(false));
      expect(legacy.accept(event({ id: "G-legacy", body: "hello" }))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(3);
      await legacy.close(); await service.close();
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
    }, 30_000);
});
