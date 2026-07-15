import { describe, expect, it } from "vitest";

import { degenerateTranscriptHint } from "../src/bot.js";

describe("degenerateTranscriptHint", () => {
  it("flags a wall of repeated words as likely non-speech", () => {
    const transcript = Array(200).fill("no").join(" ");
    expect(degenerateTranscriptHint(transcript)).toContain("singing");
  });

  it("flags repetition with tiny vocabulary", () => {
    const transcript = Array(30).fill("la la da").join(" ");
    expect(degenerateTranscriptHint(transcript)).toContain("singing");
  });

  it("leaves normal speech alone", () => {
    const transcript = "please rename the second sketch and make the lead brighter than the last version we tried yesterday";
    expect(degenerateTranscriptHint(transcript)).toBeUndefined();
  });

  it("ignores short messages even when repetitive", () => {
    expect(degenerateTranscriptHint("no no no")).toBeUndefined();
  });
});
