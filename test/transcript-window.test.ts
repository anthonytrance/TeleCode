import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTranscriptWindow } from "../src/transcript-window.js";

describe("readTranscriptWindow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "telecode-transcript-window-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the whole file as head when it fits in two chunks", () => {
    const file = path.join(dir, "small.jsonl");
    const text = ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"].join("\n");
    writeFileSync(file, text, "utf8");

    const window = readTranscriptWindow(file, 1024);

    expect(window.head).toBe(text);
    expect(window.tail).toBeUndefined();
    expect(window.size).toBe(Buffer.byteLength(text));
  });

  it("returns complete lines only from the head and the tail of a large file", () => {
    const file = path.join(dir, "large.jsonl");
    const lines: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      lines.push(JSON.stringify({ index, text: `line number ${index} with some padding text` }));
    }
    writeFileSync(file, lines.join("\n"), "utf8");

    const window = readTranscriptWindow(file, 512);

    expect(window.tail).toBeDefined();
    const headLines = window.head.split("\n");
    const tailLines = (window.tail ?? "").split("\n");
    expect(headLines[0]).toBe(lines[0]);
    expect(headLines.length).toBeLessThan(lines.length);
    for (const line of [...headLines, ...tailLines]) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(tailLines.at(-1)).toBe(lines.at(-1));
  });
});
