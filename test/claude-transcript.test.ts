import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  projectClaudeTranscriptEntry,
  TranscriptTailer,
} from "../src/providers/claude-transcript.js";

describe("Claude transcript projection", () => {
  it("maps assistant text, tool use, and usage", () => {
    const projection = projectClaudeTranscriptEntry({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", name: "Read", input: { file: "a.txt" } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 7,
        },
      },
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.assistantText).toBe("Hello");
    expect(projection.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 107,
      outputTokens: 5,
      contextTokens: 117,
    });
    expect(projection.events).toMatchObject([
      { type: "assistant_text_delta", text: "Hello" },
      { type: "tool_started", toolName: "Read" },
      { type: "usage_updated", inputTokens: 10, cachedInputTokens: 107, outputTokens: 5 },
    ]);
  });

  it("ignores meta command echoes", () => {
    const projection = projectClaudeTranscriptEntry({
      type: "user",
      isMeta: true,
      message: { content: [{ type: "text", text: "<command-name>/compact</command-name>" }] },
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.events).toEqual([]);
  });

  it("maps turn end and compact boundary", () => {
    expect(projectClaudeTranscriptEntry({
      type: "system",
      subtype: "turn_duration",
    }, { sessionId: "s1", jobId: "j1" })).toMatchObject({
      turnEnded: true,
      events: [{ type: "session_status_changed", status: "idle" }],
    });

    expect(projectClaudeTranscriptEntry({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 26056, postTokens: 3146 },
    }, { sessionId: "s1", jobId: "j1" }).events[0]).toMatchObject({
      type: "compact_boundary",
      summary: "Compacted: 26,056 -> 3,146 tokens",
    });
  });
});

describe("TranscriptTailer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "claude-transcript-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads complete lines, tolerates a partial last line, and emits final text", async () => {
    const transcript = path.join(tempDir, "session.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "First" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: " second" }] } }),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
      "",
      "{\"type\":\"assistant\"",
    ].join("\n"), "utf8");

    const tailer = new TranscriptTailer(transcript);
    const events = [];
    for await (const event of tailer.eventsUntilTurnEnd({
      sessionId: "s1",
      jobId: "j1",
      idleTimeoutMs: 1000,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { type: "assistant_text_delta", text: "First" },
      { type: "assistant_text_delta", text: " second" },
      { type: "session_status_changed", status: "idle" },
      { type: "assistant_message_complete", text: "First second" },
    ]);
  });
});
