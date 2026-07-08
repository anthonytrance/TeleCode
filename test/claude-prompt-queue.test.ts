import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ClaudePromptQueue,
  claudePromptQueuePath,
  type ClaudePromptQueueEntry,
} from "../src/claude-prompt-queue.js";

describe("ClaudePromptQueue", () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telecodex-claude-queue-"));
    queuePath = claudePromptQueuePath(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists and reloads queued prompts in FIFO order per lane", () => {
    const queue = new ClaudePromptQueue(queuePath);
    queue.enqueue(entry("a", "lane-1", "first"));
    queue.enqueue(entry("b", "lane-2", "other lane"));
    queue.enqueue(entry("c", "lane-1", "second"));

    const reloaded = new ClaudePromptQueue(queuePath);

    expect(reloaded.depth("lane-1")).toBe(2);
    expect(reloaded.dequeue("lane-1")?.text).toBe("first");
    expect(reloaded.dequeue("lane-1")?.text).toBe("second");
    expect(reloaded.dequeue("lane-1")).toBeUndefined();
    expect(reloaded.dequeue("lane-2")?.text).toBe("other lane");
  });

  it("can requeue a prompt at the front of its own lane", () => {
    const queue = new ClaudePromptQueue(queuePath);
    queue.enqueue(entry("a", "lane-1", "first"));
    queue.enqueue(entry("b", "lane-2", "other lane"));
    queue.enqueue(entry("c", "lane-1", "second"));
    queue.enqueueFront(entry("d", "lane-1", "front"));

    expect(queue.dequeue("lane-1")?.text).toBe("front");
    expect(queue.dequeue("lane-1")?.text).toBe("first");
    expect(queue.dequeue("lane-2")?.text).toBe("other lane");
    expect(queue.dequeue("lane-1")?.text).toBe("second");
  });

  it("writes UTF-8 JSON without a BOM", () => {
    const queue = new ClaudePromptQueue(queuePath);
    queue.enqueue(entry("a", "lane-1", "first"));

    const bytes = readFileSync(queuePath);
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
      version: 1,
      entries: [{ id: "a", text: "first" }],
    });
  });

  it("removes all queued prompts for a deleted context", () => {
    const queue = new ClaudePromptQueue(queuePath);
    queue.enqueue(entry("a", "lane-1", "first"));
    queue.enqueue(entry("b", "lane-2", "other lane"));

    queue.removeContext("lane-1");

    expect(queue.dequeue("lane-1")).toBeUndefined();
    expect(queue.dequeue("lane-2")?.text).toBe("other lane");
  });
});

function entry(id: string, contextKey: string, text: string): ClaudePromptQueueEntry {
  return {
    id,
    contextKey,
    chatId: 123,
    text,
    queuedAt: 1000,
  };
}
