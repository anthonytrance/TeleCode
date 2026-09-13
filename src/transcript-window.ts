import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type TranscriptWindow = {
  /** The first bytes of the file, cut at the last complete line. The whole file when small. */
  head: string;
  /** The last bytes of the file, starting at the first complete line. Undefined when head is the whole file. */
  tail?: string;
  size: number;
  mtimeMs: number;
};

export const DEFAULT_TRANSCRIPT_WINDOW_BYTES = 256 * 1024;

/**
 * Read only the head and tail of a large JSONL transcript. A session summary needs
 * the first workspace and first user prompt (head) plus the latest title and cwd
 * (tail). Reading a 30 MB transcript end to end for that, on every /sessions and
 * on every /switch, is what made the session list crawl.
 */
export function readTranscriptWindow(
  filePath: string,
  chunkBytes = DEFAULT_TRANSCRIPT_WINDOW_BYTES,
): TranscriptWindow {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size <= chunkBytes * 2) {
      const buffer = Buffer.alloc(size);
      readFully(fd, buffer, 0);
      return { head: buffer.toString("utf8"), size, mtimeMs: stat.mtimeMs };
    }
    const headBuffer = Buffer.alloc(chunkBytes);
    readFully(fd, headBuffer, 0);
    const tailBuffer = Buffer.alloc(chunkBytes);
    readFully(fd, tailBuffer, size - chunkBytes);
    return {
      head: dropPartialLastLine(headBuffer.toString("utf8")),
      tail: dropPartialFirstLine(tailBuffer.toString("utf8")),
      size,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function readFully(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read <= 0) {
      break;
    }
    offset += read;
  }
}

function dropPartialLastLine(text: string): string {
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? "" : text.slice(0, cut);
}

function dropPartialFirstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut < 0 ? "" : text.slice(cut + 1);
}
