// Finite native-gateway check. No Telegram polling or WhatsApp sends.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HermesRuntime } from "../dist/providers/hermes-runtime.js";

const folder = mkdtempSync(path.join(tmpdir(), "telecode-hermes-native-"));
const fixture = path.join(folder, "read-canary.txt");
const token = "NATIVE_" + randomBytes(8).toString("hex");
writeFileSync(fixture, token);
let runtime = new HermesRuntime();
let id;
const timer = setTimeout(() => { if (id) void runtime.interrupt(id); }, 150_000);
try {
  const session = await runtime.create(folder); id = session.id;
  console.log(JSON.stringify({ stage: "native-session-created" }));
  const model = await runtime.command(id, "/model");
  console.log(JSON.stringify({ stage: "native-model-report", type: model.type }));
  assert.equal(model.type, "exec");
  assert.ok(model.output?.length, "Native /model returned no report.");
  const current = /^Model: (.+)$/m.exec(model.output)?.[1];
  assert.ok(current && current !== "Hermes default");
  const unchanged = await runtime.command(id, `/model ${current}`);
  assert.ok(unchanged.output?.includes(current), "Native session model mutation was not acknowledged.");
  const help = await runtime.command(id, "/help");
  assert.equal(help.type, "exec");
  assert.ok(help.output?.length, "Native command dispatch returned no help.");
  const output = [];
  await runtime.prompt(id, `Read-only connectivity test. Use a file or terminal tool to read ${JSON.stringify(fixture)}. Remember the exact token inside and reply only with it. Do not modify files, memory or skills, or send any messages through messaging tools.`, async (text) => { output.push(text); });
  assert.ok(output.some((text) => text.includes(token)), "Native gateway file tool failed.");
  console.log(JSON.stringify({ stage: "native-file-tool-passed" }));
  await runtime.dispose(); runtime = new HermesRuntime();
  await runtime.resume(id);
  const resumed = [];
  await runtime.prompt(id, "Without tools, what exact token was in my preceding test? Reply only with the token.", async (text) => { resumed.push(text); });
  assert.ok(resumed.some((text) => text.includes(token)), "Native gateway cold resume lost the conversation.");
  console.log(JSON.stringify({ nativeCommand: "passed", realFileTool: "passed", coldResume: "passed", messagingSends: 0 }));
} finally { clearTimeout(timer); await runtime.dispose(); rmSync(folder, { recursive: true, force: true }); }
