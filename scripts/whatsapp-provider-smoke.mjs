// Bounded live provider check. No WhatsApp transport is created and no message is sent.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { WhatsAppProviderAgent } from "../dist/whatsapp/agent.js";
import { WhatsAppStore } from "../dist/whatsapp/store.js";
import { readWhatsAppConfig, whatsappDirectory } from "../dist/whatsapp/config.js";

const provider = process.argv[2] ?? "codex";
assert.ok(["codex", "claude", "hermes"].includes(provider), "Use codex, claude or hermes.");
const config = loadConfig();
const root = mkdtempSync(path.join(tmpdir(), "telecode-whatsapp-provider-"));
const store = new WhatsAppStore(path.join(root, "state.db"));
const whatsapp = provider === "hermes" ? readWhatsAppConfig(whatsappDirectory(config.workspace)) : { provider };
assert.ok(whatsapp && (provider !== "hermes" || whatsapp.hermes), "Configure the Hermes gateway first.");
let agent = new WhatsAppProviderAgent(config, whatsapp, store);
const owner = "32470000002@s.whatsapp.net";
const token = "WHATSAPP_" + randomBytes(8).toString("hex");
const fixture = path.join(root, "gateway-read-canary.txt");
if (provider === "hermes") { store.saveSession(owner, { provider: "hermes" }); writeFileSync(fixture, token); }
const timer = setTimeout(() => { void agent.abort(owner); }, 100_000);
try {
  const first = [];
  await agent.run(owner, provider === "hermes"
    ? `Read-only gateway connectivity test. Use your file or terminal tool to read ${JSON.stringify(fixture)}. Remember the exact token inside and reply with it. Do not create or edit files, update memory, or send messages through any messaging tools.`
    : `Provider connectivity test only. Do not call tools, create files or send messages. Remember this token and reply with it exactly: ${token}`, async (text) => { first.push(text); });
  assert.ok(first.some((text) => text.includes(token)), "First provider turn did not return the token.");
  assert.ok(store.session(owner)?.providerSessionId, "Provider session ID was not persisted.");
  await agent.dispose();
  agent = new WhatsAppProviderAgent(config, whatsapp, store);
  const second = [];
  await agent.run(owner, "Continue the connectivity test without tools. What exact token did I ask you to remember in my preceding message? Reply only with that token.", async (text) => { second.push(text); });
  assert.ok(second.some((text) => text.includes(token)), "Resumed provider turn lost conversation context.");
  console.log(JSON.stringify({ provider, firstTurn: "passed", ...(provider === "hermes" ? { gatewayFileTool: "passed" } : {}), coldResume: "passed", sessionPersisted: true, whatsappMessagesSent: 0 }));
} finally {
  clearTimeout(timer);
  await agent.dispose();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
