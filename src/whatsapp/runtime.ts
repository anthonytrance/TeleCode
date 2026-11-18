import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { TeleCodeConfig } from "../config.js";
import { WhatsAppCoreAgent } from "./core-agent.js";
import type { TeleCodeBot } from "../bot.js";
import type { SessionRegistry } from "../session-registry.js";
import { readWhatsAppConfig, whatsappDirectory } from "./config.js";
import { GowaClient } from "./gowa.js";
import { acquireWhatsAppLock, WhatsAppService } from "./service.js";
import { WhatsAppStore } from "./store.js";
import { ensureNativeWhatsApp } from "./native-runtime.js";

export async function startWhatsApp(config: TeleCodeConfig, core?: { bot: TeleCodeBot; registry: SessionRegistry }): Promise<{ close(): Promise<void> } | undefined> {
  const directory = whatsappDirectory(config.workspace);
  const whatsapp = readWhatsAppConfig(directory);
  if (!whatsapp?.enabled) return undefined;
  if (!core) throw new Error("WhatsApp requires the main TeleCode command core. Start the normal bridge instead of a standalone agent listener.");
  const release = acquireWhatsAppLock(directory);
  let store: WhatsAppStore | undefined;
  let service: WhatsAppService | undefined;
  try {
    const gowa = new GowaClient(whatsapp, fetch, path.join(directory, "gowa"));
    await ensureNativeWhatsApp(directory, config.workspace, gowa);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "bridge.db");
    store = new WhatsAppStore(file);
    if (existsSync(file)) chmodSync(file, 0o600);
    const agent = new WhatsAppCoreAgent(core.bot, core.registry, whatsapp, config.workspace);
    service = new WhatsAppService(whatsapp, store, gowa, agent, undefined, path.join(directory, "outgoing"));
    agent.service = service;
    agent.bind();
    await service.listen();
    console.log("TeleCode WhatsApp listener ready. Linked-device connection is checked separately.");
    return { close: async () => {
      try { await service!.close(); } finally { store!.close(); release(); }
    } };
  } catch (error) {
    await service?.close().catch(() => {});
    store?.close(); release(); throw error;
  }
}
