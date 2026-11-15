import { describe, expect, it } from "vitest";
import { unsupportedMessageKind, uploadedFileFromMessage } from "../src/bot.js";

type Message = Parameters<typeof uploadedFileFromMessage>[0];
const base = { message_id: 1, date: 0, chat: { id: 1, type: "private", first_name: "A" } };
const msg = (extra: Record<string, unknown>) => ({ ...base, ...extra }) as unknown as Message;

describe("upload message kinds", () => {
  it("passes a captioned video on as a file", () => {
    const file = uploadedFileFromMessage(msg({ video: { file_id: "v1", file_size: 900 }, caption: "post this" }));
    expect(file).toMatchObject({ file_id: "v1", mime_type: "video/mp4", file_size: 900 });
    expect(file?.file_name).toMatch(/^video-\d+\.mp4$/);
  });

  it("keeps a video's own name and type", () => {
    const file = uploadedFileFromMessage(msg({ video: { file_id: "v2", file_name: "clip.mov", mime_type: "video/quicktime" } }));
    expect(file).toMatchObject({ file_name: "clip.mov", mime_type: "video/quicktime" });
  });

  it("names a round video note", () => {
    expect(uploadedFileFromMessage(msg({ video_note: { file_id: "n1" } }))?.file_name).toMatch(/^video-note-\d+\.mp4$/);
  });

  it("prefers the document of a GIF, which Telegram sends as both", () => {
    const file = uploadedFileFromMessage(msg({ animation: { file_id: "a" }, document: { file_id: "d", file_name: "x.gif.mp4" } }));
    expect(file?.file_id).toBe("d");
  });

  it("names unsupported user content and ignores service messages", () => {
    expect(unsupportedMessageKind(msg({ sticker: { file_id: "s" } }))).toBe("sticker");
    expect(unsupportedMessageKind(msg({ paid_media: {} }))).toBe("paid media");
    expect(unsupportedMessageKind(msg({ forum_topic_created: { name: "t" } }))).toBeUndefined();
  });
});
