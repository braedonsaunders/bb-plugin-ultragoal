import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalStore, StoredGoal } from "./store.js";
import {
  peekCursorSessionTokens,
  providerSessionId,
  readCursorSessionTokens,
} from "./cursor-tokens.js";
import { readProviderSessionTokens } from "./provider-tokens.js";

const NEW_SESSION_SCANS_PER_TICK = 8;

/**
 * Durable per-session token totals.
 *
 * A goal's usage is the sum across every provider session it ever ran, and
 * "one agent = one slice" means sessions retire constantly — a long run
 * accumulates hundreds of them against a handful live at any moment. Holding
 * the per-session map only in memory meant a plugin reload could rebuild it
 * from the live handful alone, whose sum never again exceeded the historical
 * high-water mark the total was floored to. The counter froze permanently.
 *
 * Storing each session's own total fixes that: a retired session keeps
 * contributing exactly what it spent, and a new one contributes its own growth.
 */
export function createSessionTokenStore(db: ReturnType<BbPluginApi["storage"]["database"]>) {
  // Created here rather than trusting the shared migration list alone.
  // bb.storage.migrate records progress by array index, and on this database it
  // did not apply the appended statement on reload — accounting then threw
  // "no such table" on every pulse. Owning the table where it is used makes the
  // store self-healing and independent of that ordering scheme.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_session_tokens (
      goal_thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (goal_thread_id, session_id)
    )
  `);
  const record = db.prepare(`
    INSERT INTO goal_session_tokens (goal_thread_id, session_id, tokens, updated_at)
    VALUES (@goal_thread_id, @session_id, @tokens, @updated_at)
    ON CONFLICT(goal_thread_id, session_id) DO UPDATE SET
      -- A provider's cumulative counter only rises; a lower reading is a
      -- partial or restarted report, never a refund.
      tokens = MAX(goal_session_tokens.tokens, excluded.tokens),
      updated_at = excluded.updated_at
  `);
  const totalFor = db.prepare(
    "SELECT COALESCE(SUM(tokens), 0) AS total FROM goal_session_tokens WHERE goal_thread_id = ?",
  );
  const recorded = db.prepare(
    "SELECT session_id FROM goal_session_tokens WHERE goal_thread_id = ?",
  );
  return {
    record(goalThreadId: string, sessionId: string, tokens: number): void {
      record.run({
        goal_thread_id: goalThreadId,
        session_id: sessionId,
        tokens,
        updated_at: Date.now(),
      });
    },
    total(goalThreadId: string): number {
      return (totalFor.get(goalThreadId) as { total: number }).total;
    },
    recordedSessions(goalThreadId: string): Set<string> {
      return new Set(
        (recorded.all(goalThreadId) as Array<{ session_id: string }>).map((row) => row.session_id),
      );
    },
  };
}

export type SessionTokenStore = ReturnType<typeof createSessionTokenStore>;

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function tokenUsageFromUnknown(value: unknown, depth = 0): number | null {
  if (value == null || depth > 6) return null;
  if (typeof value === "number") return numberFrom(value);
  if (typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const nestedTotal = rec.total && typeof rec.total === "object" ? (rec.total as Record<string, unknown>) : null;
  const direct =
    numberFrom(nestedTotal?.totalTokens) ??
    numberFrom(rec.totalTokens) ??
    numberFrom(rec.tokensUsed) ??
    numberFrom(rec.usedTokens) ??
    numberFrom(rec.used) ??
    numberFrom(rec.tokens);
  if (direct != null && direct > 0) return direct;
  for (const key of ["tokenUsage", "usage", "data", "payload", "last"] as const) {
    const nested = tokenUsageFromUnknown(rec[key], depth + 1);
    if (nested != null && nested > 0) return nested;
  }
  return null;
}

async function listEvents(
  bb: BbPluginApi,
  args: {
    threadId: string;
    types?: readonly [string, ...string[]];
    order?: "asc" | "desc";
    limit?: string;
  },
): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await bb.sdk.threads.events.list(args as never);
    if (Array.isArray(result)) return result as unknown as Array<Record<string, unknown>>;
    const wrapped = result as { events?: unknown[]; items?: unknown[] };
    return (wrapped.events ?? wrapped.items ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

const sessionByThread = new Map<string, string>();

export async function sessionIdForThread(bb: BbPluginApi, threadId: string): Promise<string | null> {
  const cached = sessionByThread.get(threadId);
  if (cached) return cached;
  const id = await providerSessionId(async () =>
    listEvents(bb, {
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "4",
    }),
  );
  if (id) sessionByThread.set(threadId, id);
  return id;
}

async function officialTokensIfCheap(bb: BbPluginApi, threadId: string): Promise<number | null> {
  const usageEvents = await listEvents(bb, {
    threadId,
    types: ["thread/tokenUsage/updated"],
    order: "desc",
    limit: "4",
  });
  for (const event of usageEvents) {
    const total =
      tokenUsageFromUnknown((event as { tokenUsage?: unknown }).tokenUsage) ??
      tokenUsageFromUnknown(event);
    if (total != null && total > 0) return total;
  }
  // Last resort for providers with no local session store: the context-window
  // snapshot bb relays. It's the live window, not cumulative usage, so it
  // undercounts — but it moves, and it beats a frozen zero.
  const windowEvents = await listEvents(bb, {
    threadId,
    types: ["thread/contextWindowUsage/updated"],
    order: "desc",
    limit: "4",
  });
  for (const event of windowEvents) {
    const data = (event.data ?? event) as Record<string, unknown>;
    const usage = data.contextWindowUsage as Record<string, unknown> | undefined;
    const used = numberFrom(usage?.usedTokens);
    if (used != null && used > 0) return used;
  }
  return null;
}

export async function readThreadTokens(
  bb: BbPluginApi,
  threadId: string,
  options?: { allowScan?: boolean; allowLocalProviderData?: boolean },
): Promise<number | null> {
  const sessionId = await sessionIdForThread(bb, threadId);
  if (
    sessionId &&
    options?.allowLocalProviderData === true &&
    options?.allowScan === false
  ) {
    return peekCursorSessionTokens(sessionId);
  }
  if (sessionId && options?.allowLocalProviderData === true) {
    // Whichever provider ran this session (Cursor, OpenCode, Claude Code,
    // Codex) left cumulative usage in its own store; try them all.
    const stored = readCursorSessionTokens(sessionId) ?? readProviderSessionTokens(sessionId);
    if (stored != null) return stored;
  }
  if (options?.allowScan === false) return null;
  return officialTokensIfCheap(bb, threadId);
}

export async function threadIsRunning(
  bb: BbPluginApi,
  threadId: string,
): Promise<boolean> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.status === "active" || thread.status === "starting";
  } catch {
    return false;
  }
}

export async function accountGoalProgress(
  bb: BbPluginApi,
  store: GoalStore,
  threadId: string,
  options?: {
    evenIfIdle?: boolean;
    busy?: boolean;
    /** Threads still running, re-read every tick. */
    extraThreadIds?: string[];
    /** Every thread the goal ever ran, retired included; backfilled a few per
     * tick and never re-read once recorded. */
    historicalThreadIds?: string[];
    force?: boolean;
    scan?: boolean;
    /** Explicit consent to read provider-owned local session files/databases. */
    allowLocalProviderData?: boolean;
    sessionTokens?: SessionTokenStore;
  },
): Promise<StoredGoal | null> {
  const existing = store.get(threadId);
  if (!existing) return null;
  if (
    !options?.force &&
    existing.status !== "active" &&
    existing.status !== "budget_limited"
  ) {
    return existing;
  }

  const running = options?.busy === true ? true : await threadIsRunning(bb, threadId);
  const extras = [...new Set((options?.extraThreadIds ?? []).filter((id) => id && id !== threadId))];
  const ids = [threadId, ...extras];
  const sessions = options?.sessionTokens ?? createSessionTokenStore(bb.storage.database());
  const recorded = sessions.recordedSessions(threadId);
  let sawTokens = recorded.size > 0;

  // Live threads are re-read every tick because their totals are still moving.
  for (const id of ids) {
    const sessionId = await sessionIdForThread(bb, id);
    if (!sessionId) continue;
    const tokens = await readThreadTokens(bb, id, {
      allowScan: true,
      allowLocalProviderData: options?.allowLocalProviderData === true,
    });
    if (tokens == null) continue;
    sessions.record(threadId, sessionId, tokens);
    sawTokens = true;
  }

  // Retired threads are read once and then never again: their totals are final,
  // and a long goal accumulates hundreds of them. Backfilling a bounded few per
  // tick converges without turning every tick into hundreds of reads.
  if (options?.scan === true) {
    const live = new Set(ids);
    const historical = (options.historicalThreadIds ?? []).filter((id) => id && !live.has(id));
    let scansLeft = NEW_SESSION_SCANS_PER_TICK;
    for (const id of historical) {
      if (scansLeft <= 0) break;
      const sessionId = await sessionIdForThread(bb, id);
      if (!sessionId || recorded.has(sessionId)) continue;
      scansLeft -= 1;
      const tokens = await readThreadTokens(bb, id, {
        allowScan: true,
        allowLocalProviderData: options?.allowLocalProviderData === true,
      });
      if (tokens == null) continue;
      sessions.record(threadId, sessionId, tokens);
      recorded.add(sessionId);
      sawTokens = true;
    }
  }

  const currentTokens = sessions.total(threadId);

  let tokensUsed = existing.tokensUsed;
  let lastSeenTokens = existing.lastSeenTokens;
  if (sawTokens) {
    // The floor still guards goals that predate this table, whose historical
    // total was recorded before any per-session rows existed. Once the durable
    // sum overtakes it the floor stops binding, and the counter moves again.
    tokensUsed = Math.max(existing.tokensUsed, currentTokens);
    lastSeenTokens = Math.max(existing.lastSeenTokens ?? 0, currentTokens);
  }

  const now = Date.now();
  let timeUsedSeconds = existing.timeUsedSeconds;
  let lastAccountedAt = existing.lastAccountedAt;
  if (running || options?.evenIfIdle || options?.busy) {
    const lastAt = existing.lastAccountedAt ?? existing.startedAt;
    timeUsedSeconds =
      existing.timeUsedSeconds + Math.max(0, Math.round((now - lastAt) / 1000));
    lastAccountedAt = now;
  }

  if (
    tokensUsed === existing.tokensUsed &&
    lastSeenTokens === existing.lastSeenTokens &&
    timeUsedSeconds === existing.timeUsedSeconds
  ) {
    return existing;
  }

  return store.update(threadId, {
    tokensUsed,
    timeUsedSeconds,
    lastSeenTokens,
    lastAccountedAt,
  });
}
