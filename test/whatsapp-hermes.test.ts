import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TeleCodeConfig } from "../src/config.js";
import { WhatsAppProviderAgent } from "../src/whatsapp/agent.js";
import { WhatsAppStore } from "../src/whatsapp/store.js";
import type { WhatsAppConfig } from "../src/whatsapp/config.js";
import { HermesGateway, sseFrames } from "../src/whatsapp/hermes.js";
import { requestedAgent, selectAgent } from "../src/routing/agent-selection.js";

describe("shared TeleCode agent selection", () => {
  it("restores each backend's own history without merging it, and returns to the last TeleCode provider", () => {
    const initial = { provider: "claude" as const, providerSessionId: "claude-one", model: "claude-model" };
    const hermes = selectAgent(initial, "hermes", "codex");
    expect(hermes.providerSessionId).toBeUndefined();
    const back = selectAgent({ ...hermes, providerSessionId: "hermes-one" }, "telecode", "codex");
    expect(back).toMatchObject(initial);
    expect(selectAgent(back, "hermes", "codex").providerSessionId).toBe("hermes-one");
  });
  it("recognizes only complete routing commands, never incidental or quoted instructions", () => {
    expect(requestedAgent("switch to Hermes")).toBe("hermes");
    expect(requestedAgent("/agent telecode")).toBe("telecode");
    expect(requestedAgent("Someone said switch to Hermes")).toBeUndefined();
    expect(requestedAgent("\"switch to Hermes\"")).toBeUndefined();
  });
});

describe("Hermes gateway protocol", () => {
  it("parses fragmented UTF-8, CRLF, multiline data and keepalives", async () => {
    const bytes = new TextEncoder().encode(": keepalive\r\n\r\nevent: test\r\ndata: hé\r\ndata: world\r\n\r\n");
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const result = []; for await (const item of sseFrames(stream)) result.push(item);
    expect(result).toEqual([{ event: "test", data: "hé\nworld" }]);
  });

  it("uses the actual gateway session across cold resumes, isolates owners, emits narration, and never leaks reasoning", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telecode-hermes-"));
    const store = new WhatsAppStore(path.join(root, "state.db"));
    const calls: Array<{ url: string; headers: Record<string, unknown>; body: any }> = [];
    let sessions = 0, fail = false;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      calls.push({ url: req.url!, headers: req.headers, body: JSON.parse(body) });
      if (req.url === "/api/sessions") {
        res.writeHead(201, { "Content-Type": "application/json" }); res.end(JSON.stringify({ session: { id: `api-${++sessions}` } })); return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      frame({ choices: [{ delta: { content: "Checking your file.", reasoning_content: "PRIVATE THOUGHT" } }] });
      res.write('event: hermes.tool.progress\ndata: {"status":"running"}\n\n');
      frame({ choices: [{ delta: { content: "File checked." }, finish_reason: fail ? "error" : "stop" }] });
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const cfg = { workspace: root, enableClaudeProvider: true } as TeleCodeConfig;
    const whatsapp = { provider: "codex", number: "32470000001", hermes: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "a".repeat(64) } } as WhatsAppConfig;
    let agent = new WhatsAppProviderAgent(cfg, whatsapp, store);
    const output: string[] = [], emit = async (text: string) => { output.push(text); };
    try {
      store.saveSession("owner-1", { provider: "codex", providerSessionId: "codex-preserved" });
      await agent.reset("owner-1", "hermes");
      await agent.run("owner-1", "inspect", emit, { filePaths: ["original.mp4"] }, "event-one");
      expect(output).toEqual(["Checking your file.", "File checked."]);
      expect(store.session("owner-1")?.providerSessionId).toBe("api-1");
      await agent.dispose(); agent = new WhatsAppProviderAgent(cfg, whatsapp, store);
      await agent.run("owner-1", "continue", emit, undefined, "event-two");
      await agent.reset("owner-1", "telecode");
      expect(store.session("owner-1")?.providerSessionId).toBe("codex-preserved");
      await agent.reset("owner-1", "hermes");
      expect(store.session("owner-1")?.providerSessionId).toBe("api-1");
      await agent.reset("owner-2", "hermes");
      await agent.run("owner-2", "separate", emit, undefined, "event-three");
      const turns = calls.filter((c) => c.url === "/v1/chat/completions");
      expect(turns.map((c) => c.headers["x-hermes-session-id"])).toEqual(["api-1", "api-1", "api-2"]);
      expect(turns[0].headers.authorization).toBe("Bearer " + "a".repeat(64));
      expect(turns[0].headers["x-hermes-session-key"]).not.toBe(turns[2].headers["x-hermes-session-key"]);
      expect(turns[0].headers["idempotency-key"]).not.toBe(turns[1].headers["idempotency-key"]);
      expect(turns[0].body.messages[0].content).toContain("original.mp4");
      fail = true;
      await expect(agent.run("owner-1", "fail", emit, undefined, "event-four")).rejects.toThrow(/terminal/);
      expect(store.session("owner-1")?.provider).toBe("hermes");
      expect(calls.filter((c) => c.url === "/v1/chat/completions")).toHaveLength(4);
      await agent.reset("owner-1");
      expect(store.session("owner-1")?.providerSessionId).toBeUndefined();
      expect(store.session("owner-2")?.providerSessionId).toBe("api-2");
    } finally {
      await agent.dispose(); store.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects truncated streams and aborts a running gateway request", async () => {
    const server = createServer(async (req, res) => {
      for await (const _ of req) {}
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      if (req.headers["x-hermes-session-id"] === "truncated") res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const gateway = new HermesGateway({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "a".repeat(64) });
    const base = { scope: "owner-test", requestId: "one", prompt: "test" }, output: string[] = [];
    try {
      await expect(gateway.run({ ...base, sessionId: "truncated", signal: AbortSignal.timeout(5000) }, async (t) => { output.push(t); })).rejects.toThrow(/terminal/);
      expect(output).toEqual([]);
      const controller = new AbortController();
      const turn = gateway.run({ ...base, sessionId: "abort", signal: controller.signal }, async () => {});
      setTimeout(() => controller.abort(), 50);
      await expect(turn).rejects.toThrow();
    } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
});
