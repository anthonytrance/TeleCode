import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  locateActiveTranscript,
  locateActiveTranscriptTurnByPrompt,
  locateSingleHumanPromptTurn,
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
        model: "claude-fable-5",
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
      { type: "model_updated", model: "claude-fable-5" },
      { type: "assistant_text_delta", text: "Hello" },
      { type: "tool_started", toolName: "Read" },
      { type: "usage_updated", inputTokens: 10, cachedInputTokens: 107, outputTokens: 5 },
    ]);
  });

  it("maps Claude API error assistant entries to readable final text", async () => {
    const projection = projectClaudeTranscriptEntry({
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        content: [
          { type: "text", text: "Claude Fable 5 is currently unavailable." },
        ],
      },
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.assistantText).toBe("Claude Fable 5 is currently unavailable.");
    expect(projection.turnEnded).toBe(true);
    expect(projection.events).toMatchObject([
      {
        type: "assistant_text_delta",
        sessionId: "s1",
        jobId: "j1",
        text: "Claude Fable 5 is currently unavailable.",
      },
    ]);
  });

  it("surfaces unknown Claude system notices with text", () => {
    const projection = projectClaudeTranscriptEntry({
      type: "system",
      subtype: "model_fallback_notice",
      message: { content: [{ type: "text", text: "Claude Fable handed this turn to Opus after a safety check." }] },
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.events).toMatchObject([
      {
        type: "status_message",
        sessionId: "s1",
        text: "Claude Fable handed this turn to Opus after a safety check.",
      },
    ]);
  });

  it("surfaces model fallback system notices even when Claude writes only a subtype", () => {
    const projection = projectClaudeTranscriptEntry({
      type: "system",
      subtype: "model_refusal_fallback",
    }, { sessionId: "s1", jobId: "j1" });

    expect(projection.events).toMatchObject([
      {
        type: "status_message",
        sessionId: "s1",
        text: "Claude Fable refused this request and Claude switched to a fallback model.",
      },
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

  it("stops promptly when shouldStop returns true, emitting collected text without an idle wait", async () => {
    const transcript = path.join(tempDir, "session.jsonl");
    // No turn_duration line: the turn never ends on its own, so only shouldStop can end it.
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "PARTIAL" }] } }),
      "",
    ].join("\n"), "utf8");

    const tailer = new TranscriptTailer(transcript, { pollIntervalMs: 10 });
    const events = [];
    let stop = false;
    for await (const event of tailer.eventsUntilTurnEnd({
      sessionId: "s1",
      jobId: "j1",
      idleTimeoutMs: 60000,
      shouldStop: () => stop,
    })) {
      events.push(event);
      if (event.type === "assistant_text_delta") {
        stop = true;
      }
    }

    expect(events).toMatchObject([
      { type: "assistant_text_delta", text: "PARTIAL" },
      { type: "assistant_message_complete", text: "PARTIAL" },
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
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

  it("ends the turn when Claude writes a synthetic API notice", async () => {
    const transcript = path.join(tempDir, "session.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        error: "safety_fallback",
        message: {
          content: [{ type: "text", text: "Claude Fable handed this turn to Opus after a safety check." }],
        },
      }),
      "",
    ].join("\n"), "utf8");

    const tailer = new TranscriptTailer(transcript, { pollIntervalMs: 10 });
    const events = [];
    for await (const event of tailer.eventsUntilTurnEnd({
      sessionId: "s1",
      jobId: "j1",
      idleTimeoutMs: 1000,
    })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { type: "assistant_text_delta", text: "Claude Fable handed this turn to Opus after a safety check." },
      { type: "assistant_message_complete", text: "Claude Fable handed this turn to Opus after a safety check." },
    ]);
  });

  it("warns instead of erroring when Claude goes quiet, then finishes the turn", async () => {
    const transcript = path.join(tempDir, "session.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "PowerShell", input: { command: "ytclip --selftest" } }],
        },
      }),
      "",
    ].join("\n"), "utf8");

    setTimeout(() => {
      appendFileSync(transcript, [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: "ok" }] },
        }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } }),
        JSON.stringify({ type: "system", subtype: "turn_duration" }),
        "",
      ].join("\n"), "utf8");
    }, 60);

    const tailer = new TranscriptTailer(transcript, { pollIntervalMs: 10 });
    const events = [];
    for await (const event of tailer.eventsUntilTurnEnd({
      sessionId: "s1",
      jobId: "j1",
      idleTimeoutMs: 20,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "error")).toBe(false);
    const quietWarnings = events.filter(
      (event) => event.type === "status_message" && event.text.startsWith("Claude has been quiet for"),
    );
    expect(quietWarnings.length).toBeGreaterThan(0);
    expect(quietWarnings[0].text).toContain("while a tool is running");
    expect(events.filter((event) => event.type !== "status_message")).toMatchObject([
      { type: "tool_started", toolName: "PowerShell" },
      { type: "tool_completed", toolName: "tool" },
      { type: "assistant_text_delta", text: "DONE" },
      { type: "session_status_changed", status: "idle" },
      { type: "assistant_message_complete", text: "DONE" },
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

  it("recovers the single human prompt after the offset while ignoring tool results", async () => {
    const realPath = path.join(projectDir, "real-id.jsonl");
    writeFileSync(realPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "old prompt" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } }),
      "",
    ].join("\n"), "utf8");
    const expectedOffset = statSync(realPath).size;
    appendFileSync(realPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: " recorded prompt" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "MEMORY.md" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] },
      }),
      "",
    ].join("\n"), "utf8");

    const active = await locateSingleHumanPromptTurn({
      expectedSessionId: "real-id",
      knownPath: realPath,
      minOffset: expectedOffset,
      configDir,
    });

    expect(active).toEqual({ path: realPath, startOffset: expectedOffset });
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
