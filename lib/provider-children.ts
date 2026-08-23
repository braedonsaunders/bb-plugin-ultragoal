import { homedir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "./cursor-tokens.js";

// Native subagent lifecycle straight from the provider's own store. OpenCode
// runs task-tool subagents as child sessions of the parent session and records
// them (with real titles) in opencode.db the moment they start — even when bb
// never materializes a thread for them. bb's tool-call events only reveal a
// task's title after it completes, so this is the one live source of names
// for running native subagents.

export interface NativeChildSession {
  id: string;
  title: string;
  createdAt: number;
}

export function listOpenCodeChildren(parentSessionId: string): NativeChildSession[] {
  const id = parentSessionId.trim();
  if (!id) return [];
  const db = openSqlite(join(homedir(), ".local/share/opencode/opencode.db"));
  if (!db) return [];
  try {
    const rows = db.all<{ id: string; title: string; time_created: number }>(
      "SELECT id, title, time_created FROM session WHERE parent_id = ? ORDER BY time_created",
      id,
    );
    return rows
      .map((row) => ({
        id: row.id,
        // Titles carry an agent-type suffix like "(@explore subagent)".
        title: (row.title ?? "").replace(/\s*\(@[^)]*\)\s*$/, "").trim(),
        createdAt: typeof row.time_created === "number" ? row.time_created : 0,
      }))
      .filter((row) => row.title.length > 0);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
