import { request } from "node:http";

/** Node HTTP avoids the fetch implementation's shorter response-header timeout. */
export async function localJsonRequest(url: string, method: string, headers: Record<string, string>, body?: unknown, timeoutMs = 20 * 60_000): Promise<{ status: number; data: unknown }> {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Only local WhatsApp HTTP endpoints are permitted.");
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers: { ...headers, ...(payload ? { "Content-Length": String(payload.length) } : {}) }, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(new Error("WhatsApp response is unexpectedly large.")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 500, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("WhatsApp returned invalid JSON.")); }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
