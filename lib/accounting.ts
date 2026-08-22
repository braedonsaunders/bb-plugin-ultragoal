import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalStore, StoredGoal } from "./store.js";

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function tokenUsageFromUnknown(value: unknown, depth = 0): number | null {
  if (value == null || depth > 6) return null;
  if (typeof value === "number") return numberFrom(value);
  if (typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const direct =
    numberFrom(rec.totalTokens) ??
    numberFrom(rec.tokensUsed) ??
    numberFrom(rec.usedTokens) ??
    numberFrom(rec.tokens);
  if (direct != null && direct > 0) return direct;
  for (const key of ["total", "tokenUsage", "usage", "data", "payload", "last"] as const) {
    const nested = tokenUsageFromUnknown(rec[key], depth + 1);
    if (nested != null && nested > 0) return nested;
  }
  return null;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).join("");
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return textFromUnknown(rec.text ?? rec.content ?? rec.summary ?? "");
  }
  return "";
}

const estimateCache = new Map<string, { seq: number; tokens: number }>();

async function listEvents(
  bb: BbPluginApi,
  args: {
    threadId: string;
    types?: readonly [string, ...string[]];
    order?: "asc" | "desc";
    limit?: string;
    afterSeq?: string;
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

async function readOfficialTokens(bb: BbPluginApi, threadId: string): Promise<number | null> {
  const usageEvents = await listEvents(bb, {
    threadId,
    types: ["thread/tokenUsage/updated"],
    order: "desc",
    limit: "16",
  });
  for (const event of usageEvents) {
    const total = tokenUsageFromUnknown(event);
    if (total != null && total > 0) return total;
  }

  try {
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      summaryOnly: "true",
    });
    const total =
      numberFrom((timeline as { tokensUsed?: unknown }).tokensUsed) ??
      tokenUsageFromUnknown(timeline);
    if (total != null && total > 0) return total;
  } catch {
    // Timeline tokens are best-effort.
  }

  const windowEvents = await listEvents(bb, {
    threadId,
    types: ["thread/contextWindowUsage/updated"],
    order: "desc",
    limit: "8",
  });
  for (const event of windowEvents) {
    const used = tokenUsageFromUnknown(event);
    if (used != null && used > 0) return used;
  }

  try {
    const thread = await bb.sdk.threads.get({ threadId });
    const total = tokenUsageFromUnknown(thread);
    if (total != null && total > 0) return total;
  } catch {
    // Thread DTO often omits usage for Cursor.
  }

  return null;
}

function tokensFromCompletedItem(event: Record<string, unknown>): number {
  const type = String(event.type ?? "");
  if (type !== "item/completed") return 0;
  const data = (event.data ?? event) as Record<string, unknown>;
  const item = (data.item ?? data) as Record<string, unknown>;
  const itemType = String(item.type ?? "");
  if (
    itemType !== "reasoning" &&
    itemType !== "agentMessage" &&
    itemType !== "toolCall" &&
    itemType !== "commandExecution"
  ) {
    return 0;
  }
  const text = textFromUnknown(item.content ?? item.text ?? item.summary ?? item.command ?? "");
  if (itemType === "toolCall" || itemType === "commandExecution") return text ? Math.max(40, Math.ceil(text.length / 8)) : 80;
  return Math.max(1, Math.ceil(text.length / 4));
}

async function estimateTokens(bb: BbPluginApi, threadId: string): Promise<number | null> {
  const prior = estimateCache.get(threadId) ?? { seq: 0, tokens: 0 };
  let after = prior.seq;
  let tokens = prior.tokens;
  for (let page = 0; page < 40; page += 1) {
    const batch = await listEvents(bb, {
      threadId,
      types: ["item/completed"],
      order: "asc",
      limit: "200",
      afterSeq: after > 0 ? String(after) : undefined,
    });
    if (batch.length === 0) break;
    for (const event of batch) {
      const seq = numberFrom(event.seq) ?? after;
      tokens += tokensFromCompletedItem(event);
      after = Math.max(after, seq);
    }
    if (batch.length < 200) break;
  }
  estimateCache.set(threadId, { seq: after, tokens });
  return tokens > 0 ? tokens : null;
}

export async function readThreadTokens(
  bb: BbPluginApi,
  threadId: string,
): Promise<number | null> {
  return (await readOfficialTokens(bb, threadId)) ?? (await estimateTokens(bb, threadId));
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
  options?: { evenIfIdle?: boolean },
): Promise<StoredGoal | null> {
  const existing = store.get(threadId);
  if (!existing) return null;
  if (existing.status !== "active" && existing.status !== "budget_limited") {
    return existing;
  }

  const running = await threadIsRunning(bb, threadId);
  const currentTokens = await readThreadTokens(bb, threadId);
  let tokensUsed = existing.tokensUsed;
  let lastSeenTokens = existing.lastSeenTokens;
  if (currentTokens != null) {
    if (lastSeenTokens == null) {
      tokensUsed = Math.max(tokensUsed, currentTokens);
    } else {
      tokensUsed += Math.max(0, currentTokens - lastSeenTokens);
    }
    lastSeenTokens = currentTokens;
  }

  const now = Date.now();
  let timeUsedSeconds = existing.timeUsedSeconds;
  let lastAccountedAt = existing.lastAccountedAt;
  if (running || options?.evenIfIdle) {
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
