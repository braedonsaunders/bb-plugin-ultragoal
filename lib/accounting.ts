import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalStore, StoredGoal } from "./store.js";
import {
  peekCursorSessionTokens,
  providerSessionId,
  readCursorSessionTokens,
} from "./cursor-tokens.js";

const NEW_SESSION_SCANS_PER_TICK = 2;

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
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
    const wrapped = result as { events?: unknown[]; items?: unknown[] };
    return (wrapped.events ?? wrapped.items ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

const sessionByThread = new Map<string, string>();

async function sessionIdForThread(bb: BbPluginApi, threadId: string): Promise<string | null> {
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
  return null;
}

export async function readThreadTokens(
  bb: BbPluginApi,
  threadId: string,
  options?: { allowScan?: boolean },
): Promise<number | null> {
  const sessionId = await sessionIdForThread(bb, threadId);
  const cursor = sessionId
    ? options?.allowScan === false
      ? peekCursorSessionTokens(sessionId)
      : readCursorSessionTokens(sessionId)
    : null;
  if (cursor != null) return cursor;
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
  options?: { evenIfIdle?: boolean; busy?: boolean; extraThreadIds?: string[]; scan?: boolean },
): Promise<StoredGoal | null> {
  const existing = store.get(threadId);
  if (!existing) return null;
  if (existing.status !== "active" && existing.status !== "budget_limited") {
    return existing;
  }

  const running = options?.busy === true ? true : await threadIsRunning(bb, threadId);
  const extras = [...new Set((options?.extraThreadIds ?? []).filter((id) => id && id !== threadId))];
  let currentTokens = 0;
  let sawTokens = false;
  let scansLeft = options?.scan === true ? NEW_SESSION_SCANS_PER_TICK : 0;
  const ids = [threadId, ...(options?.scan === true ? extras : [])];
  for (const id of ids) {
    const sessionId = await sessionIdForThread(bb, id);
    const cached = sessionId ? peekCursorSessionTokens(sessionId) : null;
    if (cached != null) {
      currentTokens += cached;
      sawTokens = true;
      continue;
    }
    const allowScan = options?.scan === true && (id === threadId || scansLeft > 0);
    if (!allowScan) continue;
    if (id !== threadId) scansLeft -= 1;
    const tokens = await readThreadTokens(bb, id, { allowScan: true });
    if (tokens == null) continue;
    currentTokens += tokens;
    sawTokens = true;
  }

  let tokensUsed = existing.tokensUsed;
  let lastSeenTokens = existing.lastSeenTokens;
  if (sawTokens) {
    tokensUsed = Math.max(existing.tokensUsed, currentTokens);
    lastSeenTokens = currentTokens;
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
