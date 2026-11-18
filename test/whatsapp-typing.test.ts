import { describe, expect, it } from "vitest";
import { Bot, type Context } from "grammy";
import { ChannelRouter, channelAddress, type ChannelPort } from "../src/channel-router.js";
import { TypingPresence } from "../src/whatsapp/presence.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WhatsApp typing presence", () => {
  it("goes available, types, throttles refreshes, stops when idle and goes unavailable", async () => {
    const calls: string[] = [];
    const presence = new TypingPresence({
      presence: async (type) => { calls.push(type); },
      chatPresence: async (chat, action) => { calls.push(`${action}:${chat}`); },
    }, { refreshMs: 50, idleMs: 80, offlineMs: 40 });
    await presence.typing("a");
    await presence.typing("a");
    expect(calls).toEqual(["available", "start:a"]);
    await sleep(60);
    await presence.typing("a");
    expect(calls).toEqual(["available", "start:a", "start:a"]);
    await sleep(200);
    expect(calls).toEqual(["available", "start:a", "start:a", "stop:a", "unavailable"]);
  });

  it("forgets a chat after a delivered message so a running turn restarts typing", async () => {
    const calls: string[] = [];
    const presence = new TypingPresence({
      presence: async (type) => { calls.push(type); },
      chatPresence: async (chat, action) => { calls.push(`${action}:${chat}`); },
    }, { refreshMs: 10_000, idleMs: 10_000, offlineMs: 10_000 });
    await presence.typing("a");
    presence.sent("a");
    await presence.typing("a");
    expect(calls).toEqual(["available", "start:a", "start:a"]);
    await presence.close();
    expect(calls.slice(-2)).toEqual(["stop:a", "unavailable"]);
  });

  it("maps Telegram typing chat actions to the channel port and never to Telegram", async () => {
    const bot = new Bot<Context>("123:test", { botInfo: { id: 1, is_bot: true, first_name: "t", username: "t", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_and_edit_business_accounts: false, has_main_web_app: false } as any });
    const telegram: string[] = [];
    bot.api.config.use(async (_prev, method) => { telegram.push(method); return { ok: true, result: true } as any; });
    const router = new ChannelRouter();
    router.install(bot);
    let typed = 0;
    const port: ChannelPort = {
      kind: "whatsapp", account: "1", chat: "2@s.whatsapp.net", label: "WhatsApp", documentLimit: 1,
      authorize: () => true, instructions: "", sendText: async () => "x", sendDocument: async () => "y",
      typing: async () => { typed++; },
    };
    router.bind(port);
    await bot.api.sendChatAction(channelAddress("whatsapp", "1", "2@s.whatsapp.net"), "typing");
    await bot.api.sendChatAction(channelAddress("whatsapp", "1", "2@s.whatsapp.net"), "upload_photo");
    expect(typed).toBe(1);
    expect(telegram).toEqual([]);
  });
});
