import {
  ClaudeSdkInputController,
  runClaudeSdkTurn,
  type SdkMessageLike,
  type SdkUserMessageLike,
} from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";

function fakeQuery(messages: SdkMessageLike[]) {
  const seen: Array<{
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }> = [];
  const queryFn = (input: {
    prompt: string | AsyncIterable<SdkUserMessageLike>;
    options: Record<string, unknown>;
  }) => {
    seen.push(input);
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  };
  return { queryFn, seen };
}

async function collect(iterable: AsyncIterable<AgentProviderEvent>): Promise<AgentProviderEvent[]> {
  const events: AgentProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

const baseOptions = {
  sessionId: "claude-provider-1",
  jobId: "job-1",
  promptText: "do the thing",
  cwd: "C:\\workspace",
  claudeBin: "C:\\claude.exe",
  model: "claude-sonnet-5",
  permissionMode: "bypassPermissions" as const,
};

describe("claude sdk engine", () => {
  it("maps every assistant text block to its own delta, in order (D3 fix)", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "real-session-id" },
      { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "ALPHA" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo ok" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "BETA" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "GAMMA" }] } },
      {
        type: "result",
        subtype: "success",
        result: "GAMMA",
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
      },
    ]);

    const providerSessionIds: string[] = [];
    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      queryFn,
      onProviderSessionId: (id) => providerSessionIds.push(id),
    }));

    expect(providerSessionIds).toEqual(["real-session-id"]);
    expect(events).toMatchObject([
      { type: "model_updated", model: "claude-sonnet-5" },
      { type: "assistant_text_delta", text: "ALPHA" },
      { type: "tool_started", toolName: "Bash" },
      { type: "tool_completed", toolName: "tool" },
      { type: "assistant_text_delta", text: "BETA" },
      { type: "assistant_text_delta", text: "GAMMA" },
      { type: "usage_updated", inputTokens: 10, cachedInputTokens: 105, outputTokens: 7 },
      { type: "assistant_message_complete", text: "GAMMA" },
    ]);
  });

  it("passes resume, strict mcp, parity options, and a scrubbed env to the SDK", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    process.env.TELEGRAM_BOT_TOKEN = "999:should-not-leak";
    try {
      await collect(runClaudeSdkTurn({ ...baseOptions, resume: "prior-session", queryFn }));
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }

    const options = seen[0]!.options;
    expect(options.resume).toBe("prior-session");
    expect(options.forkSession).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual(["user", "project"]);
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.pathToClaudeCodeExecutable).toBe("C:\\claude.exe");
    expect((options.env as Record<string, unknown>).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("passes forkSession alongside resume when forking", async () => {
    const { queryFn, seen } = fakeQuery([
      { type: "system", subtype: "init", session_id: "new-fork-id" },
      { type: "result", subtype: "success", result: "ok", usage: {} },
    ]);
    await collect(runClaudeSdkTurn({ ...baseOptions, resume: "source-session", forkSession: true, queryFn }));

    expect(seen[0]!.options.resume).toBe("source-session");
    expect(seen[0]!.options.forkSession).toBe(true);
  });

  it("sends the initial prompt directly and reserves streaming input for live steering", async () => {
    const inputController = new ClaudeSdkInputController();
    const streamedPrompts: SdkUserMessageLike[] = [];
    const seenPrompts: Array<string | AsyncIterable<SdkUserMessageLike>> = [];
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      seenPrompts.push(input.prompt);
      let gotSteerResolve: (() => void) | undefined;
      const gotSteer = new Promise<void>((resolve) => {
        gotSteerResolve = resolve;
      });
      const query = (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
        await gotSteer;
        yield { type: "result", subtype: "success", result: "ok", usage: {} } satisfies SdkMessageLike;
      })() as AsyncGenerator<SdkMessageLike> & {
        streamInput: (stream: AsyncIterable<SdkUserMessageLike>) => Promise<void>;
      };
      query.streamInput = async (stream) => {
        for await (const message of stream) {
          streamedPrompts.push(message);
          gotSteerResolve?.();
          return;
        }
      };
      return query;
    };

    const eventsPromise = collect(runClaudeSdkTurn({ ...baseOptions, inputController, queryFn }));
    await waitUntil(() => seenPrompts.length === 1);
    inputController.push("steer this turn", "now");
    const events = await eventsPromise;

    expect(seenPrompts).toEqual([baseOptions.promptText]);
    expect(streamedPrompts.map((message) => message.message.content[0]?.text)).toEqual([
      "steer this turn",
    ]);
    expect(streamedPrompts[0]?.priority).toBe("now");
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
  });

  it("retries an empty successful result once and resumes the real session id", async () => {
    const calls: Array<{
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }> = [];
    const queryFn = (input: {
      prompt: string | AsyncIterable<SdkUserMessageLike>;
      options: Record<string, unknown>;
    }) => {
      calls.push(input);
      const callNumber = calls.length;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "real-resumed-session" } satisfies SdkMessageLike;
        if (callNumber === 1) {
          yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Recovered answer" }] },
        } satisfies SdkMessageLike;
        yield { type: "result", subtype: "success", result: "Recovered answer", usage: {} } satisfies SdkMessageLike;
      })();
    };

    const events = await collect(runClaudeSdkTurn({
      ...baseOptions,
      resume: "old-session",
      inputController: new ClaudeSdkInputController(),
      queryFn,
    }));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe(baseOptions.promptText);
    expect(calls[1]?.options.resume).toBe("real-resumed-session");
    expect(calls[1]?.prompt).toEqual(expect.stringContaining("previous turn ended successfully"));
    expect(events.some((event) => event.type === "status_message")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "Recovered answer",
    }));
  });

  it("reports an error instead of an empty completion when both attempts are empty", async () => {
    const queryFn = () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "s" } satisfies SdkMessageLike;
      yield { type: "result", subtype: "success", result: "", usage: {} } satisfies SdkMessageLike;
    })();

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("without assistant text twice"),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "assistant_message_complete",
      text: "",
    }));
  });

  it("maps a non-success result to an error event", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "error_max_budget_usd", result: "budget exceeded", usage: {} },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ type: "error", message: expect.stringContaining("budget exceeded") });
    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(false);
  });

  it("reports a stream that dies without a result", async () => {
    const { queryFn } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    ]);

    const events = await collect(runClaudeSdkTurn({ ...baseOptions, queryFn }));
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      message: expect.stringContaining("without a result"),
    });
  });
});
