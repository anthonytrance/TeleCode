import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_STALE_MS = 20 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 1000;

export async function acquireClaudeLiveLock(workspace, label) {
  const lockParentDir = path.join(workspace, ".telecode", "locks");
  const lockDir = path.join(lockParentDir, "claude-live-smoke.lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockParentDir, { recursive: true });
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(
        ownerPath,
        `${JSON.stringify({
          label,
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        "utf8",
      );
      return () => releaseLock(lockDir, process.pid);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const ageMs = lockAgeMs(ownerPath);
      if (ageMs !== undefined && ageMs > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for Claude live smoke lock: ${describeLock(ownerPath)}`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockDir, pid) {
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    if (!existsSync(ownerPath)) {
      return;
    }
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (owner.pid !== pid) {
      return;
    }
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Lock cleanup is best effort. Stale locks are removed by age on the next run.
  }
}

function lockAgeMs(ownerPath) {
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    const startedAt = Date.parse(owner.startedAt);
    return Number.isFinite(startedAt) ? Date.now() - startedAt : undefined;
  } catch {
    return undefined;
  }
}

function describeLock(ownerPath) {
  try {
    return readFileSync(ownerPath, "utf8").replace(/\s+/g, " ").trim();
  } catch {
    return "(unreadable lock owner)";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
