import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, open, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DOCUMENT_LIMIT = 2_000_000_000;
export const VOICE_TRANSCRIPTION_LIMIT = 25 * 1024 * 1024;

export interface WhatsAppAttachment {
  path: string;
  fileName: string;
  size: number;
  sha256: string;
  delivery: "document";
}

/** A disk-backed, hashed snapshot binds approval to the exact original bytes. */
export async function snapshotAttachment(source: string, root: string): Promise<WhatsAppAttachment> {
  const resolved = realpathSync(source);
  const original = await open(resolved, "r");
  let destination: string | undefined;
  try {
    const before = await original.stat();
    if (!before.isFile() || before.size <= 0 || before.size > DOCUMENT_LIMIT) throw new Error("Documents must be between 1 byte and 2 GB.");
    const fileName = path.basename(source);
    if (!fileName || /[\x00-\x1f\x7f]/u.test(fileName)) throw new Error("Invalid attachment filename.");
    const directory = path.join(root, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    destination = path.join(directory, fileName);
    const digest = createHash("sha256"); let copied = 0;
    const hash = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      if (copied > DOCUMENT_LIMIT) { callback(new Error("Document grew past 2 GB while being staged.")); return; }
      digest.update(chunk); callback(null, chunk);
    } });
    await pipeline(original.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 }), hash,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    const after = await original.stat();
    if (copied !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("The original changed while staging. Prepare the attachment again.");
    await chmod(destination, 0o400);
    return { path: realpathSync(destination), fileName, size: copied, sha256: digest.digest("hex"), delivery: "document" };
  } catch (error) {
    if (destination) { await chmod(destination, 0o600).catch(() => {}); await unlink(destination).catch(() => {}); }
    throw error;
  } finally { await original.close(); }
}

export async function verifyAttachment(attachment: WhatsAppAttachment, root: string): Promise<void> {
  if (attachment.delivery !== "document" || !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error("Invalid attachment manifest.");
  const file = realpathSync(attachment.path);
  const relative = path.relative(realpathSync(root), file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Attachment is outside the private outgoing directory.");
  const info = statSync(file);
  if (!info.isFile() || info.size !== attachment.size || info.size > DOCUMENT_LIMIT || path.basename(file) !== attachment.fileName) throw new Error("Attachment no longer matches the reviewed file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024 })) hash.update(chunk);
  if (hash.digest("hex") !== attachment.sha256) throw new Error("Attachment bytes changed after review. Nothing was sent.");
}

export function attachmentReview(files: WhatsAppAttachment[]): string {
  return files.map((file) => `${file.fileName}, ${file.size >= 1_000_000 ? (file.size / 1_000_000).toFixed(1) + " MB" : file.size + " bytes"}, original document`).join("\n");
}

export async function removeSnapshot(file: WhatsAppAttachment, root: string): Promise<void> {
  const resolved = realpathSync(file.path);
  const relative = path.relative(realpathSync(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to clean a file outside the outgoing directory.");
  await chmod(resolved, 0o600);
  await unlink(resolved);
  await rmdir(path.dirname(resolved)).catch(() => {});
}
