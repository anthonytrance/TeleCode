import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  locateActiveTranscript,
  projectClaudeTranscriptEntry,
  sessionIdFromTranscriptPath,
  snapshotTranscripts,
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

  it("reads only content past startOffset, skipping prior turns", async () => {
    const transcript = path.join(tempDir, "session.jsonl");
    const priorTurn = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OLD" }] } })}\n`;
    writeFileSync(transcript, priorTurn, "utf8");
    const offset = statSync(transcript).size;
    appendFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "NEW" }] } }),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
      "",
    ].join("\n"), "utf8");

    const tailer = new TranscriptTailer(transcript, { startOffset: offset });
    const events = [];
    for await (const event of tailer.eventsUntilTurnEnd({ sessionId: "s1", jobId: "j1", idleTimeoutMs: 1000 })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { type: "assistant_text_delta", text: "NEW" },
      { type: "session_status_changed", status: "idle" },
      { type: "assistant_message_complete", text: "NEW" },
    ]);
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

describe("transcript discovery", () => {
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "claude-cfg-"));
    projectDir = path.join(configDir, "projects", "C--Users-Anthony-codetest");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("derives the session id from the transcript filename", () => {
    expect(sessionIdFromTranscriptPath(path.join(projectDir, "abc-123.jsonl"))).toBe("abc-123");
  });

  it("snapshots only jsonl files across project dirs", async () => {
    writeFileSync(path.join(projectDir, "a.jsonl"), "", "utf8");
    writeFileSync(path.join(projectDir, "notes.txt"), "", "utf8");
    const snapshot = await snapshotTranscripts(configDir);
    expect([...snapshot]).toEqual([path.join(projectDir, "a.jsonl")]);
  });

  it("prefers a brand-new transcript over a known one (ignored --session-id / resume fork)", async () => {
    const before = await snapshotTranscripts(configDir);
    const realPath = path.join(projectDir, "real-id.jsonl");
    writeFileSync(realPath, "line\n", "utf8");
    const active = await locateActiveTranscript({ before, knownOffset: 0, timeoutMs: 2000, configDir });
    expect(active).toEqual({ path: realPath, startOffset: 0 });
  });

  it("falls back to a known transcript that grew, starting at the captured offset", async () => {
    const knownPath = path.join(projectDir, "known.jsonl");
    writeFileSync(knownPath, "old\n", "utf8");
    const knownOffset = statSync(knownPath).size;
    const before = await snapshotTranscripts(configDir);
    appendFileSync(knownPath, "new\n", "utf8");
    const active = await locateActiveTranscript({ before, knownPath, knownOffset, timeoutMs: 2000, configDir });
    expect(active).toEqual({ path: knownPath, startOffset: knownOffset });
  });

  it("returns null when nothing appears or grows before the timeout", async () => {
    const knownPath = path.join(projectDir, "known.jsonl");
    writeFileSync(knownPath, "old\n", "utf8");
    const before = await snapshotTranscripts(configDir);
    const active = await locateActiveTranscript({
      before,
      knownPath,
      knownOffset: statSync(knownPath).size,
      timeoutMs: 700,
      configDir,
    });
    expect(active).toBeNull();
  });
});
