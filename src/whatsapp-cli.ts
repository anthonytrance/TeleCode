import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { initializeWhatsApp, readWhatsAppConfig, whatsappDirectory } from "./whatsapp/config.js";
import { GowaClient } from "./whatsapp/gowa.js";
import { localJsonRequest } from "./whatsapp/http.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" }, number: { type: "string" }, owner: { type: "string" },
      "owner-chat": { type: "string" }, to: { type: "string" }, "text-file": { type: "string" },
      file: { type: "string", multiple: true }, caption: { type: "string" }, requested: { type: "boolean" },
      chat: { type: "string" }, message: { type: "string" }, search: { type: "string" }, offset: { type: "string" },
      approved: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log("TeleCode WhatsApp: init --number TEST --owner ACTUAL; configure-gowa; pair-code; pair-qr; status; chats; messages --chat JID; download --chat JID --message ID; draft --to NUMBER (--text-file FILE | --file FILE [--file FILE]) [--caption TEXT] [--owner-chat JID]; deliver --owner-chat JID --file FILE --requested; confirm DRAFT_ID --approved. All commands accept --workspace DIR. The normal TeleCode bridge starts the listener and the native connector once the configuration exists.");
    return;
  }
  const workspace = path.resolve(values.workspace ?? loadConfig().workspace);
  const directory = whatsappDirectory(workspace);
  if (command === "init") {
    if (!values.number || !values.owner) throw new Error("Both --number TEST_NUMBER and --owner ACTUAL_NUMBER are required.");
    // Reserve two different ephemeral ports together, then persist their numbers.
    const servers = [createServer(), createServer()];
    try {
      const ports = await Promise.all(servers.map((s) => new Promise<number>((resolve, reject) => {
        s.once("error", reject); s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
      })));
      initializeWhatsApp(directory, values.number, values.owner, ports[0], ports[1]);
    } finally { for (const server of servers) server.close(); }
    console.log("WhatsApp configuration created with two trusted owner routes. No account has been paired and no message has been sent.");
    return;
  }
  const config = readWhatsAppConfig(directory);
  if (!config) throw new Error("Run WhatsApp init first.");
  const gowa = new GowaClient(config);
  if (command === "configure-gowa") {
    const runtime = path.join(directory, "gowa");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const basic = Buffer.from(config.gowaAuthorization.slice(6), "base64").toString("utf8");
    const env = {
      APP_HOST: "127.0.0.1", APP_PORT: new URL(config.gowaUrl).port,
      APP_BASIC_AUTH: basic, APP_UI_ENABLED: "false", APP_UI_AUTO_UPDATE: "false", MCP_ENABLED: "false",
      WHATSAPP_AUTO_REPLY: "", WHATSAPP_AUTO_MARK_READ: "false", WHATSAPP_AUTO_DOWNLOAD_MEDIA: "false",
      WHATSAPP_PRESENCE_ON_CONNECT: "unavailable", WHATSAPP_PRESENCE_PULSE_ENABLED: "false",
      WHATSAPP_WEBHOOK: `http://127.0.0.1:${config.port}/webhook`, WHATSAPP_WEBHOOK_SECRET: config.webhookSecret,
      WHATSAPP_WEBHOOK_EVENTS: "message", WHATSAPP_WEBHOOK_IGNORE_JIDS: "@g.us",
      TELECODE_DOCUMENT_ROOT: path.join(directory, "outgoing"),
    };
    writeFileSync(path.join(runtime, ".env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
    console.log("Private GOWA configuration prepared. API is loopback-only; auto-replies, dashboard, presence pulses and public MCP are disabled.");
    return;
  }
  if (command === "pair-code" || command === "pair-qr") {
    const devices = await gowa.request<Array<{ id: string; jid?: string; phone_number?: string }> | null>("/devices");
    const existing = (devices ?? []).find((d) => d.id === config.deviceId);
    if (existing?.jid || existing?.phone_number) throw new Error("This slot is already paired. Check status before considering a re-pair.");
    if (!existing) await gowa.request("/devices", "POST", { device_id: config.deviceId });
    const result = command === "pair-code"
      ? await gowa.request(`/devices/${config.deviceId}/login/code?phone=${config.number}`, "POST")
      : await gowa.request(`/devices/${config.deviceId}/login`);
    // Pairing credentials are displayed only when this explicit command is run.
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  let route: string; let method = "GET"; let body: unknown;
  if (command === "status") route = "/status";
  else if (command === "chats") route = `/chats?search=${encodeURIComponent(values.search ?? "")}&offset=${values.offset ?? "0"}`;
  else if (command === "messages") {
    if (!values.chat) throw new Error("--chat is required.");
    route = `/messages?chat=${encodeURIComponent(values.chat)}&search=${encodeURIComponent(values.search ?? "")}&offset=${values.offset ?? "0"}`;
  } else if (command === "download") {
    if (!values.chat || !values.message) throw new Error("Use --chat EXACT_JID --message MESSAGE_ID.");
    route = "/download"; method = "POST"; body = { chat: values.chat, messageId: values.message };
  } else if (command === "draft") {
    if (!values.to || (!values["text-file"] && !values.file?.length)) throw new Error("Use --to and --text-file or --file. Drafting sends nothing to the recipient.");
    route = "/draft"; method = "POST";
    body = { ownerChat: values["owner-chat"] ?? "telegram", to: values.to, text: values["text-file"] ? readFileSync(values["text-file"], "utf8") : values.caption ?? "", files: values.file };
  } else if (command === "deliver") {
    if (!values["owner-chat"] || !values.file?.length || values.requested !== true) throw new Error("Use --owner-chat OWNER_JID --file LOCAL_FILE --requested only for attachments the owner explicitly asked to receive.");
    route = "/deliver"; method = "POST";
    body = { ownerChat: values["owner-chat"], files: values.file, caption: values.caption, requested: true };
  } else if (command === "confirm") {
    if (values.approved !== true || !positionals[1]) throw new Error("Confirm only after the owner approves the exact recipient and final text. Supply DRAFT_ID --approved.");
    route = "/confirm"; method = "POST"; body = { id: positionals[1], approved: true };
  } else throw new Error("Unknown WhatsApp command. Use --help.");
  const response = await localJsonRequest(`http://127.0.0.1:${config.port}${route}`, method,
    { Authorization: `Bearer ${config.controlToken}`, "Content-Type": "application/json" }, body);
  const result = response.data;
  if (response.status < 200 || response.status >= 300) throw new Error((result as { error?: string }).error ?? `WhatsApp request failed (${response.status}).`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "WhatsApp command failed."); process.exitCode = 1; });
