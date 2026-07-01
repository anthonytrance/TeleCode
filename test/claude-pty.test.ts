import { ClaudePty } from "../src/providers/claude-pty.js";

function appendPtyText(pty: ClaudePty, text: string): void {
  (pty as unknown as { rawBuffer: string }).rawBuffer += text;
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
