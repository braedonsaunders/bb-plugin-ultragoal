import { createRequire } from "node:module";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_WINDOW = 200_000;
const sessionCache = new Map<string, { stamp: string; tokens: number }>();

type SqliteDb = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
};

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Approximate o200k/cl100k without shipping a BPE table. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let latin = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x2e80) {
      if (latin) {
        tokens += Math.ceil(latin / 3.6);
        latin = 0;
      }
      tokens += 1;
    } else {
      latin += 1;
    }
  }
  if (latin) tokens += Math.ceil(latin / 3.6);
  return tokens;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return textOf(rec.text ?? rec.result ?? rec.content ?? rec.summary ?? "");
  }
  return "";
}

function openSqlite(file: string): SqliteDb | null {
  if (!existsSync(file)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      all<T>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).all(...params) as T[];
      },
      close() {
        db.close();
      },
    };
  } catch {
    try {
      const Database = require("better-sqlite3") as {
        new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): {
          prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
          close(): void;
        };
      };
      const db = new Database(file, { readonly: true, fileMustExist: true });
      return {
        all<T>(sql: string, ...params: unknown[]) {
          return db.prepare(sql).all(...params) as T[];
        },
        close() {
          db.close();
        },
      };
    } catch {
      return null;
    }
  }
}

function cursorSupportDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library/Application Support/Cursor");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData/Roaming"), "Cursor");
  }
  return join(homedir(), ".config/Cursor");
}

function stateDbPath(): string {
  return join(cursorSupportDir(), "User/globalStorage/state.vscdb");
}

function acpStorePaths(sessionId: string): string[] {
  const paths = [join(homedir(), ".cursor/acp-sessions", sessionId, "store.db")];
  const chats = join(homedir(), ".cursor/chats");
  if (!existsSync(chats)) return paths;
  try {
    for (const entry of readdirSync(chats, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.push(join(chats, entry.name, sessionId, "store.db"));
    }
  } catch {
    // Directory listing is best-effort.
  }
  return paths;
}

/**
 * cursortrack method on IDE composer bubbles:
 * input = contextWindowStatusAtCreation.tokensUsed per user request
 * output = positive window delta between consecutive requests
 */
function readComposerTokens(sessionId: string): number | null {
  const db = openSqlite(stateDbPath());
  if (!db) return null;
  try {
    const rows = db.all<{ value: string | Buffer }>(
      "SELECT value FROM cursorDiskKV WHERE key LIKE ?",
      `bubbleId:${sessionId}:%`,
    );
    const requests: Array<{ tokens: number; userChars: number; ts: string }> = [];
    for (const row of rows) {
      const raw = typeof row.value === "string" ? row.value : row.value?.toString("utf8");
      if (!raw) continue;
      let blob: Record<string, unknown>;
      try {
        blob = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (blob.type !== 1) continue;
      const cws = blob.contextWindowStatusAtCreation;
      if (!cws || typeof cws !== "object") continue;
      const tokens = numberFrom((cws as { tokensUsed?: unknown }).tokensUsed);
      if (tokens == null || tokens <= 0) continue;
      requests.push({
        tokens,
        userChars: textOf(blob.text).length,
        ts: String(blob.createdAt ?? blob.timestamp ?? ""),
      });
    }
    if (requests.length === 0) return null;
    requests.sort((a, b) => a.ts.localeCompare(b.ts));
    let input = 0;
    let output = 0;
    for (let i = 0; i < requests.length; i += 1) {
      input += requests[i].tokens;
      if (i + 1 >= requests.length) continue;
      const delta = requests[i + 1].tokens - requests[i].tokens;
      if (delta <= 0) continue;
      output += Math.max(0, delta - Math.floor(requests[i + 1].userChars / 4));
    }
    return input + output;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function parseJsonBlob(data: unknown): Record<string, unknown> | null {
  try {
    if (typeof data === "string") {
      return data.startsWith("{") ? (JSON.parse(data) as Record<string, unknown>) : null;
    }
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      if (data.length === 0 || data[0] !== 0x7b) return null;
      return JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function decodeMeta(value: unknown): Record<string, unknown> | null {
  try {
    const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
    if (!text) return null;
    if (text.startsWith("{")) return JSON.parse(text) as Record<string, unknown>;
    if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
      return JSON.parse(Buffer.from(text, "hex").toString("utf8")) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * ACP sessions are not in state.vscdb. Reconstruct cursortrack's per-request
 * accounting from ~/.cursor/acp-sessions/<id>/store.db:
 * each user request bills the current context window (capped), plus assistant output.
 */
function readAcpStoreTokens(sessionId: string): number | null {
  for (const file of acpStorePaths(sessionId)) {
    const db = openSqlite(file);
    if (!db) continue;
    try {
      const metaRows = db.all<{ value: unknown }>("SELECT value FROM meta LIMIT 4");
      let stamp = String(existsSync(`${file}-wal`) ? "wal" : "now");
      for (const row of metaRows) {
        const meta = decodeMeta(row.value);
        if (typeof meta?.latestRootBlobId === "string") {
          stamp = meta.latestRootBlobId;
          break;
        }
      }
      const cached = sessionCache.get(sessionId);
      if (cached && cached.stamp === stamp) return cached.tokens;

      const rows = db.all<{ data: unknown }>("SELECT data FROM blobs WHERE substr(data, 1, 1) = x'7b'");
      let requests = 0;
      let assistant = 0;
      let conversation = 0;
      for (const row of rows) {
        const blob = parseJsonBlob(row.data);
        if (!blob || typeof blob.role !== "string") continue;
        const tokens = estimateTokens(textOf(blob.content));
        conversation += tokens;
        if (blob.role === "assistant") assistant += tokens;
        if (blob.role !== "user") continue;
        const cursor = (blob.providerOptions as { cursor?: Record<string, unknown> } | undefined)?.cursor;
        if (cursor && (cursor.requestId || cursor.requestContextCompleteness)) requests += 1;
      }
      if (requests === 0 && conversation === 0) continue;
      const window = Math.min(DEFAULT_WINDOW, Math.max(conversation, 8_000));
      const tokens = Math.max(1, requests) * window + assistant;
      sessionCache.set(sessionId, { stamp, tokens });
      return tokens;
    } catch {
      // Try the next store path.
    } finally {
      db.close();
    }
  }
  return null;
}

export function peekCursorSessionTokens(sessionId: string): number | null {
  return sessionCache.get(sessionId.trim())?.tokens ?? null;
}

export function readCursorSessionTokens(sessionId: string): number | null {
  const id = sessionId.trim();
  if (!id) return null;
  return peekCursorSessionTokens(id) ?? readComposerTokens(id) ?? readAcpStoreTokens(id);
}

export async function providerSessionId(
  listIdentity: () => Promise<Array<Record<string, unknown>>>,
): Promise<string | null> {
  const events = await listIdentity();
  for (const event of events) {
    const direct = event.providerThreadId;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const data = (event.data ?? event) as Record<string, unknown>;
    const nested = data.providerThreadId;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}
