import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  locateActiveTranscript,
  locateActiveTranscriptTurnByPrompt,
  locateTranscriptTurnByPrompt,
  projectClaudeTranscriptEntry,
  sessionIdFromTranscriptPath,
  snapshotTranscriptSizes,
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

  it("maps Claude ai-title entries to title-change events", () => {
    const projection = projectClaudeTranscriptEntry({
      type: "ai-title",
      aiTitle: "Daily Codex integration",
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.title).toBe("Daily Codex integration");
    expect(projection.events).toEqual([
      { type: "session_title_changed", sessionId: "s1", title: "Daily Codex integration" },
    ]);
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

  it("prefers a known transcript that grew over an unrelated fresh transcript", async () => {
    const knownPath = path.join(projectDir, "known.jsonl");
    writeFileSync(knownPath, "old\n", "utf8");
    const knownOffset = statSync(knownPath).size;
    const before = await snapshotTranscripts(configDir);
    writeFileSync(path.join(projectDir, "other-session.jsonl"), "other\n", "utf8");
    appendFileSync(knownPath, "new\n", "utf8");

    const active = await locateActiveTranscript({ before, knownPath, knownOffset, timeoutMs: 2000, configDir });

    expect(active).toEqual({ path: knownPath, startOffset: knownOffset });
  });

  it("prefers a fresh transcript matching the expected session id over other fresh transcripts", async () => {
    const before = await snapshotTranscripts(configDir);
    const otherPath = path.join(projectDir, "other-id.jsonl");
    const realPath = path.join(projectDir, "real-id.jsonl");
    writeFileSync(otherPath, "line\n", "utf8");
    writeFileSync(realPath, "line\n", "utf8");
    const active = await locateActiveTranscript({
      before,
      expectedSessionId: "real-id",
      knownOffset: 0,
      timeoutMs: 2000,
      configDir,
    });
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

  it("detects an already-existing unknown transcript that grows after the prompt", async () => {
    const realPath = path.join(projectDir, "real-id.jsonl");
    writeFileSync(realPath, "old\n", "utf8");
    const oldSize = statSync(realPath).size;
    const before = await snapshotTranscriptSizes(configDir);
    appendFileSync(realPath, "new\n", "utf8");

    const active = await locateActiveTranscript({ before, knownOffset: 0, timeoutMs: 2000, configDir });

    expect(active).toEqual({ path: realPath, startOffset: oldSize });
  });

  it("recovers a turn boundary by matching a string-content user prompt", async () => {
    const realPath = path.join(projectDir, "real-id.jsonl");
    const oldLine = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old" }] } })}\n`;
    writeFileSync(realPath, oldLine, "utf8");
    const expectedOffset = statSync(realPath).size;
    appendFileSync(realPath, [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "do you still remember about the press release" },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Yes" }] } }),
      "",
    ].join("\n"), "utf8");

    const active = await locateTranscriptTurnByPrompt({
      promptText: "do you still remember about the press release",
      expectedSessionId: "real-id",
      configDir,
    });

    expect(active).toEqual({ path: realPath, startOffset: expectedOffset });
  });

  it("finds an active turn only after the exact prompt appears past the captured offset", async () => {
    const knownPath = path.join(projectDir, "known.jsonl");
    writeFileSync(knownPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "old prompt" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } }),
      "",
    ].join("\n"), "utf8");
    const knownOffset = statSync(knownPath).size;
    const before = await snapshotTranscriptSizes(configDir);
    appendFileSync(knownPath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stale repaint" }] } })}\n`, "utf8");

    const missing = await locateActiveTranscriptTurnByPrompt({
      before,
      promptText: "new prompt",
      knownPath,
      knownOffset,
      timeoutMs: 700,
      configDir,
    });

    expect(missing).toBeNull();

    appendFileSync(knownPath, `${JSON.stringify({ type: "user", message: { role: "user", content: "new prompt" } })}\n`, "utf8");
    const active = await locateActiveTranscriptTurnByPrompt({
      before,
      promptText: "new prompt",
      knownPath,
      knownOffset,
      timeoutMs: 2000,
      configDir,
    });

    expect(active).toEqual({ path: knownPath, startOffset: statSync(knownPath).size - `${JSON.stringify({ type: "user", message: { role: "user", content: "new prompt" } })}\n`.length });
  });

  it("does not recover an old matching prompt before the minimum offset", async () => {
    const realPath = path.join(projectDir, "real-id.jsonl");
    writeFileSync(realPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "repeat me" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } }),
      "",
    ].join("\n"), "utf8");
    const minOffset = statSync(realPath).size;

    const active = await locateTranscriptTurnByPrompt({
      promptText: "repeat me",
      expectedSessionId: "real-id",
      knownPath: realPath,
      minOffset,
      configDir,
    });

    expect(active).toBeNull();
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
