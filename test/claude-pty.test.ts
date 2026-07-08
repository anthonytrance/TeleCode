import { ClaudePty } from "../src/providers/claude-pty.js";

function appendPtyText(pty: ClaudePty, text: string): void {
  (pty as unknown as { rawBuffer: string }).rawBuffer += text;
  (pty as unknown as { receivedBytes: number }).receivedBytes += text.length;
}

function fakeProc(pty: ClaudePty): Array<{ data: string; at: number }> {
  const writes: Array<{ data: string; at: number }> = [];
  (pty as unknown as { proc: { write: (data: string) => void } }).proc = {
    write: (data: string) => {
      writes.push({ data, at: Date.now() });
    },
  };
  return writes;
}

describe("ClaudePty readiness detection", () => {
  it("does not treat the Claude footer as ready while compaction is still producing output", async () => {
    const pty = new ClaudePty();
    const startedAt = Date.now();
    const ready = pty.waitForReadyPrompt(5000);

    appendPtyText(pty, "Compacting conversation... esc to interrupt ? for shortcuts");
    setTimeout(() => {
      appendPtyText(pty, "Compacting conversation... (1s) shift+tab");
    }, 100);
    setTimeout(() => {
      appendPtyText(pty, "Compacting conversation... (2s) ? for shortcuts");
    }, 500);
    setTimeout(() => {
      appendPtyText(pty, "Ready. ? for shortcuts");
    }, 900);

    await expect(ready).resolves.toBe("\\?forshortcuts");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
  });
});

describe("ClaudePty prompt delivery", () => {
  it("sends long single-line prompts via bracketed paste and holds Enter until the echo settles", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);
    const longText = "p".repeat(3000);

    // Simulate the terminal still echoing the paste for ~1.2s after the write.
    let echoStoppedAt = 0;
    const echoInterval = setInterval(() => {
      appendPtyText(pty, "x".repeat(600));
    }, 100);
    setTimeout(() => {
      clearInterval(echoInterval);
      echoStoppedAt = Date.now();
    }, 1200);

    await pty.sendPrompt(longText);

    expect(writes[0]?.data).toBe(`\x1b[200~${longText}\x1b[201~`);
    const enter = writes[writes.length - 1];
    expect(enter?.data).toBe("\r");
    expect(echoStoppedAt).toBeGreaterThan(0);
    expect(enter!.at).toBeGreaterThanOrEqual(echoStoppedAt);
  });

  it("sends short prompts as plain typed text followed by Enter", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);

    await pty.sendPrompt("hello");

    expect(writes.map((entry) => entry.data)).toEqual(["hello", "\r"]);
  });

  it("still uses bracketed paste for multi-line prompts", async () => {
    const pty = new ClaudePty();
    const writes = fakeProc(pty);

    await pty.sendPrompt("line one\nline two");

    expect(writes[0]?.data).toBe("\x1b[200~line one\nline two\x1b[201~");
    expect(writes[writes.length - 1]?.data).toBe("\r");
  });
});
