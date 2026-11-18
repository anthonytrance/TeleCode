import type { WhatsAppConfig } from "./config.js";
import { localUrl } from "./config.js";
import { jidNumber } from "./policy.js";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DOCUMENT_LIMIT, verifyAttachment, type WhatsAppAttachment } from "./media.js";
import { localJsonRequest } from "./http.js";

export class GowaClient {
  constructor(readonly config: WhatsAppConfig, private readonly fetcher: typeof fetch = fetch, private readonly mediaRoot?: string) { localUrl(config.gowaUrl); }

  async request<T = Record<string, unknown>>(route: string, method = "GET", body?: unknown, timeoutMs = 30_000, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("Invalid GOWA route.");
    const headers = { ...extraHeaders, Authorization: this.config.gowaAuthorization, "X-Device-Id": this.config.deviceId, "Content-Type": "application/json" };
    if (timeoutMs > 30_000 && this.fetcher === fetch) {
      const response = await localJsonRequest(new URL(route, this.config.gowaUrl).href, method, headers, body, timeoutMs);
      if (response.status < 200 || response.status >= 300) throw new Error(`GOWA ${method} failed (HTTP ${response.status}).`);
      const data = response.data as { code?: string; results?: T };
      if (data.code !== "SUCCESS" || data.results === undefined) throw new Error("GOWA transfer failed or returned no result.");
      return data.results;
    }
    const response = await this.fetcher(new URL(route, this.config.gowaUrl), {
      method, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GOWA ${method} ${route.split("?")[0]} failed (HTTP ${response.status}).`);
    const result = await response.json() as { code?: string; results?: T };
    if (result.code && result.code !== "SUCCESS") throw new Error(`GOWA request failed (${result.code}).`);
    if (result.results === undefined) throw new Error("GOWA returned no result.");
    return result.results;
  }

  async assertAccount(): Promise<void> {
    const devices = await this.request<Array<{ device_id?: string; id?: string; jid?: string; phone_number?: string }> | null>("/devices");
    const device = (devices ?? []).find((d) => (d.device_id ?? d.id) === this.config.deviceId);
    const number = jidNumber(device?.jid) ?? device?.phone_number?.replace(/^\+/, "");
    if (number !== this.config.number) throw new Error("The linked WhatsApp account does not match the configured test number. Sending is blocked.");
    const state = await this.request<{ is_connected?: boolean; is_logged_in?: boolean }>(`/devices/${this.config.deviceId}/status`);
    if (state.is_connected !== true || state.is_logged_in !== true) throw new Error("WhatsApp is not connected. Complete Linked Devices pairing first.");
  }

  async send(chat: string, text: string, messageId?: string): Promise<string> {
    await this.assertAccount();
    const result = await this.request<{ message_id?: string }>("/send/message", "POST", { phone: chat, message: text }, 30_000, messageId ? { "X-Telecode-Message-Id": messageId } : {});
    if (!result.message_id) throw new Error("WhatsApp did not return a sent message ID. Delivery is uncertain; do not retry automatically.");
    if (messageId && result.message_id !== messageId) throw new Error("The connector did not honor the reserved WhatsApp message ID. Do not retry automatically.");
    return result.message_id;
  }

  async sendDocument(chat: string, file: WhatsAppAttachment, caption = "", messageId?: string): Promise<string> {
    if (!this.mediaRoot) throw new Error("WhatsApp media storage is unavailable.");
    await verifyAttachment(file, path.join(this.mediaRoot, "..", "outgoing"));
    await this.assertAccount();
    const info = await this.request<{ version?: string }>("/app/info");
    if (!info.version?.includes("telecode.")) throw new Error("This GOWA build does not support streaming original documents. Install the TeleCode document build first.");
    const result = await this.request<{ message_id?: string }>("/send/file", "POST", {
      phone: chat, local_file: file.path, local_sha256: file.sha256, caption,
    }, 20 * 60_000, messageId ? { "X-Telecode-Message-Id": messageId } : {});
    if (!result.message_id) throw new Error("WhatsApp returned no document message ID. Check delivery before retrying.");
    if (messageId && result.message_id !== messageId) throw new Error("The connector returned an unexpected document message ID. Do not retry automatically.");
    return result.message_id;
  }

  /** Typing indicators. WhatsApp only shows them while the account is "available". */
  async presence(type: "available" | "unavailable"): Promise<void> {
    await this.request("/send/presence", "POST", { type }, 10_000);
  }
  async chatPresence(chat: string, action: "start" | "stop"): Promise<void> {
    await this.request("/send/chat-presence", "POST", { phone: chat, action }, 10_000);
  }

  async react(chat: string, messageId: string, emoji: string): Promise<void> {
    await this.assertAccount();
    await this.request(`/message/${encodeURIComponent(messageId)}/reaction`, "POST", { phone: chat, emoji });
  }

  async chats(search = "", offset = 0): Promise<Record<string, unknown>> {
    await this.assertAccount();
    return this.request(`/chats?limit=100&offset=${offset}&search=${encodeURIComponent(search)}`);
  }

  async messages(chat: string, search = "", offset = 0): Promise<Record<string, unknown>> {
    await this.assertAccount();
    return this.request(`/chat/${encodeURIComponent(chat)}/messages?limit=100&offset=${offset}&search=${encodeURIComponent(search)}`);
  }

  async download(messageId: string, chat: string): Promise<{ path: string; mediaType: string }> {
    if (!this.mediaRoot) throw new Error("Local WhatsApp media storage is not configured.");
    await this.assertAccount();
    const result = await this.request<{ file_path?: string; media_type?: string }>(`/message/${encodeURIComponent(messageId)}/download?phone=${encodeURIComponent(chat)}`, "GET", undefined, 20 * 60_000);
    if (!result.file_path) throw new Error("WhatsApp returned no media file.");
    return { path: safeMediaPath(this.mediaRoot, result.file_path), mediaType: result.media_type ?? "file" };
  }
}

export function safeMediaPath(root: string, file: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedFile = realpathSync(path.resolve(root, file));
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("WhatsApp media path is outside its private runtime directory.");
  const info = statSync(resolvedFile);
  if (!info.isFile() || info.size > DOCUMENT_LIMIT) throw new Error("WhatsApp media must be a file no larger than 2 GB.");
  return resolvedFile;
}
