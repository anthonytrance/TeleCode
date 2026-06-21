import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export interface CodexHistoryMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: Date;
}

export interface CodexChildThreadRecord extends CodexThreadRecord {
  parentThreadId: string;
  spawnStatus: string;
}

export interface CodexParentThreadRecord extends CodexThreadRecord {
  childThreadId: string;
  spawnStatus: string;
}

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

type ChildThreadRow = ThreadRow & {
  parent_thread_id: unknown;
  spawn_status: unknown;
};

type ParentThreadRow = ThreadRow & {
  child_thread_id: unknown;
  spawn_status: unknown;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];
}

export function getThread(id: string): CodexThreadRecord | null {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as ThreadRow | undefined;
      return row ? mapThreadRow(row) : null;
    }) ?? null
  );
}

export function getThreadByPrefix(idPrefix: string): CodexThreadRecord | null {
  const normalized = idPrefix.trim();
  if (!normalized) {
    return null;
  }

  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, created_at, updated_at, first_user_message
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND id LIKE ?
        ORDER BY updated_at DESC
        LIMIT 2
      `);

      const rows = query.all(`${normalized}%`) as ThreadRow[];
      return rows.length === 1 ? mapThreadRow(rows[0]!) : null;
    }) ?? null
  );
}

export function listChildThreads(parentThreadId: string): CodexChildThreadRecord[] {
  const normalized = parentThreadId.trim();
  if (!normalized) {
    return [];
  }

  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT e.parent_thread_id, e.status AS spawn_status,
               t.id, t.title, t.cwd, t.model, t.created_at, t.updated_at, t.first_user_message
        FROM thread_spawn_edges e
        JOIN threads t ON t.id = e.child_thread_id
        WHERE e.parent_thread_id = ? AND (t.archived = 0 OR t.archived IS NULL)
        ORDER BY t.created_at DESC
      `);

      const rows = query.all(normalized) as ChildThreadRow[];
      return rows.map((row) => ({
        ...mapThreadRow(row),
        parentThreadId: typeof row.parent_thread_id === "string" ? row.parent_thread_id : String(row.parent_thread_id ?? ""),
        spawnStatus: typeof row.spawn_status === "string" ? row.spawn_status : String(row.spawn_status ?? ""),
      }));
    }) ?? []
  );
}

export function getParentThread(childThreadId: string): CodexParentThreadRecord | null {
  const normalized = childThreadId.trim();
  if (!normalized) {
    return null;
  }

  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT e.child_thread_id, e.status AS spawn_status,
               t.id, t.title, t.cwd, t.model, t.created_at, t.updated_at, t.first_user_message
        FROM thread_spawn_edges e
        JOIN threads t ON t.id = e.parent_thread_id
        WHERE e.child_thread_id = ? AND (t.archived = 0 OR t.archived IS NULL)
        LIMIT 1
      `);

      const row = query.get(normalized) as ParentThreadRow | undefined;
      if (!row) {
        return null;
      }

      return {
        ...mapThreadRow(row),
        childThreadId: typeof row.child_thread_id === "string" ? row.child_thread_id : String(row.child_thread_id ?? ""),
        spawnStatus: typeof row.spawn_status === "string" ? row.spawn_status : String(row.spawn_status ?? ""),
      };
    }) ?? null
  );
}

export function readThreadHistory(threadId: string, limit = 10): CodexHistoryMessage[] {
  const sessionPath = findThreadSessionFile(threadId);
  if (!sessionPath) {
    return [];
  }

  const messages: CodexHistoryMessage[] = [];
  try {
    const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      const message = extractHistoryMessage(parsed);
      if (message) {
        messages.push(message);
      }
    }
  } catch {
    return [];
  }

  return messages.slice(-Math.max(1, limit));
}

export function listWorkspaces(): string[] {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

      const rows = query.all() as WorkspaceRow[];
      return rows
        .map((row) => (typeof row.cwd === "string" ? row.cwd : ""))
        .filter(Boolean);
    }) ?? []
  );
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    model: typeof row.model === "string" ? row.model : null,
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): T | null {
  if (!BetterSqlite3) {
    return null;
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getCodexDir(): string | null {
  const home = process.env.HOME?.trim();
  return home ? path.join(home, ".codex") : null;
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}

function findThreadSessionFile(threadId: string): string | null {
  const codexDir = getCodexDir();
  if (!codexDir) {
    return null;
  }

  const sessionsDir = path.join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) {
    return null;
  }

  try {
    const files = walkFiles(sessionsDir)
      .filter((file) => file.endsWith(".jsonl") && path.basename(file).includes(threadId))
      .map((file) => ({ file, modifiedAtMs: statSync(file).mtimeMs }))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    return files[0]?.file ?? null;
  } catch {
    return null;
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractHistoryMessage(entry: {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}): CodexHistoryMessage | null {
  if (entry.type !== "response_item" || !entry.payload || typeof entry.payload !== "object") {
    return null;
  }

  const payload = entry.payload as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
  };
  if (payload.type !== "message") {
    return null;
  }
  if (payload.role !== "user" && payload.role !== "assistant") {
    return null;
  }

  const text = extractContentText(payload.content).trim();
  if (!text) {
    return null;
  }

  return {
    role: payload.role,
    text,
    timestamp: typeof entry.timestamp === "string" ? new Date(entry.timestamp) : undefined,
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { text?: unknown; input_text?: unknown };
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.input_text === "string") {
        return record.input_text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}
