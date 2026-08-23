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
  /** OpenCode's agent type from the title suffix, e.g. "explore subagent". */
  agentType: string | null;
  createdAt: number;
  /** Newest message/part write in the session. */
  lastActivityAt: number;
  /** The latest assistant message has no completion time: still streaming. */
  generating: boolean;
}

/** A session is live while it streams or wrote anything recently. */
const SESSION_STALE_MS = 3 * 60_000;

export function sessionIsLive(session: NativeChildSession): boolean {
  return session.generating || Date.now() - session.lastActivityAt < SESSION_STALE_MS;
}

export interface NativeTaskCall {
  callId: string;
  /** OpenCode part state: pending | running | completed | error. */
  status: string;
  /** The parent's own one-line description of the task. */
  description: string | null;
  /** Child session id, present once the call completed. */
  childSessionId: string | null;
}

/**
 * Task tool calls in the parent session, keyed by call id — which is exactly
 * bb's toolCall item id, so bb events pair to provider state with no
 * heuristics. The part's status is the authoritative liveness for the call:
 * bb's completion events can carry a rewritten tool name and killed subagents
 * may never emit one at all.
 */
export function getOpenCodeTaskCalls(parentSessionId: string): Map<string, NativeTaskCall> {
  const id = parentSessionId.trim();
  const calls = new Map<string, NativeTaskCall>();
  if (!id) return calls;
  const db = openSqlite(join(homedir(), ".local/share/opencode/opencode.db"));
  if (!db) return calls;
  try {
    const rows = db.all<{
      call_id: string | null;
      status: string | null;
      description: string | null;
      output: string | null;
    }>(
      `SELECT json_extract(data, '$.callID') AS call_id,
              json_extract(data, '$.state.status') AS status,
              json_extract(data, '$.state.input.description') AS description,
              json_extract(data, '$.state.output') AS output
       FROM part
       WHERE session_id = ? AND json_extract(data, '$.tool') = 'task'`,
      id,
    );
    for (const row of rows) {
      if (!row.call_id) continue;
      const session = (row.output ?? "").match(/task_id:\s*(ses_[a-zA-Z0-9]+)/);
      calls.set(row.call_id, {
        callId: row.call_id,
        status: row.status ?? "pending",
        description: row.description?.trim() || null,
        childSessionId: session?.[1] ?? null,
      });
    }
    return calls;
  } catch {
    return calls;
  } finally {
    db.close();
  }
}

export interface NativeTaskResult {
  sessionId: string;
  /** The subagent's final report, as returned to the parent task call. */
  output: string;
  completedAt: number;
}

/** Completed task-call outputs in the parent session, keyed by child session. */
export function listOpenCodeTaskResults(parentSessionId: string): NativeTaskResult[] {
  const id = parentSessionId.trim();
  if (!id) return [];
  const db = openSqlite(join(homedir(), ".local/share/opencode/opencode.db"));
  if (!db) return [];
  try {
    const rows = db.all<{ output: string | null; time_updated: number }>(
      `SELECT json_extract(data, '$.state.output') AS output, time_updated
       FROM part
       WHERE session_id = ?
         AND json_extract(data, '$.tool') = 'task'
         AND json_extract(data, '$.state.status') = 'completed'`,
      id,
    );
    const results: NativeTaskResult[] = [];
    for (const row of rows) {
      const output = row.output ?? "";
      const match = output.match(/task_id:\s*(ses_[a-zA-Z0-9]+)/);
      if (!match) continue;
      const body = output
        .replace(/^task_id:[^\n]*\n*/, "")
        .replace(/<\/?task_result>/g, "")
        .trim();
      results.push({
        sessionId: match[1],
        output: body,
        completedAt: typeof row.time_updated === "number" ? row.time_updated : 0,
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function listOpenCodeChildren(parentSessionId: string): NativeChildSession[] {
  const id = parentSessionId.trim();
  if (!id) return [];
  const db = openSqlite(join(homedir(), ".local/share/opencode/opencode.db"));
  if (!db) return [];
  try {
    const rows = db.all<{
      id: string;
      title: string;
      time_created: number;
      last_activity: number | null;
      generating: number | null;
    }>(
      `SELECT s.id, s.title, s.time_created,
         (SELECT MAX(p.time_updated) FROM part p WHERE p.session_id = s.id) AS last_activity,
         (SELECT json_extract(m.data, '$.time.completed') IS NULL
          FROM message m
          WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
          ORDER BY m.time_created DESC LIMIT 1) AS generating
       FROM session s
       WHERE s.parent_id = ?
       ORDER BY s.time_created`,
      id,
    );
    return rows
      .map((row) => {
        const raw = row.title ?? "";
        const suffix = raw.match(/\(@([^)]+)\)\s*$/);
        const createdAt = typeof row.time_created === "number" ? row.time_created : 0;
        return {
          id: row.id,
          title: raw.replace(/\s*\(@[^)]*\)\s*$/, "").trim(),
          agentType: suffix?.[1]?.trim() || null,
          createdAt,
          lastActivityAt: typeof row.last_activity === "number" ? row.last_activity : createdAt,
          generating: row.generating === 1,
        };
      })
      .filter((row) => row.title.length > 0);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
