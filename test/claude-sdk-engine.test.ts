import { runClaudeSdkTurn, type SdkMessageLike } from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";

function fakeQuery(messages: SdkMessageLike[]) {
  const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const queryFn = (input: { prompt: string; options: Record<string, unknown> }) => {
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
