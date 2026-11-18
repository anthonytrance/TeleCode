import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GowaClient } from "./gowa.js";

/** The main bridge ensures the native connection is available on startup.
 * Never starts a second instance merely because an existing API refused auth. */
export async function ensureNativeWhatsApp(directory: string, workspace: string, client: GowaClient): Promise<void> {
  const check = async () => {
    const info = await client.request<{ version?: string }>("/app/info");
    const version = /^v9\.9\.0-telecode\.(\d+)$/.exec(info.version ?? "");
    if (!version || Number(version[1]) < 3) throw new Error("WhatsApp requires native TeleCode build 3 or newer for message-ID echo protection.");
  };
  try { await check(); return; }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code !== "ECONNREFUSED") throw error;
  }
  const binary = path.join(directory, "gowa", process.platform === "win32" ? "whatsapp-telecode.exe" : "whatsapp-telecode");
  if (!existsSync(binary)) throw new Error(`The native WhatsApp connector is missing. Build it with: python scripts/build-whatsapp-gowa.py --directory "${directory}"`);
  const log = path.join(directory, "gowa.log");
  const python = process.env.TELECODE_PYTHON || path.join(workspace, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const launcher = path.join(workspace, "launch_detached.py");
  let pid: string;
  if (existsSync(python) && existsSync(launcher)) {
    // A host-provided launcher, when present, owns detaching and window hiding.
    const { stdout } = await promisify(execFile)(python, [launcher, "--cwd", path.dirname(binary), "--log", log, binary, "rest"], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, windowsHide: true, timeout: 15_000,
    });
    if (!/^\d+\s*$/.test(stdout)) throw new Error("The native WhatsApp launcher returned no process ID.");
    pid = stdout.trim();
  } else {
    // Portable fallback: a detached, hidden child that outlives TeleCode and logs to gowa.log.
    const fd = openSync(log, "a", 0o600);
    try {
      const child = spawn(binary, ["rest"], { cwd: path.dirname(binary), detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      pid = String(child.pid);
    } finally { closeSync(fd); }
  }
  console.log(`Native WhatsApp connector launched, PID ${pid}.`);
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await check(); return; } catch (error) { failure = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw failure;
}
