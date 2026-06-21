import { createReplayTextUpdate, ReplayTelegramTransport } from "../src/testing/replay-transport.js";

describe("ReplayTelegramTransport", () => {
  it("replays fixture updates in update id order", () => {
    const transport = new ReplayTelegramTransport([
      createReplayTextUpdate({ updateId: 2, chatId: 100, messageThreadId: 7, fromId: 123, text: "topic" }),
      createReplayTextUpdate({ updateId: 1, chatId: 99, fromId: 123, text: "private" }),
    ]);

    expect(transport.pendingUpdateCount()).toBe(2);
    expect(transport.nextUpdate()).toMatchObject({
      updateId: 1,
      laneKey: "99",
      text: "private",
    });
    expect(transport.nextUpdate()).toMatchObject({
      updateId: 2,
      laneKey: "100:7",
      messageThreadId: 7,
      text: "topic",
    });
    expect(transport.nextUpdate()).toBeUndefined();
  });

  it("records outbound messages without any live Telegram client", () => {
    const transport = new ReplayTelegramTransport([], { now: () => 2000 });

    transport.sendMessage(100, "Done", { laneKey: "100:7", messageThreadId: 7 });
    transport.editMessageText(100, "Updated", {
      laneKey: "100:7",
      messageThreadId: 7,
      payload: { messageId: 10 },
    });
    transport.answerCallbackQuery("100:7", { chatId: 100, text: "Selected" });

    expect(transport.outboundLog()).toEqual([
      {
        method: "sendMessage",
        laneKey: "100:7",
        chatId: 100,
        messageThreadId: 7,
        text: "Done",
        payload: undefined,
        createdAt: 2000,
      },
      {
        method: "editMessageText",
        laneKey: "100:7",
        chatId: 100,
        messageThreadId: 7,
        text: "Updated",
        payload: { messageId: 10 },
        createdAt: 2000,
      },
      {
        method: "answerCallbackQuery",
        laneKey: "100:7",
        chatId: 100,
        messageThreadId: undefined,
        text: "Selected",
        payload: undefined,
        createdAt: 2000,
      },
    ]);
  });
});
