import { homedir } from "node:os";
import path from "node:path";

export function normalizePersistedWorkspace(workspace: string | undefined, configuredWorkspace: string): string {
  if (!workspace) {
    return configuredWorkspace;
  }

  const home = normalizePath(homedir());
  const persisted = normalizePath(workspace);
  const configured = normalizePath(configuredWorkspace);

  if (persisted === home && configured !== home && isSubpath(home, configured)) {
    return configuredWorkspace;
  }

  return workspace;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSubpath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
